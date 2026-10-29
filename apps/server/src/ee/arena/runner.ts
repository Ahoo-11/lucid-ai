// Arena experiments: create from captured decisions, replay them with other
// models/prompts in the background, collect blind votes from people and an
// LLM judge, and compute standings. Blindness is enforced here: nothing that
// identifies a candidate leaves the server until the experiment is revealed.

import { createHash, randomUUID } from "node:crypto";
import { estimateCostUsd, resolveModelPricing } from "@lucid/pricing";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../../context";
import { schema } from "../../db";
import { pricingCatalog } from "../../pricing";
import { DEFAULT_RUBRIC, judgePair } from "./judge";
import type { ToolCall } from "./llm";
import { type DecisionRequest, contextOf, decisionRequest, outputOf, withSystemPrompt } from "./request";
import { type Game, standings } from "./ratings";

const { blobs, experimentItems, experimentTrials, experimentVariants, experimentVotes, experiments, runs, steps } = schema;

export class ArenaError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type VariantInput = { model: string; promptMode?: "append" | "replace"; systemPrompt?: string; temperature?: number };

const MAX_ITEMS = 25;
const MAX_REPLAY_VARIANTS = 4;
const CONCURRENCY = 3;
const replaying = new Set<string>();
const judging = new Set<string>();

function shuffle<T>(items: T[]) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await work(items[next++]!);
    }),
  );
}

const blobLoader = (ctx: AppContext, projectId: string) => async (key: string) => {
  const [row] = await ctx.db.select({ content: blobs.content }).from(blobs).where(and(eq(blobs.projectId, projectId), eq(blobs.hash, key)));
  return row?.content ?? null;
};

/** Whether a step can be replayed, and why not. */
export async function checkStep(ctx: AppContext, projectId: string, stepId: string) {
  const [step] = await ctx.db.select().from(steps).where(and(eq(steps.projectId, projectId), eq(steps.id, stepId)));
  if (!step) throw new ArenaError(404, "Step not found");
  const built = await decisionRequest(step, blobLoader(ctx, projectId));
  return built.ok ? { ok: true as const, messages: built.request.messages.length, tools: built.request.tools.length } : { ok: false as const, reason: built.reason };
}

