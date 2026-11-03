// One Inbox entry per root cause. A broken tool fails in several ways, and
// makes the agent give up or answer wrong in every task that needs it; listed
// one by one, fixing it would look like it fixed one problem and left the
// rest. So problems are joined into one entry when:
//   - the same specific error words show up in several tools;
//   - a rule says the words don't matter (a quota, a refused key, the model
//     API unreachable, one tool timing out): see causeKey;
//   - a loop, give-up or wrong answer came after a failed step in its run:
//     the failure caused it;
//   - the model, reading the open problems side by side, says they share one
//     cause (issue_groups), within LINKS_PER_DAY and only with auto-diagnose on.
// The owner can split one out; it then stands alone for good. An entry keeps
// the id of its main problem (ranked by the caller: the one with a fix, then a
// diagnosis), so diagnoses, fix tests and lessons stay with it as others join.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "./context";
import { schema } from "./db";
import { causeKey, prettyTool, sharesWords } from "./insights";

const { issueGroups } = schema;

/** Model passes an account gets in any 24 hours, and the least time between two. */
export const LINKS_PER_DAY = 24;
const LINK_EVERY_MS = 10 * 60_000;
/** Problems one pass reads: the ones never compared first, then the biggest. */
const LINK_NEW = 80;
const LINK_MAX = 120;
const DAY = 24 * 3_600_000;

export type Symptom = {
  id: string;
  problem: string;
  toolName: string | null;
  signature: string;
  sample: string | null;
  harness: string;
  /** For a loop, give-up or wrong answer: the failed step's problem it came after. */
  cause?: string | null;
};

/** How a problem got into its entry: it is the main one, the same words, a rule, the run it followed, or the model. */
export type Via = "root" | "words" | "rule" | "run" | "model";

export type Grouping = { groupId: string | null; split: boolean };

const wordsKey = (s: Symptom) => (s.problem === "error" && sharesWords(s) ? `${s.harness}\u0000${s.signature}` : null);
const ruleKey = (s: Symptom) => (s.problem === "error" ? causeKey(s) : null);

/** Problems joined by cause, each entry with its main problem first. `better` sorts the main one ahead. */
export function groupByCause<T extends Symptom>(symptoms: T[], groups: Map<string, Grouping>, better: (a: T, b: T) => number) {
  const parent = symptoms.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const alone = (s: T) => groups.get(s.id)?.split === true;
  const index = new Map(symptoms.map((s, i) => [s.id, i]));
  const seen = new Map<string, number>();
  const join = (key: string | null, i: number) => {
    if (!key) return;
    const other = seen.get(key);
    if (other === undefined) seen.set(key, i);
    else parent[find(i)] = find(other);
  };
  symptoms.forEach((s, i) => {
    if (alone(s)) return;
    // What came after a failure goes where the failure goes, split out or not.
    const cause = s.cause ? index.get(s.cause) : undefined;
    if (cause !== undefined) {
      parent[find(i)] = find(cause);
      return;
    }
    join(wordsKey(s) && `words\u0000${wordsKey(s)}`, i);
    join(ruleKey(s) && `rule\u0000${ruleKey(s)}`, i);
    const group = groups.get(s.id)?.groupId;
    join(group ? `model\u0000${group}` : null, i);
  });

  const entries = new Map<number, T[]>();
  symptoms.forEach((s, i) => entries.set(find(i), [...(entries.get(find(i)) ?? []), s]));
  return [...entries.values()].map((members) => {
    const sorted = [...members].sort(better);
    const ids = new Set(members.map((m) => m.id));
    const shared = (key: (s: T) => string | null, s: T) => !!key(s) && members.some((m) => m !== s && key(m) === key(s));
    const via = (s: T): Via =>
      s === sorted[0]
        ? "root"
        : (s.cause && ids.has(s.cause)) || sorted[0]!.cause === s.id
          ? "run"
          : shared(wordsKey, s)
            ? "words"
            : shared(ruleKey, s)
              ? "rule"
              : "model";
    return { main: sorted[0]!, members: sorted.map((symptom) => ({ symptom, via: via(symptom) })) };
  });
}

/** One entry as the model reads it, and the problems it stands for. */
export type LinkItem = { harness: string; ids: string[]; title: string; toolName: string | null; sample: string | null; runs: number; runId: string | null };

