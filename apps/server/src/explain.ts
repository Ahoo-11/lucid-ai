// Inbox diagnoses written by a model (Meta's Muse Spark when Baseten is set
// up). For one problem it reads the evidence (the error, what the step tried,
// what the agent decided just before, the task) and writes the root cause and
// a fix the owner can apply.
//
// Only on request (the Inbox's Diagnose button), never by itself: each one's
// tokens and time are saved, so the cost can be measured and the prompt tuned
// before any rule starts them automatically. The rule-based text shows until a
// diagnosis is ready, and when it fails.

import { and, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import type { ChatClient } from "./ee/arena/llm";
import type { AppContext } from "./context";
import { schema } from "./db";
import type { Hint } from "./insights";

const { issueExplanations, runs, steps } = schema;

/** At most this many diagnoses run at once, however fast people click. */
const CONCURRENCY = 2;

export type IssueForDiagnosis = Hint & {
  id: string;
  kind: string;
  toolName: string | null;
  sample: string | null;
  occurrences: number;
  runs: number;
  examples: { runId: string }[];
};

/** What it cost; null where the provider didn't say. */
type Cost = { inputTokens: number | null; outputTokens: number | null; latencyMs: number | null };

export type Diagnosis =
  | { status: "pending" }
  | ({ status: "ready"; title: string; why: string; fix: string; model: string; at: string } & Cost)
  | { status: "failed"; error: string; model: string; at: string };

const SYSTEM = `You are Lucid's failure analyst. Lucid watches AI agents (Claude Code, Hermes Agent, LangGraph apps and others) and groups their failed steps by cause. For one group, explain the root cause and the fix to the agent's owner, who may not be technical.

Rules:
- Base everything on the evidence given. Where it isn't certain, say what is most likely.
- title: what went wrong, at most 10 words, no trailing period.
- why: one or two plain sentences on the root cause and what it costs (retries, wasted model calls, a stopped run).
- fix: one to three sentences with one concrete change the owner can make today: a line to add to the agent's instructions (quote it), a setting, or a command. Prefer changing the agent's behaviour over "try again".

Reply with JSON only: {"title": "...", "why": "...", "fix": "..."}`;

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
    const result = { title: field("title", 120).replace(/\.$/, ""), why: field("why", 700), fix: field("fix", 900) };
    return result.title && result.why && result.fix ? result : null;
  } catch {
    return null;
  }
}

export function createExplainer(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const queue: { projectId: string; issue: IssueForDiagnosis }[] = [];
  const queued = new Set<string>();
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

  async function diagnose(projectId: string, issue: IssueForDiagnosis, chat: ChatClient, model: string) {
    let row: typeof issueExplanations.$inferInsert;
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
          { role: "user", content: await evidence(projectId, issue) },
        ],
      });
      const cost = { inputTokens: result.inputTokens ?? null, outputTokens: result.outputTokens ?? null, latencyMs: result.latencyMs };
      const parsed = parseDiagnosis(result.text);
      row = parsed
        ? { projectId, issueId: issue.id, model, status: "ready", ...parsed, error: null, ...cost }
        : // Paid for but unusable: the cost still counts.
          { projectId, issueId: issue.id, model, status: "failed", error: `Unreadable reply: ${clip(result.text, 200) || "(empty)"}`, ...cost };
    } catch (error) {
      ctx.log.warn(`[inbox] diagnosis with ${model} failed: ${(error as Error).message.slice(0, 300)}`);
      row = { projectId, issueId: issue.id, model, status: "failed", error: (error as Error).message.slice(0, 500), inputTokens: null, outputTokens: null, latencyMs: null };
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
      const { projectId, issue } = queue.shift()!;
      active++;
      void diagnose(projectId, issue, chat, model)
        .catch((error) => ctx.log.error("[inbox] diagnosis", error))
        .finally(() => {
          active--;
          queued.delete(`${projectId}\u0000${issue.id}`);
          pump();
        });
    }
  }

  return {
    /** Whether diagnoses are on: a model key and a model to use (Baseten sets both). */
    enabled: !!ctx.chat && !!model,

    /** Diagnoses already asked for: saved ones, and ones still running. Never starts one. */
    async diagnoses(projectId: string, issues: IssueForDiagnosis[]) {
      const out = new Map<string, Diagnosis>();
      if (!issues.length) return out;
      const rows = await ctx.db
        .select()
        .from(issueExplanations)
        .where(and(eq(issueExplanations.projectId, projectId), inArray(issueExplanations.issueId, issues.map((i) => i.id))));
      const saved = new Map(rows.map((row) => [row.issueId, row]));
      for (const issue of issues) {
        if (queued.has(`${projectId}\u0000${issue.id}`)) {
          out.set(issue.id, { status: "pending" });
          continue;
        }
        const row = saved.get(issue.id);
        const at = row?.createdAt.toISOString() ?? "";
        if (row?.status === "ready" && row.title && row.why && row.fix) {
          out.set(issue.id, { status: "ready", title: row.title, why: row.why, fix: row.fix, model: row.model, at, inputTokens: row.inputTokens, outputTokens: row.outputTokens, latencyMs: row.latencyMs });
        } else if (row?.status === "failed") {
          out.set(issue.id, { status: "failed", error: row.error ?? "Unknown error", model: row.model, at });
        }
      }
      return out;
    },

    /** Diagnoses one problem in the background (or again, replacing the saved one). */
    request(projectId: string, issue: IssueForDiagnosis): Diagnosis {
      const key = `${projectId}\u0000${issue.id}`;
      // A second click while it runs doesn't pay twice.
      if (!queued.has(key)) {
        queued.add(key);
        queue.push({ projectId, issue });
        pump();
      }
      return { status: "pending" };
    },
  };
}