export async function createExperiment(
  ctx: AppContext,
  projectId: string,
  input: { stepIds: string[]; variants: VariantInput[]; name?: string; judgeModel?: string; rubric?: string },
) {
  const stepIds = [...new Set(input.stepIds)].slice(0, MAX_ITEMS);
  const variants = input.variants.filter((v) => v.model?.trim()).slice(0, MAX_REPLAY_VARIANTS);
  if (!stepIds.length) throw new ArenaError(400, "Pick at least one decision to test.");
  if (!variants.length) throw new ArenaError(400, "Pick at least one model or prompt to compare with the original.");
  if (!ctx.chat) throw new ArenaError(409, "No model key is configured. Set OPENROUTER_API_KEY for the Lucid server and restart it.");

  const db = ctx.db;
  const stepRows = await db.select().from(steps).where(and(eq(steps.projectId, projectId), inArray(steps.id, stepIds)));
  const byId = new Map(stepRows.map((s) => [s.id, s]));
  const runRows = stepRows.length ? await db.select().from(runs).where(inArray(runs.id, [...new Set(stepRows.map((s) => s.runId))])) : [];
  const runById = new Map(runRows.map((r) => [r.id, r]));
  const load = blobLoader(ctx, projectId);

  const experimentId = randomUUID();
  const items: (typeof experimentItems.$inferInsert & { original: { text?: string; toolCalls?: ToolCall[] }; source: (typeof stepRows)[number] })[] = [];
  const skipped: { stepId: string; reason: string }[] = [];
  for (const stepId of stepIds) {
    const step = byId.get(stepId);
    if (!step) {
      skipped.push({ stepId, reason: "Step not found" });
      continue;
    }
    const built = await decisionRequest(step, load);
    if (!built.ok) {
      skipped.push({ stepId, reason: built.reason });
      continue;
    }
    const content = JSON.stringify(built.request);
    const requestHash = createHash("sha256").update(content).digest("hex");
    await db.insert(blobs).values({ projectId, hash: requestHash, content, bytes: Buffer.byteLength(content) }).onConflictDoNothing();
    items.push({
      id: randomUUID(),
      experimentId,
      stepId,
      runId: step.runId,
      requestHash,
      context: contextOf(built.request.messages, runById.get(step.runId)?.input ?? null, built.request.tools),
      seq: items.length,
      original: outputOf(step.outputHash ? await load(step.outputHash) : null),
      source: step,
    });
  }
  if (!items.length) throw new ArenaError(400, skipped[0]?.reason ?? "None of these decisions can be replayed.", { skipped });

  const firstRun = runById.get(items[0]!.runId);
  const name =
    input.name?.trim() ||
    `${variants.map((v) => v.model.split("/").pop()).join(", ")} vs original · ${firstRun?.name?.slice(0, 60) ?? "decision"}${items.length > 1 ? ` (+${items.length - 1})` : ""}`;
  await db.insert(experiments).values({ id: experimentId, projectId, name, judgeModel: input.judgeModel?.trim() || null, rubric: input.rubric?.trim() || DEFAULT_RUBRIC });
  await db.insert(experimentItems).values(items.map(({ original: _o, source: _s, ...item }) => item));

  // Shuffled aliases: "Candidate 1" is not always the original.
  const aliases = shuffle(Array.from({ length: variants.length + 1 }, (_, i) => i + 1));
  const original = { id: randomUUID(), experimentId, alias: aliases[0]!, kind: "original", model: firstRun?.model ?? items[0]!.source.model };
  const replays = variants.map((v, i) => ({
    id: randomUUID(),
    experimentId,
    alias: aliases[i + 1]!,
    kind: "replay",
    model: v.model.trim(),
    promptMode: v.systemPrompt?.trim() ? (v.promptMode ?? "append") : null,
    systemPrompt: v.systemPrompt?.trim() || null,
    temperature: typeof v.temperature === "number" ? v.temperature : null,
  }));
  await db.insert(experimentVariants).values([original, ...replays]);

  const trials: (typeof experimentTrials.$inferInsert)[] = [];
  for (const item of items) {
    const step = item.source;
    trials.push({
      id: randomUUID(),
      experimentId,
      itemId: item.id!,
      variantId: original.id,
      status: "done",
      output: item.original,
      inputTokens: (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0) || null,
      outputTokens: step.outputTokens,
      costUsd: step.costUsd,
      latencyMs: step.durationMs,
      finishedAt: new Date(),
    });
    for (const variant of replays) trials.push({ id: randomUUID(), experimentId, itemId: item.id!, variantId: variant.id, status: "pending" });
  }
  await db.insert(experimentTrials).values(trials);
  void runTrials(ctx, projectId, experimentId);
  return { id: experimentId, items: items.length, skipped };
}

/** Replays every pending trial. Safe to call repeatedly (e.g. after a restart). */
export async function runTrials(ctx: AppContext, projectId: string, experimentId: string) {
  if (!ctx.chat || replaying.has(experimentId)) return;
  replaying.add(experimentId);
  const chat = ctx.chat;
  try {
    const pending = await ctx.db
      .select({ trial: experimentTrials, variant: experimentVariants, item: experimentItems })
      .from(experimentTrials)
      .innerJoin(experimentVariants, eq(experimentVariants.id, experimentTrials.variantId))
      .innerJoin(experimentItems, eq(experimentItems.id, experimentTrials.itemId))
      .where(and(eq(experimentTrials.experimentId, experimentId), eq(experimentTrials.status, "pending")));
    const load = blobLoader(ctx, projectId);
    await inParallel(pending, CONCURRENCY, async ({ trial, variant, item }) => {
      try {
        const request = JSON.parse((await load(item.requestHash)) ?? "null") as DecisionRequest | null;
        if (!request) throw new Error("The stored request is missing");
        const result = await chat({
          model: variant.model!,
          messages: withSystemPrompt(request.messages, variant.promptMode, variant.systemPrompt),
          tools: request.tools,
          maxTokens: request.params.maxTokens,
          temperature: variant.temperature ?? request.params.temperature,
        });
        const pricing = resolveModelPricing({ model: variant.model, catalog: pricingCatalog() });
        const cost = result.costUsd ?? estimateCostUsd(pricing, { inputTokens: result.inputTokens, outputTokens: result.outputTokens });
        await ctx.db
          .update(experimentTrials)
          .set({
            status: "done",
            output: { text: result.text, toolCalls: result.toolCalls },
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: cost,
            latencyMs: result.latencyMs,
            finishedAt: new Date(),
          })
          .where(eq(experimentTrials.id, trial.id));
      } catch (error) {
        // The dashboard hides this until the reveal (it names the model); the server log doesn't.
        ctx.log.warn(`[arena] replay with ${variant.model} failed: ${(error as Error).message.slice(0, 500)}`);
        await ctx.db
          .update(experimentTrials)
          .set({ status: "error", error: (error as Error).message.slice(0, 500), finishedAt: new Date() })
          .where(eq(experimentTrials.id, trial.id));
      }
    });
  } finally {
    replaying.delete(experimentId);
  }
}