const LINK = `You sort an AI agent's problems by root cause for its owner. Lucid lists the open problems below, one per line, each with the agent it happened in. Find problems that share ONE root cause: one thing that, once fixed, stops all of them (a broken or missing tool, a setting, an outage, something the agent keeps assuming).

Rules:
- Only group problems you are confident share the cause. Similar words or the same tool are not enough: "file not found" for two different files, or two different commands failing, are different causes.
- Problems in different agents never share a cause.
- Leave out every problem that stands alone. Most do.

Reply with JSON only: {"groups": [[3, 7], [1, 4, 9]]}`;

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function json(text: string | undefined) {
  const match = text ? /\{[\s\S]*\}/.exec(text)?.[0] : undefined;
  if (!match) return null;
  try {
    return JSON.parse(match) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createLinker(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const enabled = !!ctx.chat && !!model;
  const running = new Set<string>();
  /** When each project's passes started, to space them out and cap them a day. */
  const started = new Map<string, number[]>();

  async function link(projectId: string, items: LinkItem[]) {
    const lines = items.map((item, i) => {
      const where = item.toolName ? `tool ${prettyTool(item.toolName)}` : "no tool";
      return `#${i + 1} [${item.harness}] ${item.title} | ${where} | ${item.runs} ${item.runs === 1 ? "run" : "runs"} | ${clip(item.sample, 200) || "(no message)"}`;
    });
    const result = await ctx.chat!({
      model: model!,
      json: true,
      reasoningEffort: "low",
      maxTokens: 6_000,
      temperature: 0,
      messages: [
        { role: "system", content: LINK },
        { role: "user", content: lines.join("\n") },
      ],
    });
    const groups = json(result.text)?.groups;
    const ids = items.flatMap((item) => item.ids);
    const rows = await ctx.db
      .select({ issueId: issueGroups.issueId, groupId: issueGroups.groupId })
      .from(issueGroups)
      .where(and(eq(issueGroups.projectId, projectId), inArray(issueGroups.issueId, ids)));
    const current = new Map(rows.map((row) => [row.issueId, row.groupId]));
    for (const group of Array.isArray(groups) ? groups : []) {
      const picked = [...new Set(Array.isArray(group) ? group : [])].map((n) => (Number.isInteger(n) ? items[(n as number) - 1] : undefined)).filter((item) => !!item);
      if (picked.length < 2 || new Set(picked.map((item) => item.harness)).size > 1) continue;
      const members = picked.flatMap((item) => item.ids);
      const existing = [...new Set(members.map((id) => current.get(id)).filter((id): id is string => !!id))];
      const groupId = existing[0] ?? randomUUID();
      // Two groups found to be one: everything in the others moves over.
      for (const other of existing.slice(1)) {
        await ctx.db
          .update(issueGroups)
          .set({ groupId })
          .where(and(eq(issueGroups.projectId, projectId), eq(issueGroups.groupId, other)));
        for (const [id, value] of current) if (value === other) current.set(id, groupId);
      }
      for (const id of members) current.set(id, groupId);
    }
    // Everything read counts as compared, grouped or not.
    await ctx.db
      .insert(issueGroups)
      .values(ids.map((issueId) => ({ projectId, issueId, groupId: current.get(issueId) ?? null })))
      .onConflictDoUpdate({ target: [issueGroups.projectId, issueGroups.issueId], set: { groupId: sql`excluded.group_id` } });
    ctx.log.info(`[inbox] grouped ${items.length} problems by cause (${result.inputTokens ?? "?"} in, ${result.outputTokens ?? "?"} out)`);
  }

  return {
    /** Whether problems can be grouped by the model: a model key and a model. */
    enabled,

    /** The problems never compared, or split out, and whether a pass is running. */
    async grouping(projectId: string) {
      const rows = await ctx.db.select().from(issueGroups).where(eq(issueGroups.projectId, projectId));
      return new Map<string, Grouping>(rows.map((row) => [row.issueId, { groupId: row.groupId, split: row.split }]));
    },

    /** Whether a pass is reading this account's problems now. */
    busy: (projectId: string) => running.has(projectId),

    /**
     * Starts a model pass in the background when an open problem was never
     * compared with the others, at most every LINK_EVERY_MS and LINKS_PER_DAY.
     * True when one started.
     */
    maybe(projectId: string, items: LinkItem[], compared: Set<string>) {
      const fresh = (item: LinkItem) => item.ids.some((id) => !compared.has(id));
      if (!enabled || running.has(projectId) || items.length < 2 || !items.some(fresh)) return false;
      const now = Date.now();
      const times = (started.get(projectId) ?? []).filter((at) => now - at < DAY);
      if (times.length >= LINKS_PER_DAY || now - (times.at(-1) ?? 0) < LINK_EVERY_MS) return false;
      started.set(projectId, [...times, now]);
      running.add(projectId);
      const bigFirst = (a: LinkItem, b: LinkItem) => b.runs - a.runs;
      const picked = items.filter(fresh).sort(bigFirst).slice(0, LINK_NEW);
      picked.push(...items.filter((item) => !fresh(item)).sort(bigFirst).slice(0, LINK_MAX - picked.length));
      void link(projectId, picked)
        // Nothing is marked compared, so it's tried again after LINK_EVERY_MS, within the cap.
        .catch((error) => ctx.log.warn(`[inbox] grouping with ${model} failed: ${(error as Error).message.slice(0, 300)}`))
        .finally(() => {
          running.delete(projectId);
          // Open dashboards refetch, so the Inbox shows the new groups by itself.
          ctx.live.publish({ projectId, runIds: picked.flatMap((item) => (item.runId ? [item.runId] : [])).slice(0, 20) });
        });
      return true;
    },

    /** The owner says this problem has its own cause: it leaves its entry for good. */
    async split(projectId: string, issueId: string) {
      await ctx.db
        .insert(issueGroups)
        .values({ projectId, issueId, groupId: null, split: true })
        .onConflictDoUpdate({ target: [issueGroups.projectId, issueGroups.issueId], set: { groupId: null, split: true } });
    },
  };
}
