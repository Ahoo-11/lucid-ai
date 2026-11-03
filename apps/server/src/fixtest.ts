// Testing a fix before it reaches an agent. For up to TEST_DECISIONS runs
// where the problem happened, Lucid rebuilds the exact request behind the
// decision that went wrong, adds the fix where the agent's Lucid plugin puts
// it (under the lessons block of the turn's user message) and replays it; the
// model then judges whether the new decision avoids the problem. A fix is
// applied only after its exact text passes. One that fails is rewritten once,
// with the reasons, and tested again.
//
// Replays use Lucid's own model (Muse Spark on Baseten). When the agent runs
// another model, the test says which one Muse Spark stood in for.

import type { FixTestResult } from "@lucid/schema/db";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { AppContext } from "./context";
import { schema } from "./db";
import type { ChatClient, ChatMessage, ToolCall } from "./ee/arena/llm";
import { type DecisionRequest, decisionRequest, outputOf, textOf } from "./ee/arena/request";
import { LESSON_MAX, LESSON_RULE } from "./explain";
import { errorSignature } from "./insights";

const { blobs, fixTests, runs, steps } = schema;

/** At most this many past decisions are replayed per test. */
export const TEST_DECISIONS = 3;
/** Tests running at once, however many people click. */
const CONCURRENCY = 2;
/** The plugin's header for the lessons it adds to a turn (packages/hermes-plugin). */
export const LESSONS_HEADER = "Lessons from your owner, via Lucid (follow them):";

export type FixTest =
  | { status: "running"; lesson: string; at: string }
  | {
      status: "passed" | "failed";
      lesson: string;
      revisedFrom: string | null;
      results: FixTestResult[];
      model: string;
      standIn: string | null;
      at: string;
      inputTokens: number;
      outputTokens: number;
      latencyMs: number;
    }
  | { status: "untestable" | "error"; lesson: string; reason: string; at: string };

/** What a test checks: the problem in words, and the decisions (LLM steps) where it went wrong, best first. */
export type TestTarget = { issueId: string; problem: string; decisions: string[] };

/** What to do with a fix that passed: the words that passed, and the owner's words when the model rewrote them. */
type OnPass = (passed: { lesson: string; revisedFrom: string | null }) => Promise<unknown>;

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** Adds a fix to a captured request where the plugin would: first in the lessons block of the turn's user message. */
export function withLesson(messages: ChatMessage[], lesson: string): ChatMessage[] {
  const line = `- ${lesson}`;
  let index = -1;
  messages.forEach((message, i) => {
    if (message.role === "user" && !textOf(message.content).startsWith("[tool result]")) index = i;
  });
  if (index === -1) return [{ role: "system", content: `${LESSONS_HEADER}\n${line}` }, ...messages];
  const add = (text: string) => (text.includes(LESSONS_HEADER) ? text.replace(LESSONS_HEADER, `${LESSONS_HEADER}\n${line}`) : `${text}\n\n${LESSONS_HEADER}\n${line}`);
  const { content } = messages[index]!;
  const next = Array.isArray(content) ? [...content, { type: "text", text: `\n\n${LESSONS_HEADER}\n${line}` }] : add(textOf(content));
  return messages.map((message, i) => (i === index ? { ...message, content: next } : message));
}

/** A decision in a few lines: what it said, and the tools it called. */
function describe(out: { text?: string; toolCalls?: ToolCall[] }) {
  const calls = (out.toolCalls ?? []).map((call) => `Calls ${call.name}(${clip(JSON.stringify(call.input ?? {}), 600)})`);
  return [clip(out.text, 1500), ...calls].filter(Boolean).join("\n") || "(no answer and no tool call)";
}