async function load(ctx: AppContext, projectId: string, experimentId: string) {
  const [experiment] = await ctx.db.select().from(experiments).where(and(eq(experiments.projectId, projectId), eq(experiments.id, experimentId)));
  if (!experiment) throw new ArenaError(404, "Experiment not found");
  const [items, variants, trials, votes] = await Promise.all([
    ctx.db.select().from(experimentItems).where(eq(experimentItems.experimentId, experimentId)).orderBy(asc(experimentItems.seq)),
    ctx.db.select().from(experimentVariants).where(eq(experimentVariants.experimentId, experimentId)).orderBy(asc(experimentVariants.alias)),
    ctx.db.select().from(experimentTrials).where(eq(experimentTrials.experimentId, experimentId)),
    ctx.db.select().from(experimentVotes).where(eq(experimentVotes.experimentId, experimentId)),
  ]);
  return { experiment, items, variants, trials, votes };
}

const pairKey = (itemId: string, x: string, y: string) => `${itemId}\u0000${[x, y].sort().join("\u0000")}`;

/** All unordered pairs of finished trials per item. */
function allPairs(items: { id: string }[], trials: (typeof experimentTrials.$inferSelect)[]) {
  const pairs: { itemId: string; x: (typeof trials)[number]; y: (typeof trials)[number] }[] = [];
  for (const item of items) {
    const done = trials.filter((t) => t.itemId === item.id && t.status === "done");
    for (let i = 0; i < done.length; i++) for (let j = i + 1; j < done.length; j++) pairs.push({ itemId: item.id, x: done[i]!, y: done[j]! });
  }
  return pairs;
}

export async function runJudge(ctx: AppContext, projectId: string, experimentId: string, model?: string) {
  if (!ctx.chat) throw new ArenaError(409, "No model key is configured for the judge.");
  const { experiment, items, trials, votes } = await load(ctx, projectId, experimentId);
  const judgeModel = model?.trim() || experiment.judgeModel;
  if (!judgeModel) throw new ArenaError(400, "Pick a judge model.");
  if (judgeModel !== experiment.judgeModel) await ctx.db.update(experiments).set({ judgeModel }).where(eq(experiments.id, experimentId));
  if (judging.has(experimentId)) return { started: false };
  const judge = `judge:${judgeModel}`;
  const done = new Set(votes.filter((v) => v.judge === judge).map((v) => pairKey(v.itemId, v.trialA, v.trialB)));
  const todo = allPairs(items, trials).filter((p) => !done.has(pairKey(p.itemId, p.x.id, p.y.id)));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const chat = ctx.chat;
  judging.add(experimentId);
  void inParallel(todo, 2, async ({ itemId, x, y }) => {
    try {
      const verdict = await judgePair(chat, judgeModel, experiment.rubric ?? DEFAULT_RUBRIC, itemById.get(itemId)!.context ?? {}, x.output ?? {}, y.output ?? {});
      await ctx.db.insert(experimentVotes).values({ id: randomUUID(), experimentId, itemId, trialA: x.id, trialB: y.id, winner: verdict.winner, judge, reason: verdict.reason });
    } catch (error) {
      ctx.log.warn(`[arena] judge failed on a pair: ${(error as Error).message}`);
    }
  }).finally(() => judging.delete(experimentId));
  return { started: true, pairs: todo.length };
}

