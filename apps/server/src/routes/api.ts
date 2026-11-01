// Dashboard API. Shapes are made for the screens, not generic: the Runs list
// gets exactly the columns it shows, the Run page gets the run and its steps.

import { and, asc, count, desc, eq, gte, ilike, isNull, lt, max, or, sql, sum } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext, AppEnv } from "../context";
import { schema } from "../db";
import { CLOSED, resolveAccount } from "../auth";
import { arenaRoutes } from "../ee/arena/routes";
import { createExplainer } from "../explain";
import { errorSignature, hintFor } from "../insights";
import { LESSON_HARNESSES, applyLesson, cleanLesson, lessonsForIssues, runsSince, setLessonStatus } from "../lessons";
import { publicEndpoint } from "../install";
import { createApiKey } from "../keys";
import { batchFor } from "../normalizers";
import { upstreams } from "../proxy";
import { listPlugins, requestUpdate } from "../plugins";
import { currentSyncs } from "../syncs";
import { writeBatch } from "../writer";

const { apiKeys, blobs, rawEvents, runs, sessions, steps } = schema;
const STATUSES = new Set(["ok", "error", "running"]);

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
    return c.json({ run, session: session ?? null, steps: stepRows, sessionRuns: siblings });
  });

  /** Failed steps grouped by what failed and how, most runs first, with the rule-based hint. */
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
      /** When each failure happened, to count the ones after a fix went live. */
      failedAt: number[];
    };
    const groups = new Map<string, Group>();
    for (const row of failed) {
      const signature = errorSignature(row.error);
      const key = `${row.kind}\u0000${row.toolName ?? ""}\u0000${signature}`;
      const group = groups.get(key) ?? { key, kind: row.kind, toolName: row.toolName, signature, sample: row.error, harness: row.harness, occurrences: 0, runIds: new Set(), lastSeen: row.startedAt, firstSeen: row.startedAt, examples: [], failedAt: [] };
      group.occurrences++;
      if (row.startedAt) group.failedAt.push(row.startedAt.getTime());
      if (!group.runIds.has(row.runId) && group.examples.length < 5) group.examples.push({ runId: row.runId, runName: row.runName });
      group.runIds.add(row.runId);
      if (row.startedAt && (!group.firstSeen || row.startedAt < group.firstSeen)) group.firstSeen = row.startedAt;
      groups.set(key, group);
    }
    return [...groups.values()]
      .map(({ runIds, key, ...group }) => ({ id: Buffer.from(key).toString("base64url"), ...group, runs: runIds.size, ...hintFor(group.toolName, group.kind, group.sample) }))
      .sort((a, b) => b.runs - a.runs || b.occurrences - a.occurrences);
  }

  app.get("/issues", async (c) => {
    const projectId = c.get("projectId");
    const issues = await loadIssues(projectId);
    // Only what was already asked for: opening the Inbox never spends model credits.
    const diagnoses = await explainer.diagnoses(projectId, issues.slice(0, 200));
    const applied = await lessonsForIssues(db, projectId, issues.slice(0, 200).map((issue) => issue.id));
    const shown = await Promise.all(
      issues.map(async ({ failedAt, ...issue }) => {
        const lesson = applied.get(issue.id);
        // A fix's results: this problem's failures, and the agent's runs, since it went live.
        const since = lesson?.status === "active" && lesson.deliveredAt ? new Date(lesson.deliveredAt) : null;
        return {
          ...issue,
          diagnosis: diagnoses.get(issue.id) ?? null,
          lesson: lesson ? { ...lesson, failuresSince: since ? failedAt.filter((t) => t > since.getTime()).length : null, runsSince: since ? await runsSince(db, projectId, lesson.harness, since) : null } : null,
          // Whether Lucid can apply a lesson in this agent by itself (or it's one to copy).
          lessonsApply: LESSON_HARNESSES.has(issue.harness),
        };
      }),
    );
    return c.json({ issues: shown, diagnosisModel: explainer.enabled ? ctx.ai?.model : null });
  });

  // Approving a lesson: the owner's own words (edited or as proposed) go to that agent from its next turn.
  app.post("/issues/:id/lesson", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const projectId = c.get("projectId");
    const text = cleanLesson(((await c.req.json().catch(() => ({}))) as { text?: unknown }).text);
    if (!text) return c.json({ error: "Write the lesson first." }, 400);
    const issue = (await loadIssues(projectId)).find((candidate) => candidate.id === c.req.param("id"));
    if (!issue) return c.json({ error: "That problem isn't in the Inbox anymore." }, 404);
    if (!LESSON_HARNESSES.has(issue.harness)) return c.json({ error: `Lucid can't apply lessons in ${issue.harness} yet. Copy it into the agent's instructions instead.` }, 409);
    return c.json({ lesson: await applyLesson(db, projectId, { issueId: issue.id, harness: issue.harness, text }) }, 201);
  });

  app.post("/lessons/:id/:status{on|off}", async (c) => {
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    const lesson = await setLessonStatus(db, c.get("projectId"), c.req.param("id"), c.req.param("status") === "on" ? "active" : "off");
    return lesson ? c.json({ lesson }) : c.json({ error: "No such lesson" }, 404);
  });

  // A diagnosis runs only when someone asks for one (the Diagnose button), so
  // its cost can be measured before any rule starts them on its own.
  app.post("/issues/:id/diagnose", async (c) => {
    // JSON only: a cross-site form can't send it, so no one can spend credits on your behalf.
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Send JSON" }, 415);
    if (!explainer.enabled) return c.json({ error: "Diagnoses need a model key: set BASETEN_API_KEY for the Lucid server." }, 409);
    const projectId = c.get("projectId");
    const issue = (await loadIssues(projectId)).find((candidate) => candidate.id === c.req.param("id"));
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

  app.get("/sessions", async (c) => {
    const rows = await db
      .select({
        id: sessions.id,
        title: sessions.title,
        harness: sessions.harness,
        cwd: sessions.cwd,
        gitBranch: sessions.gitBranch,
        startedAt: sessions.startedAt,
        lastEventAt: sessions.lastEventAt,
        runs: sql<number>`(select count(*) from ${runs} where ${runs.sessionId} = ${sessions.id})::int`,
        costUsd: sql<number | null>`(select sum(${runs.costUsd}) from ${runs} where ${runs.sessionId} = ${sessions.id})`,
      })
      .from(sessions)
      .where(eq(sessions.projectId, c.get("projectId")))
      .orderBy(sql`${sessions.lastEventAt} desc nulls last`)
      .limit(100);
    return c.json({ sessions: rows });
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
