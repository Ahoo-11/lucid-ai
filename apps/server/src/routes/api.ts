// Dashboard API. Shapes are made for the screens, not generic: the Runs list
// gets exactly the columns it shows, the Run page gets the run and its steps.

import { modelContextWindow } from "@lucid/pricing";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, max, or, sql, sum } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext, AppEnv } from "../context";
import { type CallInput, contextBreakdown, rebuildMessages } from "../contextBreakdown";
import { schema } from "../db";
import { CLOSED, resolveAccount } from "../auth";
import { arenaRoutes } from "../ee/arena/routes";
import { createExplainer } from "../explain";
import { createFixTester, failingDecisions } from "../fixtest";
import { AFFECTED_MAX, type CauseOf, createReviewer } from "../review";
import { createRater, estimate } from "../priority";
import { createLinker, groupByCause } from "../roots";
import { errorSignature, hintFor } from "../insights";
import { LESSON_HARNESSES, applyLesson, cleanLesson, lessonsForIssues, runsSince, setLessonStatus } from "../lessons";
import { publicEndpoint } from "../install";
import { cacheSavings, costSplit, pricingCatalog } from "../pricing";
import { createApiKey } from "../keys";
import { batchFor } from "../normalizers";
import { upstreams } from "../proxy";
import { listPlugins, requestUpdate } from "../plugins";
import { currentSyncs } from "../syncs";
import { writeBatch } from "../writer";

const { apiKeys, blobs, fixTests, ignoredIssues, issueExplanations, lessons, projects, rawEvents, runs, sessions, steps } = schema;
const UNTESTED = "Test this fix first: Lucid applies a fix only after it passes a test on past runs.";
const STATUSES = new Set(["ok", "error", "running"]);
/** The Spend view's periods, in days. */
const USAGE_DAYS = new Set([1, 7, 30]);
/** A run's context breakdown reads every call's messages; past this many calls the rest go unsplit. */
const CONTEXT_MAX_CALLS = 500;
/** Earlier runs of a session read to rebuild a call's chat: agents compact long chats, so older turns weren't in the prompt anyway. */
const REBUILD_TURNS = 20;

const tokensIn = (step: { inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }) =>
  (step.inputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const runListColumns = {
  id: runs.id,
  name: runs.name,
  input: sql<string | null>`left(${runs.input}, 300)`,
  output: sql<string | null>`left(${runs.output}, 300)`,
  status: runs.status,
  harness: runs.harness,
  model: runs.model,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  durationMs: runs.durationMs,
  costUsd: runs.costUsd,
  costIncomplete: runs.costIncomplete,
  inputTokens: runs.inputTokens,
  outputTokens: runs.outputTokens,
  cacheReadTokens: runs.cacheReadTokens,
  cacheWriteTokens: runs.cacheWriteTokens,
  stepCount: runs.stepCount,
  llmCallCount: runs.llmCallCount,
  toolCallCount: runs.toolCallCount,
  errorCount: runs.errorCount,
  sessionId: runs.sessionId,
  sessionTitle: sessions.title,
  metadata: runs.metadata,
};

/**
 * Scopes a dashboard call to one project: the default one locally, the
 * signed-in account's own one when hosted.
 */
export const requireProject = (ctx: AppContext): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (ctx.localMode) {
    c.set("projectId", ctx.defaultProjectId);
    return next();
  }
  // With Clerk, changes need the bearer token: the session cookie alone
  // (which EventSource relies on) is only good for reading.
  if (ctx.clerk && c.req.method !== "GET" && !c.req.header("authorization")) return c.json({ error: "Sign in required" }, 401);
  const resolved = await resolveAccount(ctx, c);
  if (resolved.status === "closed") return c.json({ error: CLOSED }, 403);
  if (resolved.status === "signed-out") return c.json({ error: "Sign in required" }, 401);
  c.set("projectId", resolved.account.projectId);
  return next();
};