/** The model's JSON, tolerating code fences and stray text around it. */
function json(text: string | undefined) {
  const match = text ? /\{[\s\S]*\}/.exec(text)?.[0] : undefined;
  if (!match) return null;
  try {
    return JSON.parse(match) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const JUDGE = `You check whether a fix worked. An AI agent made a mistake at one decision. Its owner wrote an instruction (the fix) for the agent. The same decision was replayed with the fix added to the agent's instructions.

Decide whether the new decision avoids the mistake without causing a new problem (refusing to do the task, ignoring it, or doing something unsafe).
- pass is true only if the new decision clearly avoids the mistake described. Doing the same thing as the original, or something equivalent, is a fail.
- reason: one plain sentence for the owner, who may not be technical.

Reply with JSON only: {"pass": true, "reason": "..."}`;

const REVISE = `You improve an instruction for an AI agent. The instruction was meant to stop a mistake, but when the agent's decisions were replayed with it, the agent still made the mistake (or a new one). Write a better instruction.

The instruction is ${LESSON_RULE} Keep it under 60 words.

Reply with JSON only: {"lesson": "..."}`;

export function createFixTester(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const enabled = !!ctx.chat && !!model;
  /** Tests waiting or running, by project and problem. */
  const active = new Set<string>();
  const queue: (() => Promise<void>)[] = [];
  let running = 0;
  const keyOf = (projectId: string, issueId: string) => `${projectId}\u0000${issueId}`;

  const load = (projectId: string) => async (hash: string) => {
    const [row] = await ctx.db.select({ content: blobs.content }).from(blobs).where(and(eq(blobs.projectId, projectId), eq(blobs.hash, hash)));
    return row?.content ?? null;
  };

  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const work = queue.shift()!;
      running++;
      void work()
        .catch((error) => ctx.log.error("[fix test]", error))
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  async function save(projectId: string, issueId: string, values: Omit<typeof fixTests.$inferInsert, "projectId" | "issueId">) {
    await ctx.db
      .insert(fixTests)
      .values({ projectId, issueId, ...values })
      .onConflictDoUpdate({ target: [fixTests.projectId, fixTests.issueId], set: values });
  }

  /** Replays one decision with the fix and has the model judge the result. */
  async function check(chat: ChatClient, problem: string, lesson: string, decision: Replayable) {
    const replay = await chat({
      model: model!,
      messages: withLesson(decision.request.messages, lesson),
      tools: decision.request.tools,
      maxTokens: decision.request.params.maxTokens,
      temperature: decision.request.params.temperature,
      reasoningEffort: "low",
    });
    const now = describe(replay);
    const verdict = await chat({
      model: model!,
      json: true,
      reasoningEffort: "low",
      maxTokens: 4_000,
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE },
        {
          role: "user",
          content: [
            `## The mistake\n${problem}`,
            `## The fix\n${lesson}`,
            decision.task && `## The agent's task\n${clip(decision.task, 800)}`,
            `## What the agent did originally\n${decision.original}`,
            `## What it did with the fix\n${now}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });
    const parsed = json(verdict.text);
    const result: FixTestResult = {
      runId: decision.runId,
      runName: decision.runName,
      pass: parsed?.pass === true,
      reason: typeof parsed?.reason === "string" ? clip(parsed.reason, 300) : "The judge's answer couldn't be read, so this counts as a fail.",
      decision: clip(now, 600),
    };
    return { result, usage: [replay, verdict] };
  }

  async function revise(chat: ChatClient, problem: string, lesson: string, failed: FixTestResult[]) {
    const reply = await chat({
      model: model!,
      json: true,
      reasoningEffort: "low",
      maxTokens: 4_000,
      temperature: 0.2,
      messages: [
        { role: "system", content: REVISE },
        {
          role: "user",
          content: [`## The mistake\n${problem}`, `## The instruction that didn't work\n${lesson}`, ...failed.map((f, i) => `## Replay ${i + 1}\nThe agent did: ${f.decision}\nWhy it failed: ${f.reason}`)].join(
            "\n\n",
          ),
        },
      ],
    });
    const text = json(reply.text)?.lesson;
    return { lesson: typeof text === "string" ? clip(text.replace(/\s+/g, " "), LESSON_MAX) || null : null, usage: reply };
  }

  type Replayable = { runId: string; runName: string | null; task: string | null; request: DecisionRequest; original: string; model: string | null };

  /** The first TEST_DECISIONS decisions that can be replayed, or why none can. */
  async function replayable(projectId: string, stepIds: string[]): Promise<{ picked: Replayable[]; reason: string | null }> {
    const rows = stepIds.length ? await ctx.db.select().from(steps).where(and(eq(steps.projectId, projectId), inArray(steps.id, stepIds))) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const runRows = rows.length ? await ctx.db.select({ id: runs.id, name: runs.name, input: runs.input }).from(runs).where(inArray(runs.id, [...new Set(rows.map((r) => r.runId))])) : [];
    const runById = new Map(runRows.map((run) => [run.id, run]));
    const picked: Replayable[] = [];
    let reason: string | null = null;
    for (const id of stepIds) {
      const step = byId.get(id);
      if (!step || picked.length >= TEST_DECISIONS) continue;
      const built = await decisionRequest(step, load(projectId));
      if (!built.ok) {
        reason ??= built.reason;
        continue;
      }
      const run = runById.get(step.runId);
      picked.push({
        runId: step.runId,
        runName: run?.name ?? null,
        task: run?.input ?? run?.name ?? null,
        request: built.request,
        original: describe(outputOf(step.outputHash ? await load(projectId)(step.outputHash) : null)),
        model: step.model,
      });
    }
    return { picked, reason: picked.length ? null : (reason ?? "None of the runs where this happened recorded what the model saw.") };
  }

  async function test(projectId: string, target: TestTarget, lesson: string, onPass?: OnPass) {
    const chat = ctx.chat!;
    const started = Date.now();
    const usage = { inputTokens: 0, outputTokens: 0 };
    const count = (results: { inputTokens?: number; outputTokens?: number }[]) => {
      for (const r of results) {
        usage.inputTokens += r.inputTokens ?? 0;
        usage.outputTokens += r.outputTokens ?? 0;
      }
    };
    try {
      const { picked, reason } = await replayable(projectId, target.decisions);
      if (!picked.length) {
        await save(projectId, target.issueId, { lesson, status: "untestable", error: reason, results: null, finishedAt: new Date() });
        return;
      }
      // Exact when the agent runs Lucid's model; otherwise say whose place it took.
      const agentModel = picked.find((d) => d.model)?.model ?? null;
      const standIn = agentModel && !agentModel.includes(model!.split("/").pop()!) ? agentModel : null;
      let current = lesson;
      let revisedFrom: string | null = null;
      for (let round = 0; ; round++) {
        const checked = await Promise.all(picked.map((decision) => check(chat, target.problem, current, decision)));
        count(checked.flatMap((c) => c.usage));
        const results = checked.map((c) => c.result);
        const passed = results.every((r) => r.pass);
        if (!passed && round === 0) {
          const better = await revise(chat, target.problem, current, results.filter((r) => !r.pass));
          count([better.usage]);
          if (better.lesson && better.lesson !== current) {
            revisedFrom = current;
            current = better.lesson;
            continue;
          }
        }
        await save(projectId, target.issueId, {
          lesson: current,
          revisedFrom,
          status: passed ? "passed" : "failed",
          results,
          model,
          standIn,
          error: null,
          ...usage,
          latencyMs: Date.now() - started,
          finishedAt: new Date(),
        });
        // A pass that can't be applied stays a pass: the owner can still apply it by hand.
        if (passed && onPass) await onPass({ lesson: current, revisedFrom }).catch((error) => ctx.log.error("[fix test] applying the fix", error));
        return;
      }
    } catch (error) {
      ctx.log.warn(`[fix test] with ${model} failed: ${(error as Error).message.slice(0, 300)}`);
      await save(projectId, target.issueId, { lesson, status: "error", error: (error as Error).message.slice(0, 500), results: null, finishedAt: new Date() });
    }
  }

  return {
    /** Whether fixes can be tested: a model key and a model (Baseten sets both). */
    enabled,

    /** Starts testing a fix in the background, unless a test of this problem is already running. onPass runs once it has passed. */
    async start(projectId: string, target: TestTarget, lesson: string, onPass?: OnPass): Promise<FixTest> {
      const key = keyOf(projectId, target.issueId);
      const at = new Date();
      if (!active.has(key)) {
        active.add(key);
        await save(projectId, target.issueId, { lesson, status: "running", revisedFrom: null, results: null, model, standIn: null, error: null, inputTokens: null, outputTokens: null, latencyMs: null, createdAt: at, finishedAt: null });
        queue.push(() => test(projectId, target, lesson, onPass).finally(() => active.delete(key)));
        pump();
      }
      return { status: "running", lesson, at: at.toISOString() };
    },

    /** The latest test of each of these problems. */
    async latest(projectId: string, issueIds: string[]) {
      const out = new Map<string, FixTest>();
      if (!issueIds.length) return out;
      const rows = await ctx.db.select().from(fixTests).where(and(eq(fixTests.projectId, projectId), inArray(fixTests.issueId, issueIds)));
      for (const row of rows) {
        const at = row.createdAt.toISOString();
        if (row.status === "running") {
          out.set(
            row.issueId,
            active.has(keyOf(projectId, row.issueId)) ? { status: "running", lesson: row.lesson, at } : { status: "error", lesson: row.lesson, reason: "The test stopped when Lucid restarted.", at },
          );
        } else if (row.status === "passed" || row.status === "failed") {
          out.set(row.issueId, {
            status: row.status,
            lesson: row.lesson,
            revisedFrom: row.revisedFrom,
            results: row.results ?? [],
            model: row.model ?? "",
            standIn: row.standIn,
            at,
            inputTokens: row.inputTokens ?? 0,
            outputTokens: row.outputTokens ?? 0,
            latencyMs: row.latencyMs ?? 0,
          });
        } else {
          out.set(row.issueId, { status: row.status === "untestable" ? "untestable" : "error", lesson: row.lesson, reason: row.error ?? "Unknown error", at });
        }
      }
      return out;
    },

    /** Whether exactly this fix passed its latest test: the gate in front of applying it. */
    async passed(projectId: string, issueId: string, lesson: string) {
      const [row] = await ctx.db.select({ status: fixTests.status, lesson: fixTests.lesson }).from(fixTests).where(and(eq(fixTests.projectId, projectId), eq(fixTests.issueId, issueId)));
      return row?.status === "passed" && row.lesson === lesson;
    },
  };
}

/**
 * The decisions behind a failed tool call, newest run first: in each run the
 * problem happened in, the model call just before the first matching failure.
 */
export async function failingDecisions(ctx: AppContext, projectId: string, issue: { kind: string; toolName: string | null; signature: string; examples: { runId: string }[] }) {
  const ids: string[] = [];
  for (const { runId } of issue.examples) {
    const failed = await ctx.db
      .select({ error: steps.error, startedAt: steps.startedAt, toolName: steps.toolName, kind: steps.kind })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), eq(steps.runId, runId), eq(steps.status, "error")))
      .orderBy(steps.startedAt);
    const failing = failed.find((step) => step.kind === issue.kind && step.toolName === issue.toolName && errorSignature(step.error) === issue.signature);
    if (!failing?.startedAt) continue;
    const [decision] = await ctx.db
      .select({ id: steps.id })
      .from(steps)
      .where(and(eq(steps.runId, runId), eq(steps.kind, "llm"), lte(steps.startedAt, failing.startedAt)))
      .orderBy(desc(steps.startedAt))
      .limit(1);
    if (decision) ids.push(decision.id);
  }
  return ids;
}