/** The next blind pair for a person to vote on, in random order, or null when done. */
export async function nextPair(ctx: AppContext, projectId: string, experimentId: string) {
  const { items, trials, votes } = await load(ctx, projectId, experimentId);
  const voted = new Set(votes.filter((v) => v.judge === "human").map((v) => pairKey(v.itemId, v.trialA, v.trialB)));
  const pairs = allPairs(items, trials);
  const open = pairs.filter((p) => !voted.has(pairKey(p.itemId, p.x.id, p.y.id)));
  const progress = { voted: pairs.length - open.length, total: pairs.length };
  if (!open.length) return { pair: null, progress };
  // Finish one decision before moving to the next, so context doesn't jump around.
  const firstItem = open[0]!.itemId;
  const candidates = open.filter((p) => p.itemId === firstItem);
  const chosen = candidates[Math.floor(Math.random() * candidates.length)]!;
  const [a, b] = Math.random() < 0.5 ? [chosen.x, chosen.y] : [chosen.y, chosen.x];
  const item = items.find((i) => i.id === firstItem)!;
  return {
    pair: { itemId: item.id, context: item.context, a: { trialId: a.id, output: a.output }, b: { trialId: b.id, output: b.output } },
    progress,
  };
}

export async function recordVote(ctx: AppContext, projectId: string, experimentId: string, vote: { itemId: string; a: string; b: string; winner: string }) {
  if (!["a", "b", "tie"].includes(vote.winner)) throw new ArenaError(400, "winner must be a, b or tie");
  const { trials } = await load(ctx, projectId, experimentId);
  const ok = [vote.a, vote.b].every((id) => trials.some((t) => t.id === id && t.itemId === vote.itemId && t.status === "done"));
  if (!ok || vote.a === vote.b) throw new ArenaError(400, "Those responses don't belong to this decision.");
  await ctx.db.insert(experimentVotes).values({ id: randomUUID(), experimentId, itemId: vote.itemId, trialA: vote.a, trialB: vote.b, winner: vote.winner, judge: "human" });
}

export async function reveal(ctx: AppContext, projectId: string, experimentId: string) {
  await load(ctx, projectId, experimentId);
  await ctx.db.update(experiments).set({ revealedAt: new Date() }).where(eq(experiments.id, experimentId));
}

export async function retryFailed(ctx: AppContext, projectId: string, experimentId: string) {
  await load(ctx, projectId, experimentId);
  await ctx.db
    .update(experimentTrials)
    .set({ status: "pending", error: null })
    .where(and(eq(experimentTrials.experimentId, experimentId), eq(experimentTrials.status, "error")));
  void runTrials(ctx, projectId, experimentId);
}

const toolNames = (output: { toolCalls?: ToolCall[] } | null) => [...new Set((output?.toolCalls ?? []).map((c) => c.name))].sort().join(",");
const average = (values: (number | null)[]) => {
  const present = values.filter((v): v is number => typeof v === "number");
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
};

