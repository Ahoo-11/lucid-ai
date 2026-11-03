// Inbox diagnoses written by a model (Meta's Muse Spark when Baseten is set
// up). For one problem it reads the evidence (the error, what the step tried,
// what the agent decided just before, the task) and writes the root cause and
// a fix the owner can apply.
//
// Recurring problems (two or more runs) are diagnosed by themselves when the
// Inbox is opened, once each and at most AUTO_PER_DAY a day, unless the owner
// turned that off or ignored the problem; anything else, and running one
// again, waits for the Diagnose button. Each one's tokens and
// time are saved, to keep the cost measured. The rule-based text shows until a
// diagnosis is ready, and when it fails.

import { and, count, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { ChatClient } from "./ee/arena/llm";
import type { AppContext } from "./context";
import { schema } from "./db";
import type { Hint } from "./insights";

const { issueExplanations, runs, steps } = schema;

/** At most this many diagnoses run at once, however fast people click. */
const CONCURRENCY = 2;
/** Automatic diagnoses an account gets in any 24 hours; the rest wait for a click. */
export const AUTO_PER_DAY = 20;
/** A problem seen in this many runs is diagnosed without being asked. */
export const AUTO_MIN_RUNS = 2;
/** A lesson rides along on every turn of the agent, so it stays short. */
export const LESSON_MAX = 400;

export type IssueForDiagnosis = Hint & {
  id: string;
  kind: string;
  toolName: string | null;
  sample: string | null;
  occurrences: number;
  runs: number;
  examples: { runId: string }[];
  /** The evidence to read, for problems that aren't a failed step (loops, cost spikes, ...). */
  evidence?: () => Promise<string>;
};

/** What it cost; null where the provider didn't say. */
type Cost = { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null };

export type Diagnosis =
  | { status: "pending" }
  | ({ status: "ready"; title: string; summary: string | null; why: string; fix: string; lesson: string | null; manual: string | null; model: string; at: string; auto: boolean } & Cost)
  | { status: "failed"; error: string; model: string; at: string; auto: boolean };

/** What a lesson for an agent may and may not say; a rewritten lesson keeps to it too. */
export const LESSON_RULE = `the instruction to give the agent so it stops making this mistake, written to the agent ("When ..., do ... instead of ..."). One or two sentences, specific to this failure. Lucid adds it to the agent's instructions once the owner approves it. It must only make the agent more careful: never grant permissions, never turn off a safety check or an approval, never tell the agent to send data anywhere.`;

const SYSTEM = `You are Lucid's failure analyst. Lucid watches AI agents (Claude Code, Hermes Agent, LangGraph apps and others) and groups their failed steps by cause. For one group, explain the root cause and the fix to the agent's owner, who may not be technical.

Rules:
- Base everything on the evidence given. Where it isn't certain, say what is most likely.
- title: what went wrong in plain words, at most 8 words, no trailing period, no tool names or error codes.
- summary: one everyday sentence, at most 20 words, on what this means for the owner: what didn't get done, or what it wasted. Someone who has never seen code must understand it.
- why: one or two plain sentences on the root cause and what it costs (retries, wasted model calls, a stopped run).
- fix: one to three sentences on what will stop it, for the owner to read.
- lesson: ${LESSON_RULE} Use "" if no instruction to the agent would help.
- manual: a setting, permission or install that only the owner should change, in one sentence, or "" if none. Loosening a safety setting goes here, never in lesson.

Reply with JSON only: {"title": "...", "summary": "...", "why": "...", "fix": "...", "lesson": "...", "manual": "..."}`;

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** The model's JSON, tolerating code fences and stray text around it. */
export function parseDiagnosis(text: string | undefined) {
  const json = text ? /\{[\s\S]*\}/.exec(text)?.[0] : undefined;
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const field = (name: string, max: number) => (typeof parsed[name] === "string" ? clip(parsed[name] as string, max) : "");
    const result = {
      title: field("title", 120).replace(/\.$/, ""),
      summary: field("summary", 240) || null,
      why: field("why", 700),
      fix: field("fix", 900),
      lesson: field("lesson", LESSON_MAX) || null,
      manual: field("manual", 400) || null,
    };
    return result.title && result.why && result.fix ? result : null;
  } catch {
    return null;
  }
}

