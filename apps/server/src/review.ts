// Problems no step reports. Once a run is done, Lucid looks at it for four
// things: the agent repeating the same call to no effect (a loop), a cost far
// above that agent's usual, a refusal or give-up it may not have needed, and
// an answer that doesn't match what happened. Loops and cost spikes are clear
// from the data alone. Refusals and wrong answers are only suspected by the
// rules (and a few runs that look fine are spot-checked); the model checks
// each one, within CHECKS_PER_DAY and only with auto-diagnose on, and
// confirms or clears it. Confirmed findings are grouped like failed steps and
// become Inbox problems, with the same diagnosis, fix test and fix tracking;
// one that came after a failed step joins that failure's entry (see roots.ts).

import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { AppContext } from "./context";
import { schema } from "./db";
import type { Hint } from "./insights";

const { runFindings, runs, steps } = schema;

export type Finding = "loop" | "cost" | "refusal" | "wrong_answer";

/** The same call with the same input this many times, to the same effect, is a loop. */
export const LOOP_REPEATS = 3;
/** Model checks of suspected refusals and wrong answers an account gets in any 24 hours. */
export const CHECKS_PER_DAY = 30;
/** A cost spike is this many times the agent's usual run (its median)... */
export const SPIKE_RATIO = 3;
/** ...and at least this much, so cheap agents don't raise alarms over fractions of a cent. */
const SPIKE_FLOOR_USD = 0.01;
const SPIKE_FLOOR_TOKENS = 20_000;
/** What's usual for an agent needs this many runs of it. */
export const BASELINE_RUNS = 10;
/** Share of runs that look fine which the model checks anyway. */
const SPOT_CHECK_SHARE = 0.1;
const SCAN_BATCH = 200;
const SCAN_EVERY_MS = 30_000;
/** A run this quiet is done; one still "running" after an hour is treated as done too. */
const SETTLE_MS = 2 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONCURRENCY = 2;

/** Last words that say the agent refused, or gave up on the task. */
const REFUSAL =
  /\b(?:I(?:'|’)?m sorry,? but|I can(?:'|’)?t|I cannot|I(?:'|’)?m (?:unable|not able)|I am (?:unable|not able)|I won(?:'|’)?t|I(?:'|’)?m not (?:allowed|permitted)|unable to (?:help|assist|complete|access|do)|(?:couldn(?:'|’)?t|could not|was unable to) (?:complete|do|access|open|run|check|finish|find|get))\b/i;

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const money = (usd: number) => `$${usd < 0.1 ? Number(usd.toPrecision(2)) : usd.toFixed(2)}`;
const many = (n: number) => Math.round(n).toLocaleString("en-US");
const times = (n: number) => `${n >= 10 ? Math.round(n) : n.toFixed(1).replace(/\.0$/, "")}×`;

/** What runs of the same task have in common: the request without numbers, dates or extra spaces. */
export const taskKey = (text: string | null) =>
  (text ?? "")
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "(no request)";

/** Plain words for each finding, until the model's diagnosis is ready. */
const HINTS: Record<Finding, (subject: string, evidence: string) => Hint> = {
  loop: (tool) => ({
    title: `Stuck repeating ${tool}`,
    why: `The agent made the same ${tool} call over and over and got the same result each time, spending time and tokens without getting anywhere.`,
    fix: "Tell the agent to change approach, or stop and report, when a call fails or returns the same result twice.",
  }),
  cost: (_, evidence) => ({
    title: "Run cost far more than usual",
    why: evidence,
    fix: "Open the run to see which model calls read the most context; long histories and large tool outputs are the usual cause.",
  }),
  refusal: (_, evidence) => ({
    title: "Gave up on a task it could do",
    why: evidence,
    fix: "Tell the agent what it is allowed to do in this task, and to try another way before giving up.",
  }),
  wrong_answer: (_, evidence) => ({
    title: "Answer doesn't match what happened",
    why: evidence,
    fix: "Tell the agent to base its answer only on what its tools returned, and to say so when a step failed.",
  }),
};

