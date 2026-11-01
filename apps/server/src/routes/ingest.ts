// Ingestion: OTLP/HTTP (any path ending in /v1/traces|logs|metrics, because
// Codex posts to the URL exactly as configured), Claude Code hooks, and
// transcript uploads from the `lucid` CLI.

import { gunzipSync } from "node:zlib";
import {
  type ClaudeTranscriptFile,
  type ClaudeTranscriptState,
  type HermesMessageRow,
  type HermesSessionRow,
  initialClaudeTranscriptState,
  normalizeClaudeTranscript,
} from "@lucid/normalize";
import { and, eq, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { AppContext, AppEnv } from "../context";
import { schema } from "../db";
import { type Ingest, describeError } from "../ingestService";
import { keyFromHeaders, verifyApiKey } from "../keys";
import { pluginTracker, updateOffer } from "../plugins";
import { batchFor } from "../normalizers";
import { decodeLogs, decodeTraces } from "../otlpProto";
import { LESSON_HARNESSES, deliverLessons } from "../lessons";
import { type SyncReport, reportSync } from "../syncs";

const { runs, sessions, transcriptCursors } = schema;
const MAX_BODY = 32 * 1024 * 1024;
const MAX_UNZIPPED = 128 * 1024 * 1024;

type Signal = "traces" | "logs" | "metrics";

async function readBody(c: Context) {
  const buffer = Buffer.from(await c.req.arrayBuffer());
  if (buffer.byteLength > MAX_BODY) throw new HttpError(413, "Payload too large");
  const encoding = c.req.header("content-encoding")?.toLowerCase();
  if (encoding !== "gzip") return buffer;
  try {
    // Capped: a small gzip body can expand to gigabytes.
    return gunzipSync(buffer, { maxOutputLength: MAX_UNZIPPED });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError(413, "Payload too large once decompressed");
    throw new HttpError(400, `Could not decompress the body: ${(error as Error).message}`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 409 | 413,
    message: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const isProtobuf = (c: Context) => (c.req.header("content-type") ?? "").includes("protobuf");

const UNAUTHORIZED = "Missing or invalid API key. Send it as `Authorization: Bearer <key>` or `x-api-key: <key>`.";

export function ingestRoutes(ctx: AppContext, ingest: Ingest) {
  const app = new Hono<AppEnv>();
  const fileLocks = new Map<string, Promise<unknown>>();
  const { store, commit } = ingest;

  // Only ingest paths need a key: everything else under "/" is the dashboard.
  const authenticate = async (c: Context<AppEnv>) => {
    const key = keyFromHeaders(c.req.raw.headers);
    if (!key && ctx.localMode) {
      c.set("projectId", ctx.defaultProjectId);
      c.set("keyId", "local");
      return ctx.defaultProjectId;
    }
    const row = await verifyApiKey(ctx.db, key);
    if (!row) return null;
    c.set("projectId", row.projectId);
    c.set("keyId", row.id);
    return row.projectId;
  };
  const notePlugin = pluginTracker(ctx.db);
  // Which plugin version sent this (from its User-Agent), for the dashboard's Update button.
  const noteFrom = (c: Context<AppEnv>, harness: string) =>
    notePlugin({ projectId: c.get("projectId"), keyId: c.get("keyId") ?? "local", harness, userAgent: c.req.header("user-agent"), staged: c.req.header("x-lucid-plugin-staged") }).catch((error) =>
      ctx.log.warn(`[plugins] couldn't record a plugin version: ${(error as Error).message}`),
    );

  app.use("/v1/*", async (c, next) => {
    if (!(await authenticate(c))) return c.json({ error: UNAUTHORIZED }, 401);
    return next();
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message, ...error.body }, error.status);
    ctx.log.error(`[ingest] ${c.req.method} ${c.req.path}: ${describeError(error)}`);
    return c.json({ error: "Internal error" }, 500);
  });

  const otlp = async (c: Context<AppEnv>, signal: Signal) => {
    const projectId = c.get("projectId");
    const body = await readBody(c);
    const protobuf = isProtobuf(c);
    // Metrics carry counters we can derive from runs; accept them so exporters
    // stay quiet, but do not store them.
    if (signal !== "metrics") {
      let decoded: unknown;
      try {
        decoded = protobuf
          ? signal === "traces"
            ? decodeTraces(body)
            : decodeLogs(body)
          : JSON.parse(body.toString("utf8") || "{}");
      } catch (error) {
        throw new HttpError(400, `Could not decode OTLP ${signal}: ${(error as Error).message}`);
      }
      const { rawId, payload } = await store(projectId, `otlp_${signal}`, null, decoded);
      await commit(projectId, rawId, () => batchFor(`otlp_${signal}`, null, payload)!, "otel");
    }
    if (protobuf) return c.body(new Uint8Array(0), 200, { "content-type": "application/x-protobuf" });
    return c.json({});
  };

  app.post("*", async (c, next) => {
    const match = /\/v1\/(traces|logs|metrics)\/?$/.exec(c.req.path);
    if (!match) return next();
    // Prefixed OTLP paths (e.g. /otlp/v1/traces) skip the /v1/* middleware.
    if (!c.get("projectId") && !(await authenticate(c))) return c.json({ error: UNAUTHORIZED }, 401);
    return otlp(c, match[1] as Signal);
  });

  // The lessons the owner approved for this agent, which its plugin adds to every turn.
  // Also the plugin's check-in: an Update the owner asked for rides along here.
  app.get("/v1/lessons", async (c) => {
    const harness = c.req.query("harness") ?? "";
    if (!LESSON_HARNESSES.has(harness)) return c.json({ lessons: [] });
    await noteFrom(c, harness);
    const projectId = c.get("projectId");
    const update = await updateOffer(ctx.db, { projectId, keyId: c.get("keyId") ?? "local", harness, userAgent: c.req.header("user-agent") });
    return c.json({ lessons: await deliverLessons(ctx.db, projectId, harness), ...(update ? { update } : {}) });
  });

  // Progress of an upload of past runs: { id, harness, total, done, finished? }.
  app.post("/v1/syncs", async (c) => {
    const result = await reportSync(ctx.db, c.get("projectId"), (await c.req.json().catch(() => ({}))) as SyncReport);
    return "error" in result ? c.json(result, 400) : c.json(result);
  });

  app.post("/v1/hooks/:harness", async (c) => {
    const projectId = c.get("projectId");
    const harness = c.req.param("harness");
    void noteFrom(c, harness);
    const payload = JSON.parse((await readBody(c)).toString("utf8") || "{}");
    const { rawId, payload: clean } = await store(projectId, "hook", harness, payload);
    const batch = batchFor("hook", harness, clean);
    if (batch) await commit(projectId, rawId, () => batch, harness);
    return c.json({ ok: true });
  });

  /**
   * History import from Hermes' state.db: { sessions[], messages[] }.
   * Sessions the plugin already captured live are skipped, so importing after
   * connecting never doubles a conversation.
   */
  app.post("/v1/imports/hermes", async (c) => {
    const projectId = c.get("projectId");
    const body = JSON.parse((await readBody(c)).toString("utf8") || "{}") as { sessions?: HermesSessionRow[]; messages?: HermesMessageRow[] };
    if (!Array.isArray(body.sessions) || !Array.isArray(body.messages)) throw new HttpError(400, "sessions[] and messages[] are required");
    const ids = body.sessions.map((s) => s.id).filter(Boolean);
    const live = ids.length
      ? await ctx.db
          .selectDistinct({ externalId: sessions.externalId })
          .from(sessions)
          .innerJoin(runs, eq(runs.sessionId, sessions.id))
          .where(and(eq(sessions.projectId, projectId), eq(sessions.harness, "hermes"), inArray(sessions.externalId, ids), eq(runs.source, "hook")))
      : [];
    const skip = new Set(live.map((row) => row.externalId));
    // A sub-agent session goes wherever its root goes.
    const parentOf = new Map(body.sessions.map((s) => [s.id, s.parent_session_id ?? undefined]));
    const rootOf = (id: string): string => {
      const parent = parentOf.get(id);
      return parent && parentOf.has(parent) ? rootOf(parent) : id;
    };
    const keep = body.sessions.filter((s) => !skip.has(rootOf(s.id)));
    const keepIds = new Set(keep.map((s) => s.id));
    const payload = { sessions: keep, messages: body.messages.filter((m) => keepIds.has(m.session_id)) };
    if (keep.length === 0) return c.json({ imported: 0, skipped: body.sessions.length, runs: 0 });
    const { rawId, payload: clean } = await store(projectId, "import", "hermes", payload);
    const runIds = await commit(projectId, rawId, () => batchFor("import", "hermes", clean)!, "hermes");
    return c.json({ imported: keep.length, skipped: body.sessions.length - keep.length, runs: runIds.length });
  });

  /**
   * Transcript upload: { harness, fileKey, file, startLine, lines[] }.
   * Lines already processed are skipped, so the CLI can resend safely; a gap
   * gets a 409 with the line the server expects next.
   */
  app.post("/v1/transcripts", async (c) => {
    const projectId = c.get("projectId");
    const body = JSON.parse((await readBody(c)).toString("utf8") || "{}") as {
      harness?: string;
      fileKey?: string;
      file?: ClaudeTranscriptFile;
      startLine?: number;
      lines?: unknown[];
    };
    const harness = body.harness ?? "claude-code";
    if (harness !== "claude-code") throw new HttpError(400, `Transcripts from ${harness} are not supported yet`);
    if (!body.fileKey || !Array.isArray(body.lines)) throw new HttpError(400, "fileKey and lines[] are required");
    const fileKey = body.fileKey;
    const startLine = body.startLine ?? 0;
    const lockKey = `${projectId}\u0000${harness}\u0000${fileKey}`;

    // Uploads for one file are applied strictly in order.
    const previous = fileLocks.get(lockKey) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const [cursor] = await ctx.db
        .select()
        .from(transcriptCursors)
        .where(and(eq(transcriptCursors.projectId, projectId), eq(transcriptCursors.harness, harness), eq(transcriptCursors.fileKey, fileKey)));
      const done = cursor?.lineCount ?? 0;
      if (startLine > done) throw new HttpError(409, "Lines missing before this chunk", { expectedStartLine: done });
      const fresh = body.lines!.slice(done - startLine);
      if (fresh.length === 0) return { lineCount: done, runIds: [] as string[] };

      const { rawId, payload } = await store(projectId, "transcript", harness, { fileKey, file: body.file, startLine: done, lines: fresh });
      const lines = (payload as { lines: unknown[] }).lines;
      const previousState = (cursor?.state as ClaudeTranscriptState | undefined) ?? initialClaudeTranscriptState();
      const result = normalizeClaudeTranscript(lines, body.file ?? { kind: "main" }, previousState);
      const runIds = await commit(projectId, rawId, () => result.batch, harness);
      const lineCount = done + fresh.length;
      await ctx.db
        .insert(transcriptCursors)
        .values({ projectId, harness, fileKey, lineCount, state: result.state as unknown as Record<string, unknown> })
        .onConflictDoUpdate({
          target: [transcriptCursors.projectId, transcriptCursors.harness, transcriptCursors.fileKey],
          set: { lineCount, state: result.state as unknown as Record<string, unknown>, updatedAt: new Date() },
        });
      return { lineCount, runIds };
    });
    fileLocks.set(lockKey, work);
    try {
      const { lineCount, runIds } = await work;
      return c.json({ lineCount, runs: runIds.length });
    } finally {
      if (fileLocks.get(lockKey) === work) fileLocks.delete(lockKey);
    }
  });

  return app;
}