export async function experimentDetail(ctx: AppContext, projectId: string, experimentId: string) {
  const { experiment, items, variants, trials, votes } = await load(ctx, projectId, experimentId);
  if (trials.some((t) => t.status === "pending") && !replaying.has(experimentId)) void runTrials(ctx, projectId, experimentId);
  const revealed = !!experiment.revealedAt;
  const variantOfTrial = new Map(trials.map((t) => [t.id, t.variantId]));
  const games = (filter: (judge: string) => boolean): Game[] =>
    votes
      .filter((v) => filter(v.judge))
      .map((v) => ({ a: variantOfTrial.get(v.trialA)!, b: variantOfTrial.get(v.trialB)!, winner: v.winner as Game["winner"] }));
  const ids = variants.map((v) => v.id);
  const human = standings(ids, games((j) => j === "human"));
  const judge = standings(ids, games((j) => j.startsWith("judge:")));

  // Do people and the judge agree, on pairs both judged?
  const humanVerdicts = new Map<string, string>();
  const verdictOf = (v: (typeof votes)[number]) => (v.winner === "tie" ? "tie" : variantOfTrial.get(v.winner === "a" ? v.trialA : v.trialB)!);
  for (const v of votes) if (v.judge === "human") humanVerdicts.set(pairKey(v.itemId, v.trialA, v.trialB), verdictOf(v));
  let compared = 0;
  let agreed = 0;
  for (const v of votes) {
    if (!v.judge.startsWith("judge:")) continue;
    const mine = humanVerdicts.get(pairKey(v.itemId, v.trialA, v.trialB));
    if (mine === undefined) continue;
    compared++;
    if (mine === verdictOf(v)) agreed++;
  }

  const original = variants.find((v) => v.kind === "original");
  const originalOutputs = new Map(trials.filter((t) => t.variantId === original?.id).map((t) => [t.itemId, toolNames(t.output)]));
  const pairsTotal = allPairs(items, trials).length;
  return {
    experiment: { id: experiment.id, name: experiment.name, judgeModel: experiment.judgeModel, rubric: experiment.rubric, revealed, createdAt: experiment.createdAt },
    items: items.map((item) => ({ id: item.id, runId: item.runId, stepId: item.stepId, context: item.context })),
    progress: {
      replays: { done: trials.filter((t) => t.status === "done").length, pending: trials.filter((t) => t.status === "pending").length, failed: trials.filter((t) => t.status === "error").length, total: trials.length },
      humanVotes: votes.filter((v) => v.judge === "human").length,
      judgeVotes: votes.filter((v) => v.judge.startsWith("judge:")).length,
      pairs: pairsTotal,
      replaying: replaying.has(experimentId),
      judging: judging.has(experimentId),
    },
    agreement: { compared, agreed },
    candidates: variants.map((variant) => {
      const mine = trials.filter((t) => t.variantId === variant.id);
      const finished = mine.filter((t) => t.status === "done");
      const sameTool = finished.filter((t) => toolNames(t.output) === originalOutputs.get(t.itemId)).length;
      return {
        id: variant.id,
        label: `Candidate ${variant.alias}`,
        // Identity, and anything that would reveal it, only after the reveal.
        ...(revealed
          ? {
              kind: variant.kind,
              model: variant.model,
              promptMode: variant.promptMode,
              systemPrompt: variant.systemPrompt,
              temperature: variant.temperature,
              sameToolAsOriginal: finished.length ? sameTool / finished.length : null,
              errors: mine.filter((t) => t.error).map((t) => t.error),
            }
          : {}),
        trials: { done: finished.length, failed: mine.filter((t) => t.status === "error").length, pending: mine.filter((t) => t.status === "pending").length },
        avgCostUsd: average(finished.map((t) => t.costUsd)),
        avgLatencyMs: average(finished.map((t) => t.latencyMs)),
        human: human.get(variant.id),
        judge: judge.get(variant.id),
      };
    }),
  };
}

export async function listExperiments(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.select().from(experiments).where(eq(experiments.projectId, projectId)).orderBy(asc(experiments.createdAt));
  const out = [];
  for (const row of rows.reverse()) {
    const [items, variants, votes, trials] = await Promise.all([
      ctx.db.select({ id: experimentItems.id }).from(experimentItems).where(eq(experimentItems.experimentId, row.id)),
      ctx.db.select({ id: experimentVariants.id }).from(experimentVariants).where(eq(experimentVariants.experimentId, row.id)),
      ctx.db.select({ judge: experimentVotes.judge }).from(experimentVotes).where(eq(experimentVotes.experimentId, row.id)),
      ctx.db.select({ status: experimentTrials.status }).from(experimentTrials).where(eq(experimentTrials.experimentId, row.id)),
    ]);
    out.push({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      revealed: !!row.revealedAt,
      decisions: items.length,
      candidates: variants.length,
      humanVotes: votes.filter((v) => v.judge === "human").length,
      judgeVotes: votes.filter((v) => v.judge !== "human").length,
      pending: trials.filter((t) => t.status === "pending").length,
    });
  }
  return out;
}