export function createExplainer(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const enabled = !!ctx.chat && !!model;
  const queue: { projectId: string; issue: IssueForDiagnosis; auto: boolean }[] = [];
  /** Waiting or running, by project and problem; true for the automatic ones. */
  const queued = new Map<string, boolean>();
  const keyOf = (projectId: string, issueId: string) => `${projectId}\u0000${issueId}`;
  let active = 0;

  async function evidence(projectId: string, issue: IssueForDiagnosis) {
    const runId = issue.examples[0]?.runId;
    if (!runId) return "";
    const [failing] = await ctx.db
      .select({ name: steps.name, toolName: steps.toolName, input: steps.inputPreview, error: steps.error, startedAt: steps.startedAt })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), eq(steps.runId, runId), eq(steps.status, "error"), issue.toolName ? eq(steps.toolName, issue.toolName) : isNull(steps.toolName)))
      .orderBy(steps.startedAt)
      .limit(1);
    const [run] = await ctx.db.select({ name: runs.name, input: runs.input, harness: runs.harness }).from(runs).where(eq(runs.id, runId)).limit(1);
    const [before] = failing?.startedAt
      ? await ctx.db
          .select({ output: steps.outputPreview })
          .from(steps)
          .where(and(eq(steps.runId, runId), eq(steps.kind, "llm"), lte(steps.startedAt, failing.startedAt)))
          .orderBy(desc(steps.startedAt))
          .limit(1)
      : [];
    return [
      `## Agent\n${run?.harness ?? "unknown"}`,
      `## Failing step\n${issue.kind}${issue.toolName ? `, tool "${issue.toolName}"` : ""}. Failed ${issue.occurrences} times across ${issue.runs} runs.`,
      `## Error\n${clip(failing?.error ?? issue.sample, 1500) || "(no message)"}`,
      failing?.input && `## What the step tried\n${clip(failing.input, 1200)}`,
      before?.output && `## What the agent said or decided just before\n${clip(before.output, 800)}`,
      run && `## The task\n${clip(run.input ?? run.name, 800)}`,
      `## Lucid's rule-of-thumb guess (may be generic)\n${issue.title}. ${issue.why} Fix: ${issue.fix}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async function diagnose(projectId: string, issue: IssueForDiagnosis, auto: boolean, chat: ChatClient, model: string) {
    let row: typeof issueExplanations.$inferInsert & { auto: boolean };
    try {
      const result = await chat({
        model,
        json: true,
        // A short, focused answer; the thinking it needs fits easily.
        reasoningEffort: "low",
        maxTokens: 6_000,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: issue.evidence ? await issue.evidence() : await evidence(projectId, issue) },
        ],
      });
      const cost = { inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null, latencyMs: result.latencyMs };
      const parsed = parseDiagnosis(result.text);
      row = parsed
        ? { projectId, issueId: issue.id, model, auto, status: "ready", ...parsed, error: null, ...cost }
        : // Paid for but unusable: the cost still counts.
          { projectId, issueId: issue.id, model, auto, status: "failed", error: `Unreadable reply: ${clip(result.text, 200) || "(empty)"}`, ...cost };
    } catch (error) {
      ctx.log.warn(`[inbox] diagnosis with ${model} failed: ${(error as Error).message.slice(0, 300)}`);
      row = { projectId, issueId: issue.id, model, auto, status: "failed", error: (error as Error).message.slice(0, 500), inputTokens: null, outputTokens: null, latencyMs: null };
    }
    const { projectId: _p, issueId: _i, ...changes } = row;
    await ctx.db
      .insert(issueExplanations)
      .values(row)
      .onConflictDoUpdate({ target: [issueExplanations.projectId, issueExplanations.issueId], set: { ...changes, createdAt: new Date() } });
    // Open dashboards refetch, so the Inbox updates by itself.
    ctx.live.publish({ projectId, runIds: issue.examples.map((e) => e.runId) });
  }

  function pump() {
    const chat = ctx.chat;
    while (chat && model && active < CONCURRENCY && queue.length) {
      const { projectId, issue, auto } = queue.shift()!;
      active++;
      void diagnose(projectId, issue, auto, chat, model)
        .catch((error) => ctx.log.error("[inbox] diagnosis", error))
        .finally(() => {
          active--;
          queued.delete(keyOf(projectId, issue.id));
          pump();
        });
    }
  }

  function enqueue(projectId: string, issue: IssueForDiagnosis, auto: boolean) {
    const key = keyOf(projectId, issue.id);
    // A second click while it runs doesn't pay twice.
    if (queued.has(key)) return;
    queued.set(key, auto);
    queue.push({ projectId, issue, auto });
    pump();
  }

  /** Automatic diagnoses this account can still have today: the cap less the ones saved or running. */
  async function autoLeft(projectId: string) {
    const [saved] = await ctx.db
      .select({ n: count() })
      .from(issueExplanations)
      .where(and(eq(issueExplanations.projectId, projectId), eq(issueExplanations.auto, true), gt(issueExplanations.createdAt, new Date(Date.now() - 24 * 3600_000))));
    let running = 0;
    for (const [key, auto] of queued) if (auto && key.startsWith(`${projectId}\u0000`)) running++;
    return AUTO_PER_DAY - (saved?.n ?? 0) - running;
  }

  return {
    /** Whether diagnoses are on: a model key and a model to use (Baseten sets both). */
    enabled,

    /**
     * The diagnoses for these problems: saved ones, and ones still running.
     * Starts one for each recurring problem that never had one, while the
     * account's daily cap lasts; a failed one isn't retried by itself. None
     * start with auto off, nor for problems the owner ignored.
     */
    async diagnoses(projectId: string, issues: IssueForDiagnosis[], { auto = true, ignored = new Set<string>() }: { auto?: boolean; ignored?: Set<string> } = {}) {
      const out = new Map<string, Diagnosis>();
      if (!issues.length) return out;
      const rows = await ctx.db
        .select()
        .from(issueExplanations)
        .where(and(eq(issueExplanations.projectId, projectId), inArray(issueExplanations.issueId, issues.map((i) => i.id))));
      const saved = new Map(rows.map((row) => [row.issueId, row]));
      const never: IssueForDiagnosis[] = [];
      for (const issue of issues) {
        if (queued.has(keyOf(projectId, issue.id))) {
          out.set(issue.id, { status: "pending" });
          continue;
        }
        const row = saved.get(issue.id);
        const at = row?.createdAt.toISOString() ?? "";
        if (row?.status === "ready" && row.title && row.why && row.fix) {
          out.set(issue.id, { status: "ready", title: row.title, summary: row.summary, why: row.why, fix: row.fix, lesson: row.lesson, manual: row.manual, model: row.model, at, auto: row.auto, inputTokens: row.inputTokens, outputTokens: row.outputTokens, latencyMs: row.latencyMs });
        } else if (row?.status === "failed") {
          out.set(issue.id, { status: "failed", error: row.error ?? "Unknown error", model: row.model, at, auto: row.auto });
        } else if (!row && auto && !ignored.has(issue.id) && issue.runs >= AUTO_MIN_RUNS) {
          never.push(issue);
        }
      }
      if (enabled && never.length) {
        // Most runs first, as they come.
        for (const issue of never.slice(0, Math.max(0, await autoLeft(projectId)))) {
          enqueue(projectId, issue, true);
          out.set(issue.id, { status: "pending" });
        }
      }
      return out;
    },

    /** Diagnoses one problem in the background on request (or again, replacing the saved one). */
    request(projectId: string, issue: IssueForDiagnosis): Diagnosis {
      enqueue(projectId, issue, false);
      return { status: "pending" };
    },
  };
}