const CHECK = `You review one finished run of an AI agent for its owner, who may not be technical. Lucid suspects one problem in it; decide whether it is real.

- refusal: the agent refused or gave up on something it could and should have done (the request was allowed, a tool for it was available, or one failure didn't make the task impossible). Refusing is right when the request was unsafe, not permitted, or truly impossible with its tools.
- wrong_answer: the final answer is wrong or unsupported: it contradicts what the tools returned, claims success after a failure, reports facts no tool gave, or answers a different question.

Base it only on the evidence. When unsure, the problem is not real.
- problem: true or false.
- reason: one plain sentence for the owner on what happened.
- step: the number of the step where it went wrong, or null.

Reply with JSON only: {"problem": true, "reason": "...", "step": 3}`;

/** The kinds the model checks before they count. */
const isChecked = (kind: string): kind is "refusal" | "wrong_answer" => kind === "refusal" || kind === "wrong_answer";

const QUESTION: Record<"refusal" | "wrong_answer", string> = {
  refusal: "Did the agent refuse or give up on something it could and should have done?",
  wrong_answer: "Is the agent's final answer wrong or unsupported by what its tools returned?",
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

type RunRow = {
  id: string;
  harness: string;
  name: string | null;
  input: string | null;
  output: string | null;
  status: string;
  costUsd: number | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  llmCallCount: number;
  errorCount: number;
};

export type FindingIssue = Hint & {
  id: string;
  problem: Finding;
  kind: string;
  toolName: string | null;
  signature: string;
  sample: string | null;
  harness: string;
  occurrences: number;
  runs: number;
  lastSeen: Date | null;
  firstSeen: Date | null;
  examples: { runId: string; runName: string | null }[];
  /** Every run it happened in, and the newest AFFECTED_MAX of them to list. */
  runIds: string[];
  affected: { runId: string; runName: string | null; at: Date | null }[];
  /** When each one happened, to count the ones after a fix went live. */
  failedAt: number[];
  /** Where it went wrong in each example run, newest first: what a fix test replays. */
  decisions: string[];
  /** The failed step's problem it came after, when it did: the failure caused it. */
  cause: string | null;
};

/** The runs an Inbox problem lists, newest first. */
export const AFFECTED_MAX = 50;

/** Which failed step's problem, if any, a finding in a run came after: by the caller, who knows the failures. */
export type CauseOf = (finding: { runId: string; kind: Finding; subject: string }) => string | null;

/** The same runs are spot-checked every time: picked by their id, not by chance. */
const spotCheck = (runId: string) => Number.parseInt(createHash("sha1").update(runId).digest("hex").slice(0, 8), 16) % 1000 < SPOT_CHECK_SHARE * 1000;

export function createReviewer(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const enabled = !!ctx.chat && !!model;
  const lastScan = new Map<string, number>();
  /** Checks waiting or running, by project, run and kind. */
  const checking = new Set<string>();
  const queue: (() => Promise<void>)[] = [];
  let active = 0;

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const work = queue.shift()!;
      active++;
      void work()
        .catch((error) => ctx.log.error("[review]", error))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  /** What an agent's runs usually cost and read: the median of its last 30 days. */
  async function usual(projectId: string) {
    const rows = await ctx.db
      .select({
        harness: runs.harness,
        priced: count(runs.costUsd),
        all: count(),
        cost: sql<number | null>`percentile_cont(0.5) within group (order by ${runs.costUsd})`,
        tokens: sql<number | null>`percentile_cont(0.5) within group (order by ${runs.inputTokens} + ${runs.cacheReadTokens} + ${runs.cacheWriteTokens})`,
      })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), gte(runs.startedAt, new Date(Date.now() - 30 * DAY)), ne(runs.status, "running")))
      .groupBy(runs.harness);
    return new Map(rows.map((row) => [row.harness, { priced: row.priced, all: row.all, cost: Number(row.cost ?? 0), tokens: Number(row.tokens ?? 0) }]));
  }

  async function look(projectId: string, run: RunRow, typical: Map<string, { priced: number; all: number; cost: number; tokens: number }>) {
    const found: (typeof runFindings.$inferInsert)[] = [];
    const base = { projectId, runId: run.id };
    const task = taskKey(run.name ?? run.input);
    const stepRows = await ctx.db
      .select({
        id: steps.id,
        kind: steps.kind,
        toolName: steps.toolName,
        inputHash: steps.inputHash,
        outputHash: steps.outputHash,
        inputPreview: steps.inputPreview,
        status: steps.status,
        startedAt: steps.startedAt,
        costUsd: steps.costUsd,
        inputTokens: steps.inputTokens,
        cacheReadTokens: steps.cacheReadTokens,
        cacheWriteTokens: steps.cacheWriteTokens,
      })
      .from(steps)
      .where(eq(steps.runId, run.id))
      .orderBy(asc(steps.startedAt), asc(steps.seq));
    const decisions = stepRows.filter((step) => step.kind === "llm");
    /** The model call that led to a step: the last one before it. */
    const decisionBefore = (at: Date | null) => {
      let before = decisions.at(-1)?.id ?? null;
      if (at) for (const step of decisions) if (step.startedAt && step.startedAt <= at) before = step.id;
      return before;
    };

    // A loop: the same call with the same input, failing every time or returning the same thing.
    const calls = new Map<string, typeof stepRows>();
    for (const step of stepRows) {
      if (!step.toolName || !step.inputHash) continue;
      const key = `${step.toolName}\u0000${step.inputHash}`;
      calls.set(key, [...(calls.get(key) ?? []), step]);
    }
    let loop: { calls: typeof stepRows; failed: boolean } | null = null;
    for (const same of calls.values()) {
      if (same.length < LOOP_REPEATS) continue;
      const failed = same.every((step) => step.status === "error");
      const outputs = new Set(same.map((step) => step.outputHash));
      if ((failed || (outputs.size === 1 && !outputs.has(null))) && same.length > (loop?.calls.length ?? 0)) loop = { calls: same, failed };
    }
    if (loop) {
      const tool = loop.calls[0]!.toolName!;
      found.push({
        ...base,
        kind: "loop",
        status: "confirmed",
        subject: tool,
        evidence: `It called ${tool} ${loop.calls.length} times with the same input and ${loop.failed ? "it failed every time" : "got the same result every time"}: ${clip(loop.calls[0]!.inputPreview, 160) || "(no input)"}`,
        stepId: decisionBefore(loop.calls[LOOP_REPEATS - 1]!.startedAt),
      });
    }

    // A cost spike: far above what this agent's runs usually cost (or read, without a price).
    const usualRun = typical.get(run.harness);
    const read = run.inputTokens + run.cacheReadTokens + run.cacheWriteTokens;
    if (usualRun) {
      const byCost = run.costUsd != null && usualRun.priced >= BASELINE_RUNS && usualRun.cost > 0 && run.costUsd >= Math.max(usualRun.cost * SPIKE_RATIO, SPIKE_FLOOR_USD);
      const byTokens = !byCost && run.costUsd == null && usualRun.all >= BASELINE_RUNS && usualRun.tokens > 0 && read >= Math.max(usualRun.tokens * SPIKE_RATIO, SPIKE_FLOOR_TOKENS);
      if (byCost || byTokens) {
        const context = (step: (typeof stepRows)[number]) => (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0);
        const priciest = decisions.reduce<(typeof stepRows)[number] | null>((top, step) => (!top || (step.costUsd ?? context(step) / 1e9) > (top.costUsd ?? context(top) / 1e9) ? step : top), null);
        const calls = `It made ${run.llmCallCount} model ${run.llmCallCount === 1 ? "call" : "calls"} and read ${many(read)} tokens.`;
        found.push({
          ...base,
          kind: "cost",
          status: "confirmed",
          subject: task,
          evidence: byCost
            ? `This run cost ${money(run.costUsd!)}, ${times(run.costUsd! / usualRun.cost)} this agent's usual ${money(usualRun.cost)}. ${calls}`
            : `This run read ${many(read)} tokens, ${times(read / usualRun.tokens)} this agent's usual ${many(usualRun.tokens)}. ${calls}`,
          stepId: priciest?.id ?? null,
        });
      }
    }

    // Suspected: the model checks these before they count.
    const answer = run.output ?? "";
    if (REFUSAL.test(answer)) {
      found.push({ ...base, kind: "refusal", status: "suspected", subject: task, evidence: `It ended with: "${clip(answer, 300)}"`, stepId: decisions.at(-1)?.id ?? null });
    } else if (answer.trim() && run.status === "ok" && (run.errorCount > 0 || spotCheck(run.id))) {
      found.push({
        ...base,
        kind: "wrong_answer",
        status: "suspected",
        subject: task,
        evidence: run.errorCount > 0 ? `It answered as if done, although ${run.errorCount === 1 ? "a step" : `${run.errorCount} steps`} failed on the way.` : "A spot check of a run that looked fine.",
        stepId: decisions.at(-1)?.id ?? null,
      });
    }
    return found;
  }

  /** The run as the model reads it: the task, the steps in order (the first 10 and last 30), and the final answer. */
  async function outline(projectId: string, runId: string) {
    const [run] = await ctx.db.select({ name: runs.name, input: runs.input, output: runs.output, harness: runs.harness }).from(runs).where(and(eq(runs.projectId, projectId), eq(runs.id, runId)));
    const all = await ctx.db
      .select({ id: steps.id, kind: steps.kind, name: steps.name, toolName: steps.toolName, status: steps.status, inputPreview: steps.inputPreview, outputPreview: steps.outputPreview, error: steps.error })
      .from(steps)
      .where(eq(steps.runId, runId))
      .orderBy(asc(steps.startedAt), asc(steps.seq));
    const shown = all.length > 40 ? [...all.slice(0, 10), ...all.slice(-30)] : all;
    const lines = shown.map((step, i) => {
      const n = i + 1;
      if (step.kind === "llm") return `#${n} model call: ${clip(step.outputPreview, 300) || "(no text)"}`;
      const result = step.status === "error" ? `failed: ${clip(step.error, 300)}` : `ok: ${clip(step.outputPreview, 300)}`;
      return `#${n} ${step.toolName ?? step.name}(${clip(step.inputPreview, 200)}) → ${result}`;
    });
    const text = [
      `## Agent\n${run?.harness ?? "unknown"}`,
      `## The task\n${clip(run?.input ?? run?.name, 800) || "(not recorded)"}`,
      `## What it did${all.length > shown.length ? ` (${all.length} steps; the first 10 and last 30)` : ""}\n${lines.join("\n") || "(no steps)"}`,
      `## Its final answer\n${clip(run?.output, 1500) || "(none)"}`,
    ].join("\n\n");
    return { text, ids: shown.map((step) => ({ id: step.id, kind: step.kind })) };
  }

  async function check(projectId: string, finding: { runId: string; kind: "refusal" | "wrong_answer"; evidence: string; stepId: string | null }) {
    const chat = ctx.chat!;
    const { text, ids } = await outline(projectId, finding.runId);
    const where = and(eq(runFindings.projectId, projectId), eq(runFindings.runId, finding.runId), eq(runFindings.kind, finding.kind));
    try {
      const result = await chat({
        model: model!,
        json: true,
        reasoningEffort: "low",
        maxTokens: 4_000,
        temperature: 0,
        messages: [
          { role: "system", content: CHECK },
          { role: "user", content: `## What Lucid suspects (${finding.kind})\n${QUESTION[finding.kind]} ${finding.evidence}\n\n${text}` },
        ],
      });
      const parsed = json(result.text);
      const real = parsed?.problem === true;
      const picked = typeof parsed?.step === "number" ? ids[parsed.step - 1] : undefined;
      await ctx.db
        .update(runFindings)
        .set({
          status: real ? "confirmed" : "cleared",
          verdict: typeof parsed?.reason === "string" ? clip(parsed.reason, 400) : "The check's answer couldn't be read.",
          // The model call where it went wrong, when the model named one.
          stepId: picked?.kind === "llm" ? picked.id : finding.stepId,
          model,
          inputTokens: result.inputTokens ?? null,
          outputTokens: result.outputTokens ?? null,
          latencyMs: result.latencyMs,
          checkedAt: new Date(),
        })
        .where(where);
      if (real) ctx.live.publish({ projectId, runIds: [finding.runId] });
    } catch (error) {
      // Not retried by itself: a failing provider would spend the cap again and again.
      ctx.log.warn(`[review] check with ${model} failed: ${(error as Error).message.slice(0, 300)}`);
      await ctx.db.update(runFindings).set({ status: "cleared", verdict: `The check failed: ${clip((error as Error).message, 200)}`, model, checkedAt: new Date() }).where(where);
    }
  }

  /** Model checks this account can still have today. */
  async function checksLeft(projectId: string) {
    const [done] = await ctx.db
      .select({ n: count() })
      .from(runFindings)
      .where(and(eq(runFindings.projectId, projectId), isNotNull(runFindings.model), gt(runFindings.checkedAt, new Date(Date.now() - DAY))));
    let waiting = 0;
    for (const key of checking) if (key.startsWith(`${projectId}\u0000`)) waiting++;
    return CHECKS_PER_DAY - (done?.n ?? 0) - waiting;
  }

  async function checkSuspects(projectId: string) {
    const left = await checksLeft(projectId);
    if (left <= 0) return;
    const suspects = await ctx.db
      .select({ runId: runFindings.runId, kind: runFindings.kind, evidence: runFindings.evidence, stepId: runFindings.stepId })
      .from(runFindings)
      .where(and(eq(runFindings.projectId, projectId), eq(runFindings.status, "suspected")))
      .orderBy(desc(runFindings.createdAt))
      .limit(left + checking.size);
    let started = 0;
    for (const suspect of suspects) {
      const key = `${projectId}\u0000${suspect.runId}\u0000${suspect.kind}`;
      const kind = suspect.kind;
      if (checking.has(key) || started >= left || !isChecked(kind)) continue;
      checking.add(key);
      started++;
      const finding = { ...suspect, kind };
      queue.push(() => check(projectId, finding).finally(() => checking.delete(key)));
    }
    pump();
  }

  return {
    /** Whether suspected problems can be checked: a model key and a model. */
    enabled,

    /**
     * Looks at runs finished since the last look (rules only; quick), then
     * starts model checks of suspected ones in the background when `auto`.
     * At most once every SCAN_EVERY_MS per account.
     */
    async scan(projectId: string, auto: boolean) {
      const now = Date.now();
      if (now - (lastScan.get(projectId) ?? 0) < SCAN_EVERY_MS) return;
      lastScan.set(projectId, now);
      const batch = await ctx.db
        .select({
          id: runs.id,
          harness: runs.harness,
          name: runs.name,
          input: runs.input,
          output: runs.output,
          status: runs.status,
          costUsd: runs.costUsd,
          inputTokens: runs.inputTokens,
          cacheReadTokens: runs.cacheReadTokens,
          cacheWriteTokens: runs.cacheWriteTokens,
          llmCallCount: runs.llmCallCount,
          errorCount: runs.errorCount,
        })
        .from(runs)
        .where(
          and(
            eq(runs.projectId, projectId),
            isNull(runs.scannedAt),
            gte(runs.startedAt, new Date(now - 7 * DAY)),
            or(and(ne(runs.status, "running"), lte(sql`coalesce(${runs.endedAt}, ${runs.startedAt})`, new Date(now - SETTLE_MS))), lte(runs.startedAt, new Date(now - HOUR))),
          ),
        )
        .orderBy(desc(runs.startedAt))
        .limit(SCAN_BATCH);
      if (batch.length) {
        const typical = await usual(projectId);
        const found = (await Promise.all(batch.map((run) => look(projectId, run, typical)))).flat();
        if (found.length) await ctx.db.insert(runFindings).values(found).onConflictDoNothing();
        await ctx.db.update(runs).set({ scannedAt: new Date() }).where(inArray(runs.id, batch.map((run) => run.id)));
      }
      if (auto && enabled) await checkSuspects(projectId);
    },

    /**
     * Confirmed findings, grouped like failed steps: by kind, agent, and the
     * failure they came after, or else the tool a loop repeats or the task.
     */
    async issues(projectId: string, causeOf: CauseOf = () => null): Promise<FindingIssue[]> {
      const rows = await ctx.db
        .select({
          runId: runFindings.runId,
          kind: runFindings.kind,
          subject: runFindings.subject,
          evidence: runFindings.evidence,
          verdict: runFindings.verdict,
          stepId: runFindings.stepId,
          harness: runs.harness,
          runName: runs.name,
          startedAt: runs.startedAt,
        })
        .from(runFindings)
        .innerJoin(runs, eq(runs.id, runFindings.runId))
        .where(and(eq(runFindings.projectId, projectId), eq(runFindings.status, "confirmed")))
        .orderBy(sql`${runs.startedAt} desc nulls last`)
        .limit(2000);
      const groups = new Map<string, Omit<FindingIssue, "id" | keyof Hint> & { key: string; subject: string }>();
      for (const row of rows) {
        const kind = row.kind as Finding;
        // Cost spikes have no one step to blame.
        const cause = kind === "cost" ? null : causeOf({ runId: row.runId, kind, subject: row.subject });
        const key = `finding\u0000${kind}\u0000${row.harness}\u0000${cause ? `after\u0000${cause}` : row.subject}`;
        const group = groups.get(key) ?? {
          key,
          subject: row.subject,
          problem: kind,
          kind: kind === "loop" ? "tool" : "llm",
          toolName: kind === "loop" ? row.subject : null,
          signature: kind,
          // The newest one's evidence, with the model's reason when it checked.
          sample: [row.evidence, row.verdict].filter(Boolean).join("\n"),
          harness: row.harness,
          occurrences: 0,
          runs: 0,
          lastSeen: row.startedAt,
          firstSeen: row.startedAt,
          examples: [],
          runIds: [],
          affected: [],
          failedAt: [],
          decisions: [],
          cause,
        };
        group.occurrences++;
        group.runs++;
        group.runIds.push(row.runId);
        if (group.affected.length < AFFECTED_MAX) group.affected.push({ runId: row.runId, runName: row.runName, at: row.startedAt });
        if (row.startedAt) {
          group.failedAt.push(row.startedAt.getTime());
          if (!group.firstSeen || row.startedAt < group.firstSeen) group.firstSeen = row.startedAt;
        }
        if (group.examples.length < 5) {
          group.examples.push({ runId: row.runId, runName: row.runName });
          if (row.stepId) group.decisions.push(row.stepId);
        }
        groups.set(key, group);
      }
      return [...groups.values()].map(({ key, subject, ...group }) => ({
        id: Buffer.from(key).toString("base64url"),
        ...group,
        ...HINTS[group.problem](subject, group.sample ?? ""),
      }));
    },

    /** What the model reads to diagnose a group: what Lucid found, then the newest run in full. */
    async evidence(projectId: string, issue: FindingIssue) {
      const latest = issue.examples[0];
      const run = latest ? await outline(projectId, latest.runId) : null;
      return [
        `## What Lucid found\n${issue.problem.replace("_", " ")} in ${issue.runs} ${issue.runs === 1 ? "run" : "runs"} of this agent. In the newest one: ${issue.sample}`,
        run?.text,
        `## Lucid's rule-of-thumb guess (may be generic)\n${issue.title}. ${issue.why} Fix: ${issue.fix}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  };
}