export function apiRoutes(ctx: AppContext) {
  const app = new Hono<AppEnv>();
  const { db } = ctx;
  const explainer = createExplainer(ctx);
  const tester = createFixTester(ctx);
  const reviewer = createReviewer(ctx);
  const linker = createLinker(ctx);
  const rater = createRater(ctx);

  app.use("*", requireProject(ctx));

  app.route("/arena", arenaRoutes(ctx));

  app.get("/overview", async (c) => {
    const projectId = c.get("projectId");
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [totals] = await db
      .select({
        runs: count(),
        errors: sql<number>`(count(*) filter (where ${runs.status} = 'error' or ${runs.errorCount} > 0))::int`,
        costUsd: sum(runs.costUsd).mapWith(Number),
        avgDurationMs: sql<number | null>`avg(${runs.durationMs})::int`,
      })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), gte(runs.startedAt, since)));
    const harnesses = await db
      .select({ harness: runs.harness, runs: count(), lastAt: max(runs.startedAt) })
      .from(runs)
      .where(eq(runs.projectId, projectId))
      .groupBy(runs.harness)
      .orderBy(desc(max(runs.startedAt)));
    const topTools = await db
      .select({
        tool: steps.toolName,
        calls: count(),
        errors: sql<number>`(count(*) filter (where ${steps.status} = 'error'))::int`,
        avgMs: sql<number | null>`avg(${steps.durationMs})::int`,
      })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), sql`${steps.toolName} is not null`, gte(steps.startedAt, since)))
      .groupBy(steps.toolName)
      .orderBy(desc(count()))
      .limit(8);
    return c.json({ last24h: totals, harnesses, topTools });
  });

  /**
   * The Usage tab over the last 1, 7 or 30 days: totals (and the same for the
   * period before, to compare), by hour, by agent, by model, the most used
   * tools, and the costliest runs.
   */
  app.get("/usage", async (c) => {
    const projectId = c.get("projectId");
    const asked = Number(c.req.query("days"));
    const days = USAGE_DAYS.has(asked) ? asked : 7;
    const period = days * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - period);
    const inPeriod = and(eq(runs.projectId, projectId), gte(runs.startedAt, since));
    const before = and(eq(runs.projectId, projectId), gte(runs.startedAt, new Date(since.getTime() - period)), lt(runs.startedAt, since));
    const sums = {
      runs: count(),
      costUsd: sum(runs.costUsd).mapWith(Number),
      inputTokens: sum(runs.inputTokens).mapWith(Number),
      outputTokens: sum(runs.outputTokens).mapWith(Number),
      cacheReadTokens: sum(runs.cacheReadTokens).mapWith(Number),
      cacheWriteTokens: sum(runs.cacheWriteTokens).mapWith(Number),
      reasoningTokens: sum(runs.reasoningTokens).mapWith(Number),
      llmCalls: sum(runs.llmCallCount).mapWith(Number),
    };
    const periodSums = {
      ...sums,
      unpricedRuns: sql<number>`(count(*) filter (where ${runs.costIncomplete} > 0))::int`,
      sessions: sql<number>`count(distinct coalesce(${runs.sessionId}, 'run:' || ${runs.id}))::int`,
      toolCalls: sql<number>`coalesce(sum(${runs.toolCallCount}), 0)::int`,
      failedSteps: sql<number>`coalesce(sum(${runs.errorCount}), 0)::int`,
      failedRuns: sql<number>`(count(*) filter (where ${runs.status} = 'error' or ${runs.errorCount} > 0))::int`,
      agentMs: sql<number>`coalesce(sum(${runs.durationMs}), 0)::bigint`.mapWith(Number),
    };
    const [totals] = await db.select(periodSums).from(runs).where(inPeriod);
    const [previous] = await db.select(periodSums).from(runs).where(before);
    const tools = await db
      .select({
        tool: steps.toolName,
        calls: count(),
        failed: sql<number>`(count(*) filter (where ${steps.status} = 'error'))::int`,
        avgMs: sql<number | null>`avg(${steps.durationMs})::int`,
      })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), isNotNull(steps.toolName), gte(steps.startedAt, since)))
      .groupBy(steps.toolName)
      .orderBy(desc(count()))
      .limit(8);
    const [biggest] = await db
      .select({ tokens: sql<number | null>`max(coalesce(${steps.inputTokens}, 0) + coalesce(${steps.cacheReadTokens}, 0) + coalesce(${steps.cacheWriteTokens}, 0))::int` })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), eq(steps.kind, "llm"), gte(steps.startedAt, since)));
    // UTC hours: the browser groups them into the viewer's own days.
    const hour = sql<string>`to_char(date_trunc('hour', ${runs.startedAt} at time zone 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"')`;
    const hours = await db.select({ at: hour, ...sums }).from(runs).where(inPeriod).groupBy(hour).orderBy(hour);
    const agents = await db
      .select({ harness: runs.harness, ...sums })
      .from(runs)
      .where(inPeriod)
      .groupBy(runs.harness)
      .orderBy(sql`sum(${runs.costUsd}) desc nulls last`);
    const modelRows = await db
      .select({
        model: steps.model,
        provider: steps.provider,
        calls: count(),
        costUsd: sum(steps.costUsd).mapWith(Number),
        inputTokens: sum(steps.inputTokens).mapWith(Number),
        outputTokens: sum(steps.outputTokens).mapWith(Number),
        cacheReadTokens: sum(steps.cacheReadTokens).mapWith(Number),
        cacheWriteTokens: sum(steps.cacheWriteTokens).mapWith(Number),
        unpriced: sql<number>`(count(*) filter (where ${steps.costUsd} is null))::int`,
      })
      .from(steps)
      .where(and(eq(steps.projectId, projectId), eq(steps.kind, "llm"), gte(steps.startedAt, since)))
      .groupBy(steps.model, steps.provider)
      .orderBy(sql`sum(${steps.costUsd}) desc nulls last`);
    const top = await db
      .select({
        id: runs.id,
        name: runs.name,
        harness: runs.harness,
        model: runs.model,
        startedAt: runs.startedAt,
        costUsd: runs.costUsd,
        inputTokens: runs.inputTokens,
        outputTokens: runs.outputTokens,
        cacheReadTokens: runs.cacheReadTokens,
        cacheWriteTokens: runs.cacheWriteTokens,
      })
      .from(runs)
      .where(and(inPeriod, isNotNull(runs.costUsd)))
      .orderBy(desc(runs.costUsd))
      .limit(5);
    return c.json({
      days,
      since: since.toISOString(),
      totals: { ...totals, split: costSplit(modelRows), cacheSavedUsd: cacheSavings(modelRows), largestContext: biggest?.tokens ?? 0 },
      previous,
      hours,
      agents,
      models: modelRows.map((row) => ({ ...row, split: costSplit([row]) })),
      tools,
      top,
    });
  });

  app.get("/runs", async (c) => {
    const projectId = c.get("projectId");
    const status = c.req.query("status");
    const harness = c.req.query("harness");
    const q = c.req.query("q")?.trim();
    const sessionId = c.req.query("session");
    const before = c.req.query("before");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const filters = [eq(runs.projectId, projectId)];
    if (status === "error") filters.push(or(eq(runs.status, "error"), sql`${runs.errorCount} > 0`)!);
    else if (status && STATUSES.has(status)) filters.push(eq(runs.status, status));
    if (harness) filters.push(eq(runs.harness, harness));
    if (sessionId) filters.push(eq(runs.sessionId, sessionId));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      filters.push(or(ilike(runs.name, like), ilike(runs.input, like), ilike(runs.output, like))!);
    }
    if (before) filters.push(lt(runs.startedAt, new Date(before)));
    const rows = await db
      .select(runListColumns)
      .from(runs)
      .leftJoin(sessions, eq(sessions.id, runs.sessionId))
      .where(and(...filters))
      .orderBy(sql`${runs.startedAt} desc nulls last`, desc(runs.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return c.json({ runs: page, nextBefore: rows.length > limit && last?.startedAt ? last.startedAt.toISOString() : null });
  });

  app.get("/runs/:id", async (c) => {
    const projectId = c.get("projectId");
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.id, c.req.param("id"))));
    if (!run) return c.json({ error: "Run not found" }, 404);
    const [session] = run.sessionId ? await db.select().from(sessions).where(eq(sessions.id, run.sessionId)) : [];
    const stepRows = await db
      .select()
      .from(steps)
      .where(eq(steps.runId, run.id))
      .orderBy(sql`${steps.startedAt} asc nulls last`, asc(steps.seq), asc(steps.createdAt));
    // Neighbours in the same session, for prev/next navigation.
    const siblings = run.sessionId
      ? await db
          .select({ id: runs.id, name: runs.name, startedAt: runs.startedAt, status: runs.status })
          .from(runs)
          .where(eq(runs.sessionId, run.sessionId))
          .orderBy(sql`${runs.startedAt} asc nulls last`)
      : [];
    const llmSteps = stepRows.filter((step) => step.kind === "llm");
    // The biggest prompt of the run, against the most its model can take.
    const biggest = llmSteps.reduce<(typeof llmSteps)[number] | null>((best, step) => (!best || tokensIn(step) > tokensIn(best) ? step : best), null);
    const contextWindow = biggest ? modelContextWindow(pricingCatalog(), biggest.provider, biggest.model) : null;
    return c.json({ run, session: session ?? null, steps: stepRows, sessionRuns: siblings, costSplit: costSplit(llmSteps), contextWindow });
  });

  /** What the run's model calls read, by where it came from (see contextBreakdown.ts). Loaded on a click: it reads every call's messages. */
  app.get("/runs/:id/context", async (c) => {
    const projectId = c.get("projectId");
    const [run] = await db
      .select({ id: runs.id, input: runs.input, sessionId: runs.sessionId, startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), eq(runs.id, c.req.param("id"))));
    if (!run) return c.json({ error: "Run not found" }, 404);
    const stepRows = await db
      .select({
        externalId: steps.externalId,
        parentExternalId: steps.parentExternalId,
        kind: steps.kind,
        inputHash: steps.inputHash,
        attrs: steps.attrs,
        inputTokens: steps.inputTokens,
        cacheReadTokens: steps.cacheReadTokens,
        cacheWriteTokens: steps.cacheWriteTokens,
      })
      .from(steps)
      .where(eq(steps.runId, run.id))
      .orderBy(sql`${steps.startedAt} asc nulls last`, asc(steps.seq), asc(steps.createdAt));
    const byId = new Map(stepRows.map((step) => [step.externalId, step]));
    const inSubAgent = (step: (typeof stepRows)[number]) => {
      const seen = new Set<string>();
      for (let parent = step.parentExternalId; parent && !seen.has(parent); parent = byId.get(parent)?.parentExternalId ?? null) {
        seen.add(parent);
        if (byId.get(parent)?.kind === "agent") return true;
      }
      return false;
    };
    const llmSteps = stepRows.filter((step) => step.kind === "llm").slice(0, CONTEXT_MAX_CALLS);
    const load = async (keys: string[]) => {
      if (!keys.length) return new Map<string, unknown>();
      const rows = await db
        .select({ hash: blobs.hash, content: blobs.content })
        .from(blobs)
        .where(and(eq(blobs.projectId, projectId), inArray(blobs.hash, keys)));
      return new Map(rows.map((row) => [row.hash, parseJson(row.content)]));
    };
    // Tool sets repeat across calls; messages are big, so they're read a few calls at a time.
    const tools = await load([...new Set(llmSteps.map((step) => step.attrs?.toolsRef).filter((key): key is string => !!key))]);
    const calls: CallInput[] = [];
    for (let i = 0; i < llmSteps.length; i += 20) {
      const chunk = llmSteps.slice(i, i + 20);
      const inputs = await load(chunk.map((step) => step.inputHash).filter((key): key is string => !!key));
      for (const step of chunk) {
        const input = step.inputHash ? inputs.get(step.inputHash) : undefined;
        const messages = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.messages) ? input.messages : null;
        const toolList = step.attrs?.toolsRef ? tools.get(step.attrs.toolsRef) : undefined;
        calls.push({ stepId: step.externalId, messages, tools: Array.isArray(toolList) ? toolList : null, inSubAgent: inSubAgent(step), inputTokens: step.inputTokens, cacheReadTokens: step.cacheReadTokens, cacheWriteTokens: step.cacheWriteTokens });
      }
    }
    // Calls whose messages never came (Hermes cuts big requests to a preview; its history keeps none): rebuilt from the chat.
    if (calls.some((call) => !call.messages?.length)) {
      const rebuilt = rebuildMessages(await conversationOf(projectId, run));
      for (const call of calls) {
        const messages = call.messages?.length ? undefined : rebuilt.get(call.stepId);
        if (messages?.length) Object.assign(call, { messages, rebuilt: true });
      }
    }
    return c.json(contextBreakdown(calls, run.input));
  });

  /**
   * A run's chat as recorded, for rebuilding what its model calls were sent:
   * the last REBUILD_TURNS runs of its session before it, then itself, each
   * with its steps in order and their full inputs and outputs.
   */
  async function conversationOf(projectId: string, run: { id: string; input: string | null; sessionId: string | null; startedAt: Date | null }) {
    const earlier =
      run.sessionId && run.startedAt
        ? await db
            .select({ id: runs.id, input: runs.input })
            .from(runs)
            .where(and(eq(runs.projectId, projectId), eq(runs.sessionId, run.sessionId), lt(runs.startedAt, run.startedAt)))
            .orderBy(desc(runs.startedAt))
            .limit(REBUILD_TURNS)
        : [];
    const turns = [...earlier.reverse(), run];
    const rows = await db
      .select({
        runId: steps.runId,
        externalId: steps.externalId,
        parentExternalId: steps.parentExternalId,
        kind: steps.kind,
        toolName: steps.toolName,
        toolCallId: steps.toolCallId,
        inputHash: steps.inputHash,
        outputHash: steps.outputHash,
      })
      .from(steps)
      .where(inArray(steps.runId, turns.map((turn) => turn.id)))
      .orderBy(sql`${steps.startedAt} asc nulls last`, asc(steps.seq), asc(steps.createdAt));
    // Replies and tool results, and a sub-agent's task: stored whole, as text or JSON.
    const keys = [...new Set(rows.flatMap((row) => [row.outputHash, row.kind === "agent" ? row.inputHash : null]).filter((key): key is string => !!key))];
    const content = new Map<string, unknown>();
    for (let i = 0; i < keys.length; i += 200) {
      const found = await db
        .select({ hash: blobs.hash, content: blobs.content })
        .from(blobs)
        .where(and(eq(blobs.projectId, projectId), inArray(blobs.hash, keys.slice(i, i + 200))));
      for (const blob of found) content.set(blob.hash, parseJson(blob.content) ?? blob.content);
    }
    const of = (key: string | null) => (key ? content.get(key) : undefined);
    return turns.map((turn) => ({
      input: turn.input,
      steps: rows
        .filter((row) => row.runId === turn.id)
        .map((row) => ({ stepId: row.externalId, parentId: row.parentExternalId, kind: row.kind, toolName: row.toolName, toolCallId: row.toolCallId, input: of(row.inputHash), output: of(row.outputHash) })),
    }));
  }

  /**
   * Failed steps grouped by what failed and how, most runs first, with the
   * rule-based hint; and what a loop, give-up or wrong answer in a run came
   * after: the run's last failure, or the failure the looping tool hit most.
   */
  async function loadIssues(projectId: string) {
    const failed = await db
      .select({
        runId: steps.runId,
        kind: steps.kind,
        toolName: steps.toolName,
        error: steps.error,
        startedAt: steps.startedAt,
        runName: runs.name,
        harness: runs.harness,
      })
      .from(steps)
      .innerJoin(runs, eq(runs.id, steps.runId))
      .where(and(eq(steps.projectId, projectId), eq(steps.status, "error")))
      .orderBy(sql`${steps.startedAt} desc nulls last`)
      .limit(5000);
    type Group = {
      key: string;
      kind: string;
      toolName: string | null;
      signature: string;
      sample: string | null;
      /** The agent it happened in most recently: the one a lesson for it goes to. */
      harness: string;
      occurrences: number;
      runIds: Set<string>;
      lastSeen: Date | null;
      firstSeen: Date | null;
      examples: { runId: string; runName: string | null }[];
      affected: { runId: string; runName: string | null; at: Date | null }[];
      /** When each failure happened, to count the ones after a fix went live. */
      failedAt: number[];
    };
    const groups = new Map<string, Group>();
    const lastIn = new Map<string, string>();
    /** By run and tool: how often each failure happened. */
    const byTool = new Map<string, Map<string, number>>();
    for (const row of failed) {
      const signature = errorSignature(row.error);
      const key = `${row.kind}\u0000${row.toolName ?? ""}\u0000${signature}`;
      const group = groups.get(key) ?? { key, kind: row.kind, toolName: row.toolName, signature, sample: row.error, harness: row.harness, occurrences: 0, runIds: new Set(), lastSeen: row.startedAt, firstSeen: row.startedAt, examples: [], affected: [], failedAt: [] };
      group.occurrences++;
      if (row.startedAt) group.failedAt.push(row.startedAt.getTime());
      if (!group.runIds.has(row.runId)) {
        if (group.examples.length < 5) group.examples.push({ runId: row.runId, runName: row.runName });
        if (group.affected.length < AFFECTED_MAX) group.affected.push({ runId: row.runId, runName: row.runName, at: row.startedAt });
      }
      group.runIds.add(row.runId);
      if (row.startedAt && (!group.firstSeen || row.startedAt < group.firstSeen)) group.firstSeen = row.startedAt;
      groups.set(key, group);
      // Newest first, so the first failure seen in a run is its last.
      if (!lastIn.has(row.runId)) lastIn.set(row.runId, key);
      if (row.toolName) {
        const counts = byTool.get(`${row.runId}\u0000${row.toolName}`) ?? new Map<string, number>();
        byTool.set(`${row.runId}\u0000${row.toolName}`, counts.set(key, (counts.get(key) ?? 0) + 1));
      }
    }
    const idOf = (key: string) => Buffer.from(key).toString("base64url");
    const issues = [...groups.values()]
      .map(({ runIds, key, ...group }) => ({ id: idOf(key), ...group, runs: runIds.size, runIds: [...runIds], ...hintFor(group.toolName, group.kind, group.sample) }))
      .sort((a, b) => b.runs - a.runs || b.occurrences - a.occurrences);
    const causeOf: CauseOf = ({ runId, kind, subject }) => {
      if (kind !== "loop") return lastIn.has(runId) ? idOf(lastIn.get(runId)!) : null;
      const counts = [...(byTool.get(`${runId}\u0000${subject}`) ?? [])].sort((a, b) => b[1] - a[1]);
      return counts[0] ? idOf(counts[0][0]) : null;
    };
    return { issues, causeOf };
  }

  /**
   * Everything the Inbox lists, one entry per root cause (see roots.ts): failed
   * steps grouped by how they failed, and the problems no step reported (loops,
   * cost spikes, refusals, wrong answers), joined when they share a cause. Most
   * runs first. Each entry is its main problem with the others' runs added.
   */
  async function allIssues(projectId: string) {
    const failures = await loadIssues(projectId);
    const [findings, grouping, saved, fixed] = await Promise.all([
      reviewer.issues(projectId, failures.causeOf),
      linker.grouping(projectId),
      db.select({ issueId: issueExplanations.issueId, title: issueExplanations.title }).from(issueExplanations).where(and(eq(issueExplanations.projectId, projectId), eq(issueExplanations.status, "ready"))),
      Promise.all([
        db.select({ issueId: lessons.issueId }).from(lessons).where(eq(lessons.projectId, projectId)),
        db.select({ issueId: fixTests.issueId }).from(fixTests).where(eq(fixTests.projectId, projectId)),
      ]).then((rows) => new Set(rows.flat().map((row) => row.issueId))),
    ]);
    const symptoms = [
      ...failures.issues.map((issue) => ({ ...issue, problem: "error" as const, decisions: [] as string[], evidence: undefined, cause: null })),
      // The model reads what Lucid found and the run itself, not a failed step.
      ...findings.map((issue) => ({ ...issue, evidence: () => reviewer.evidence(projectId, issue) })),
    ];
    type Symptom = (typeof symptoms)[number];
    const titles = new Map(saved.flatMap((row) => (row.title ? [[row.issueId, row.title] as const] : [])));
    const time = (at: Date | null) => at?.getTime() ?? 0;
    // The main problem keeps a fix being tried or tracked, then the failure behind the others, then a diagnosis.
    const better = (a: Symptom, b: Symptom) =>
      Number(fixed.has(b.id)) - Number(fixed.has(a.id)) ||
      Number(b.problem === "error") - Number(a.problem === "error") ||
      Number(titles.has(b.id)) - Number(titles.has(a.id)) ||
      b.runs - a.runs ||
      time(a.firstSeen) - time(b.firstSeen) ||
      a.id.localeCompare(b.id);
    const entries = groupByCause(symptoms, grouping, better).map(({ main, members }) => {
      const all = members.map(({ symptom }) => symptom);
      const runIds = new Set(all.flatMap((symptom) => symptom.runIds));
      const affected = new Map<string, { runId: string; runName: string | null; at: Date | null; problems: string[] }>();
      for (const symptom of all) {
        for (const run of symptom.affected) {
          const entry = affected.get(run.runId) ?? { ...run, problems: [] };
          entry.problems.push(symptom.id);
          if (time(run.at) > time(entry.at)) entry.at = run.at;
          affected.set(run.runId, entry);
        }
      }
      const others = all.slice(1);
      return {
        ...main,
        occurrences: all.reduce((total, symptom) => total + symptom.occurrences, 0),
        runs: runIds.size,
        lastSeen: all.reduce<Date | null>((latest, { lastSeen }) => (time(lastSeen) > time(latest) ? lastSeen : latest), null),
        firstSeen: all.reduce<Date | null>((earliest, { firstSeen }) => (firstSeen && (!earliest || firstSeen < earliest) ? firstSeen : earliest), null),
        failedAt: all.flatMap((symptom) => symptom.failedAt),
        decisions: all.flatMap((symptom) => symptom.decisions),
        members: all,
        symptoms: members.map(({ symptom, via }) => ({
          id: symptom.id,
          problem: symptom.problem,
          kind: symptom.kind,
          toolName: symptom.toolName,
          title: titles.get(symptom.id) ?? symptom.title,
          sample: symptom.sample,
          runs: symptom.runs,
          occurrences: symptom.occurrences,
          lastSeen: symptom.lastSeen,
          via,
        })),
        affected: [...affected.values()].sort((a, b) => time(b.at) - time(a.at)).slice(0, AFFECTED_MAX),
        related: others.length
          ? `## The same cause also showed up as\n${others.map((s) => `- ${titles.get(s.id) ?? s.title}${s.toolName ? ` (${s.toolName})` : ""}, in ${s.runs} ${s.runs === 1 ? "run" : "runs"}: ${(s.sample ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`
          : undefined,
      };
    });
    return { issues: entries.sort((a, b) => b.runs - a.runs || b.occurrences - a.occurrences), grouping };
  }

  const findIssue = async (projectId: string, id: string) => (await allIssues(projectId)).issues.find((issue) => issue.id === id);

  app.get("/issues", async (c) => {
    const projectId = c.get("projectId");
    const [project] = await db.select({ autoDiagnose: projects.autoDiagnose }).from(projects).where(eq(projects.id, projectId)).limit(1);
    const autoDiagnose = project?.autoDiagnose ?? true;
    // Runs finished since the last look are checked for problems no step reported.
    await reviewer.scan(projectId, autoDiagnose);
    const { issues, grouping } = await allIssues(projectId);
    const ignored = new Set((await db.select({ issueId: ignoredIssues.issueId }).from(ignoredIssues).where(eq(ignoredIssues.projectId, projectId))).map((row) => row.issueId));
    // Problems with one cause are joined first, so diagnoses go to what's left.
    const open = issues.filter((issue) => !ignored.has(issue.id) && !grouping.get(issue.id)?.split);
    const items = open.map((issue) => ({ harness: issue.harness, ids: issue.members.map((m) => m.id), title: issue.symptoms[0]!.title, toolName: issue.toolName, sample: issue.sample, runs: issue.runs, runId: issue.examples[0]?.runId ?? null }));
    const joining = (autoDiagnose && linker.maybe(projectId, items, new Set(grouping.keys()))) || linker.busy(projectId);
    // Opening the Inbox starts diagnoses for recurring problems never diagnosed, up to the daily cap.
    const diagnoses = await explainer.diagnoses(projectId, issues.slice(0, 200), { auto: autoDiagnose && !joining, ignored });
    const applied = await lessonsForIssues(db, projectId, issues.slice(0, 200).map((issue) => issue.id));
    const tests = await tester.latest(projectId, issues.slice(0, 200).map((issue) => issue.id));
    // How much each matters: the model rates recurring ones without a fix live, side by side, once they're grouped.
    const week = (issue: { affected: { at: Date | null }[] }) => issue.affected.filter((run) => run.at && Date.now() - run.at.getTime() < 7 * 24 * 3_600_000).length;
    const ratings = await rater.ratings(projectId, open.map((issue) => issue.id));
    const ratable = open
      .filter((issue) => issue.runs >= 2 && applied.get(issue.id)?.status !== "active")
      .map((issue) => {
        const known = diagnoses.get(issue.id);
        const ai = known?.status === "ready" ? known : null;
        return {
          id: issue.id,
          harness: issue.harness,
          title: ai?.title ?? issue.title,
          summary: ai?.summary ?? ai?.why ?? issue.why,
          toolName: issue.toolName,
          runs: issue.runs,
          week: week(issue),
          lastSeen: issue.lastSeen,
          problems: issue.symptoms.length,
          runId: issue.examples[0]?.runId ?? null,
        };
      });
    const rating = (!joining && autoDiagnose && rater.maybe(projectId, ratable, ratings)) || rater.busy(projectId);
    const shown = await Promise.all(
      issues.map(async ({ failedAt, decisions: _decisions, evidence: _evidence, runIds: _runIds, members: _members, related: _related, cause: _cause, ...issue }) => {
        const lesson = applied.get(issue.id);
        // A fix's results: this problem's failures, and the agent's runs, since it went live.
        const since = lesson?.status === "active" && lesson.deliveredAt ? new Date(lesson.deliveredAt) : null;
        return {
          ...issue,
          diagnosis: diagnoses.get(issue.id) ?? null,
          lesson: lesson ? { ...lesson, failuresSince: since ? failedAt.filter((t) => t > since.getTime()).length : null, runsSince: since ? await runsSince(db, projectId, lesson.harness, since) : null } : null,
          // Whether Lucid can apply a lesson in this agent by itself (or it's one to copy).
          lessonsApply: LESSON_HARNESSES.has(issue.harness),
          ignored: ignored.has(issue.id),
          fixTest: tests.get(issue.id) ?? null,
          importance: ratings.get(issue.id) ?? estimate({ week: week(issue), lastSeen: issue.lastSeen }),
        };
      }),
    );
    // While grouping, diagnoses wait; while rating, the order may change: the dashboard asks again soon.
    return c.json({ issues: shown, diagnosisModel: explainer.enabled ? ctx.ai?.model : null, autoDiagnose, grouping: joining || linker.busy(projectId), rating });
  });

  // Testing a fix: the decisions where it went wrong, replayed with it added. Nothing reaches an agent without a pass.
  app.post("/issues/:id/test", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    if (!tester.enabled) return c.json({ error: "Testing a fix needs a model key: set BASETEN_API_KEY for the Lucid server." }, 409);
    const projectId = c.get("projectId");
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; apply?: unknown };
    const text = cleanLesson(body.text);
    if (!text) return c.json({ error: "Write the fix first." }, 400);
    const issue = await findIssue(projectId, c.req.param("id"));
    if (!issue) return c.json({ error: "That problem isn't in the Inbox anymore." }, 404);
    // Test & apply: a pass of the owner's own words goes to the agent at once. A rewrite waits for them to read it.
    const onPass =
      body.apply === true && LESSON_HARNESSES.has(issue.harness)
        ? async ({ revisedFrom }: { revisedFrom: string | null }) => {
            if (revisedFrom === null) await applyLesson(db, projectId, { issueId: issue.id, harness: issue.harness, text });
          }
        : undefined;
    // The judge needs to know the mistake: the model's diagnosis when there is one.
    const [diagnosis] = await db
      .select({ title: issueExplanations.title, why: issueExplanations.why })
      .from(issueExplanations)
      .where(and(eq(issueExplanations.projectId, projectId), eq(issueExplanations.issueId, issue.id), eq(issueExplanations.status, "ready")));
    const about = diagnosis?.title && diagnosis.why ? diagnosis : issue;
    const problem = [`${about.title}. ${about.why}`, issue.toolName && `The failing step: ${issue.toolName}.`, issue.sample && `The error: ${issue.sample.slice(0, 500)}`].filter(Boolean).join("\n");
    // The main problem's decisions first, then a few of each other way it showed up, so one fix is tested on all.
    const decisions = (
      await Promise.all(issue.members.slice(0, 5).map((member) => (member.problem === "error" ? failingDecisions(ctx, projectId, member) : member.decisions)))
    ).flat();
    return c.json({ fixTest: await tester.start(projectId, { issueId: issue.id, problem, decisions }, text, onPass) });
  });

  // Ignore: out of the Inbox and its badge, and never diagnosed by itself. Restore brings it back.
  app.post("/issues/:id/:action{ignore|restore}", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const issueId = c.req.param("id");
    // All the ways it showed up, so it stays ignored whichever one leads it.
    const ids = (await findIssue(projectId, issueId))?.members.map((member) => member.id) ?? [];
    if (c.req.param("action") === "restore") {
      await db.delete(ignoredIssues).where(and(eq(ignoredIssues.projectId, projectId), inArray(ignoredIssues.issueId, [issueId, ...ids])));
      return c.json({ ignored: false });
    }
    if (!ids.length) return c.json({ error: "That problem isn't in the Inbox anymore." }, 404);
    await db.insert(ignoredIssues).values(ids.map((id) => ({ projectId, issueId: id }))).onConflictDoNothing();
    return c.json({ ignored: true });
  });

  // "Not the same problem": one way a cause showed up is its own problem; it leaves the entry for good.
  app.post("/issues/:id/split", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const issueId = c.req.param("id");
    const { issues } = await allIssues(projectId);
    if (!issues.some((issue) => issue.members.length > 1 && issue.members.some((member) => member.id === issueId))) {
      return c.json({ error: "That problem isn't grouped with others anymore." }, 404);
    }
    await linker.split(projectId, issueId);
    return c.json({ split: true });
  });

  // The Inbox's switch for diagnosing recurring problems without a click.
  app.post("/settings/auto-diagnose/:status{on|off}", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const autoDiagnose = c.req.param("status") === "on";
    await db.update(projects).set({ autoDiagnose }).where(eq(projects.id, c.get("projectId")));
    return c.json({ autoDiagnose });
  });

  // Approving a lesson: the owner's own words (edited or as proposed) go to that agent from its next turn.
  app.post("/issues/:id/lesson", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const text = cleanLesson(((await c.req.json().catch(() => ({}))) as { text?: unknown }).text);
    if (!text) return c.json({ error: "Write the lesson first." }, 400);
    const issue = await findIssue(projectId, c.req.param("id"));
    if (!issue) return c.json({ error: "That problem isn't in the Inbox anymore." }, 404);
    if (!LESSON_HARNESSES.has(issue.harness)) return c.json({ error: `Lucid can't apply lessons in ${issue.harness} yet. Copy it into the agent's instructions instead.` }, 409);
    if (!(await tester.passed(projectId, issue.id, text))) return c.json({ error: UNTESTED }, 409);
    return c.json({ lesson: await applyLesson(db, projectId, { issueId: issue.id, harness: issue.harness, text }) }, 201);
  });

  app.post("/lessons/:id/:status{on|off}", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const on = c.req.param("status") === "on";
    if (on) {
      // Back on is the same as applying it: only with a passed test of these words.
      const [row] = await db.select({ issueId: lessons.issueId, text: lessons.text }).from(lessons).where(and(eq(lessons.projectId, projectId), eq(lessons.id, c.req.param("id"))));
      if (row?.issueId && !(await tester.passed(projectId, row.issueId, row.text))) return c.json({ error: UNTESTED }, 409);
    }
    const lesson = await setLessonStatus(db, projectId, c.req.param("id"), on ? "active" : "off");
    return lesson ? c.json({ lesson }) : c.json({ error: "No such lesson" }, 404);
  });

  // The Diagnose button: one-off problems, ones past the daily cap, and running one again.
  app.post("/issues/:id/diagnose", async (c) => {
    // JSON only: a cross-site form can't send it, so no one can spend credits on your behalf.
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    if (!explainer.enabled) return c.json({ error: "Diagnoses need a model key: set BASETEN_API_KEY for the Lucid server." }, 409);
    const projectId = c.get("projectId");
    const issue = await findIssue(projectId, c.req.param("id"));
    if (!issue) return c.json({ error: "That problem isn't in the Inbox anymore." }, 404);
    return c.json({ diagnosis: explainer.request(projectId, issue) });
  });

  /**
   * Replays stored raw events through the current normalizers, oldest first,
   * so parser fixes apply to data already captured. Upserts make it idempotent.
   */
  app.post("/reprocess", async (c) => {
    const projectId = c.get("projectId");
    const body = (await c.req.json().catch(() => ({}))) as { harness?: string; rebuild?: boolean };
    // Rebuilding drops a harness's runs first, so steps an older parser made
    // that the new one no longer makes disappear. Claude Code transcripts are
    // parsed with per-file state and can't be replayed, so they are excluded.
    if (body.rebuild) {
      if (!body.harness || body.harness === "claude-code") {
        return c.json({ error: "rebuild needs a harness other than claude-code" }, 400);
      }
      await db.delete(runs).where(and(eq(runs.projectId, projectId), eq(runs.harness, body.harness)));
      await db.delete(sessions).where(and(eq(sessions.projectId, projectId), eq(sessions.harness, body.harness)));
    }
    const filters = [eq(rawEvents.projectId, projectId)];
    if (body.harness) filters.push(eq(rawEvents.harness, body.harness));
    const rows = await db.select().from(rawEvents).where(and(...filters)).orderBy(asc(rawEvents.id));
    const touched = new Set<string>();
    let replayed = 0;
    for (const row of rows) {
      const batch = batchFor(row.source, row.harness, row.payload);
      if (!batch) continue;
      const { runIds } = await writeBatch(db, projectId, batch, row.harness ?? "otel");
      for (const id of runIds) touched.add(id);
      replayed++;
    }
    ctx.live.publish({ projectId, runIds: [...touched] });
    return c.json({ replayed, runs: touched.size });
  });

  app.get("/blobs/:hash", async (c) => {
    const [row] = await db
      .select({ content: blobs.content })
      .from(blobs)
      .where(and(eq(blobs.projectId, c.get("projectId")), eq(blobs.hash, c.req.param("hash"))));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.text(row.content);
  });

  /**
   * The Runs tab: conversations, newest first. A session's requests are one
   * row; a request that came without a session is a row of its own ("run:<id>").
   * Filters match a conversation when any of its requests matches.
   */
  app.get("/sessions", async (c) => {
    const projectId = c.get("projectId");
    const status = c.req.query("status");
    const harness = c.req.query("harness");
    const q = c.req.query("q")?.trim();
    const before = c.req.query("before");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const key = sql<string>`coalesce(${runs.sessionId}, 'run:' || ${runs.id})`;
    const lastStarted = sql<Date | null>`max(${runs.startedAt})`.mapWith(runs.startedAt);
    const filters = [eq(runs.projectId, projectId)];
    if (harness) filters.push(eq(runs.harness, harness));
    if (q) {
      const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
      filters.push(sql`${key} in (
        select coalesce(r.session_id, 'run:' || r.id) from runs r
        left join sessions s on s.id = r.session_id
        where r.project_id = ${projectId} and (r.name ilike ${like} or r.input ilike ${like} or r.output ilike ${like} or s.title ilike ${like})
      )`);
    }
    const having = [];
    if (status === "error") having.push(sql`count(*) filter (where ${runs.status} = 'error' or ${runs.errorCount} > 0) > 0`);
    else if (status === "running") having.push(sql`bool_or(${runs.status} = 'running')`);
    if (before) having.push(sql`${lastStarted} < ${new Date(before)}`);
    const rows = await db
      .select({
        id: key,
        sessionId: sql<string | null>`min(${runs.sessionId})`,
        harness: sql<string>`min(${runs.harness})`,
        model: sql<string | null>`(array_agg(${runs.model} order by ${runs.startedAt} desc nulls last))[1]`,
        firstRequest: sql<string | null>`(array_agg(${runs.name} order by ${runs.startedAt} asc nulls last))[1]`,
        lastRequest: sql<string | null>`(array_agg(${runs.name} order by ${runs.startedAt} desc nulls last))[1]`,
        startedAt: sql<Date | null>`min(${runs.startedAt})`.mapWith(runs.startedAt),
        lastStartedAt: lastStarted,
        endedAt: sql<Date | null>`max(coalesce(${runs.endedAt}, ${runs.startedAt}))`.mapWith(runs.startedAt),
        requests: sql<number>`count(*)::int`,
        running: sql<number>`(count(*) filter (where ${runs.status} = 'running'))::int`,
        failed: sql<number>`(count(*) filter (where ${runs.status} = 'error'))::int`,
        errorCount: sql<number>`coalesce(sum(${runs.errorCount}), 0)::int`,
        costUsd: sum(runs.costUsd).mapWith(Number),
        costIncomplete: sql<number>`coalesce(sum(${runs.costIncomplete}), 0)::int`,
        inputTokens: sum(runs.inputTokens).mapWith(Number),
        outputTokens: sum(runs.outputTokens).mapWith(Number),
        cacheReadTokens: sum(runs.cacheReadTokens).mapWith(Number),
        cacheWriteTokens: sum(runs.cacheWriteTokens).mapWith(Number),
        llmCallCount: sql<number>`coalesce(sum(${runs.llmCallCount}), 0)::int`,
        toolCallCount: sql<number>`coalesce(sum(${runs.toolCallCount}), 0)::int`,
      })
      .from(runs)
      .where(and(...filters))
      .groupBy(key)
      .having(having.length ? and(...having) : undefined)
      .orderBy(sql`${lastStarted} desc nulls last`, desc(key))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.sessionId).filter((id): id is string => !!id);
    const details = ids.length
      ? await db.select({ id: sessions.id, title: sessions.title, gitBranch: sessions.gitBranch }).from(sessions).where(inArray(sessions.id, ids))
      : [];
    const byId = new Map(details.map((row) => [row.id, row]));
    const last = page[page.length - 1]?.lastStartedAt;
    return c.json({
      sessions: page.map((row) => ({ ...row, title: (row.sessionId && byId.get(row.sessionId)?.title) || null, gitBranch: (row.sessionId && byId.get(row.sessionId)?.gitBranch) || null })),
      nextBefore: rows.length > limit && last ? last.toISOString() : null,
    });
  });

  /**
   * One conversation, oldest request first: every request and answer, each
   * request's biggest prompt (the context the session has grown to), and the
   * cost split. Steps load per request, when its workings are opened.
   * `run:<id>` opens the session that run belongs to, or that run alone.
   */
  app.get("/sessions/:key", async (c) => {
    const projectId = c.get("projectId");
    const key = c.req.param("key");
    let sessionId: string | null = key;
    let soloRun: string | null = null;
    if (key.startsWith("run:")) {
      const [run] = await db
        .select({ id: runs.id, sessionId: runs.sessionId })
        .from(runs)
        .where(and(eq(runs.projectId, projectId), eq(runs.id, key.slice(4))));
      if (!run) return c.json({ error: "Run not found" }, 404);
      sessionId = run.sessionId;
      if (!sessionId) soloRun = run.id;
    }
    const [session] = sessionId ? await db.select().from(sessions).where(and(eq(sessions.projectId, projectId), eq(sessions.id, sessionId))) : [];
    if (sessionId && !session) return c.json({ error: "Session not found" }, 404);
    const rows = await db
      .select({ ...runListColumns, input: runs.input, output: runs.output })
      .from(runs)
      .leftJoin(sessions, eq(sessions.id, runs.sessionId))
      .where(and(eq(runs.projectId, projectId), sessionId ? eq(runs.sessionId, sessionId) : eq(runs.id, soloRun!)))
      .orderBy(sql`${runs.startedAt} asc nulls last`, asc(runs.id));
    const ids = rows.map((row) => row.id);
    const llm = and(eq(steps.projectId, projectId), inArray(steps.runId, ids.length ? ids : [""]), eq(steps.kind, "llm"));
    const promptSize = sql<number>`coalesce(${steps.inputTokens}, 0) + coalesce(${steps.cacheReadTokens}, 0) + coalesce(${steps.cacheWriteTokens}, 0)`;
    const contexts = await db
      .select({ runId: steps.runId, context: sql<number>`max(${promptSize})::int` })
      .from(steps)
      .where(llm)
      .groupBy(steps.runId);
    const byModel = await db
      .select({
        model: steps.model,
        provider: steps.provider,
        inputTokens: sum(steps.inputTokens).mapWith(Number),
        outputTokens: sum(steps.outputTokens).mapWith(Number),
        cacheReadTokens: sum(steps.cacheReadTokens).mapWith(Number),
        cacheWriteTokens: sum(steps.cacheWriteTokens).mapWith(Number),
      })
      .from(steps)
      .where(llm)
      .groupBy(steps.model, steps.provider);
    const [biggest] = await db.select({ model: steps.model, provider: steps.provider }).from(steps).where(llm).orderBy(desc(promptSize)).limit(1);
    const contextOf = new Map(contexts.map((row) => [row.runId, row.context]));
    return c.json({
      id: sessionId ?? `run:${soloRun}`,
      session: session ?? null,
      runs: rows.map((row) => ({ ...row, context: contextOf.get(row.id) ?? 0 })),
      costSplit: costSplit(byModel),
      contextWindow: biggest ? modelContextWindow(pricingCatalog(), biggest.provider, biggest.model) : null,
    });
  });

  app.get("/syncs", async (c) => c.json({ syncs: await currentSyncs(db, c.get("projectId")) }));

  // Lucid plugins in the project's agents, and the Update button.
  app.get("/plugins", async (c) => c.json({ plugins: await listPlugins(db, c.get("projectId")) }));

  app.post("/plugins/:id/update", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const row = await requestUpdate(db, projectId, c.req.param("id"));
    if (!row) return c.json({ error: "No such plugin" }, 404);
    return c.json({ plugin: (await listPlugins(db, projectId)).find((plugin) => plugin.id === row.id) });
  });

  app.get("/connect/status", async (c) => {
    const projectId = c.get("projectId");
    const sources = await db
      .select({ source: rawEvents.source, harness: rawEvents.harness, events: count(), lastAt: max(rawEvents.receivedAt) })
      .from(rawEvents)
      .where(eq(rawEvents.projectId, projectId))
      .groupBy(rawEvents.source, rawEvents.harness);
    const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(runs).where(eq(runs.projectId, projectId));
    return c.json({ endpoint: publicEndpoint(c), localMode: ctx.localMode, runs: total, sources, providers: Object.keys(upstreams()) });
  });

  app.get("/keys", async (c) => {
    const rows = await db
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.projectId, c.get("projectId")), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt));
    return c.json({ keys: rows });
  });

  app.post("/keys", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const created = await createApiKey(db, c.get("projectId"), body.name?.trim() || "Ingest key");
    return c.json({ id: created.id, name: created.name, prefix: created.prefix, key: created.key }, 201);
  });

  app.delete("/keys/:id", async (c) => {
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.projectId, c.get("projectId")), eq(apiKeys.id, c.req.param("id"))));
    return c.json({ ok: true });
  });

  app.get("/live", (c) => {
    const projectId = c.get("projectId");
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.live.subscribe(projectId, (runIds) => {
        void stream.writeSSE({ event: "runs", data: JSON.stringify({ runIds }) });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!closed) {
        await stream.sleep(15_000);
        if (!closed) await stream.writeSSE({ event: "ping", data: "{}" });
      }
    });
  });

  return app;
}
