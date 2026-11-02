import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb, schema } from "../src/db";
import { createApiKey, ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";
import { encodeTraces } from "../src/otlpProto";

const fixtures = join(import.meta.dirname, "../../../packages/normalize/test/fixtures");
const lines = (name: string) =>
  readFileSync(join(fixtures, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

type RunRow = { id: string; name: string; status: string; costUsd: number | null; llmCallCount: number; toolCallCount: number; errorCount: number };
type StepRow = { externalId: string; kind: string; status: string; costUsd: number | null; costSource: string | null; durationMs: number | null; parentExternalId: string | null; error: string | null };

async function setup(localMode = true) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const live = new LiveHub();
  const ctx: AppContext = { db, live, localMode, defaultProjectId: projectId, log: { info() {}, warn() {}, error: console.error } };
  const app = createApp(ctx);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const get = async <T>(path: string) => (await (await app.request(path)).json()) as T;
  return { app, db, projectId, live, post, get };
}

describe("ingest → runs", () => {
  let env: Awaited<ReturnType<typeof setup>>;
  const main = lines("claude-session.jsonl");

  beforeAll(async () => {
    env = await setup();
  });

  it("accepts a transcript in two chunks and resends without duplicates", async () => {
    const first = await env.post("/v1/transcripts", { harness: "claude-code", fileKey: "sess-1", file: { kind: "main" }, startLine: 0, lines: main.slice(0, 6) });
    expect(await first.json()).toMatchObject({ lineCount: 6 });
    // Overlapping resend: lines 4..end. The server skips what it already has.
    const second = await env.post("/v1/transcripts", { harness: "claude-code", fileKey: "sess-1", file: { kind: "main" }, startLine: 4, lines: main.slice(4) });
    expect(await second.json()).toMatchObject({ lineCount: main.length });
    const gap = await env.post("/v1/transcripts", { harness: "claude-code", fileKey: "sess-1", file: { kind: "main" }, startLine: 99, lines: [{}] });
    expect(gap.status).toBe(409);
    expect(await gap.json()).toMatchObject({ expectedStartLine: main.length });

    const { runs } = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(runs.map((run) => run.name).sort()).toEqual(["Count the lines in README.md", "Explore the repo for tests"]);
    const count = runs.find((run) => run.name.startsWith("Count"))!;
    expect(count).toMatchObject({ status: "ok", llmCallCount: 3, toolCallCount: 2, errorCount: 1 });
  });

  it("attaches the sub-agent transcript under its Agent step", async () => {
    const sub = lines("claude-subagent.jsonl");
    await env.post("/v1/transcripts", {
      harness: "claude-code",
      fileKey: "sess-1/agent-a",
      file: { kind: "subagent", agentId: "agent-a", parentToolUseId: "toolu_3", description: "Find the test files" },
      startLine: 0,
      lines: sub,
    });
    const { runs } = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(runs).toHaveLength(2);
    const explore = runs.find((run) => run.name.startsWith("Explore"))!;
    const detail = await env.get<{ steps: StepRow[] }>(`/api/runs/${explore.id}`);
    expect(detail.steps.find((s) => s.externalId === "toolu_3")).toMatchObject({ kind: "agent", status: "ok" });
    expect(detail.steps.find((s) => s.externalId === "req_s1")).toMatchObject({ kind: "llm", parentExternalId: "toolu_3" });
  });

  it("merges hooks and OTel events into the same run instead of duplicating steps", async () => {
    await env.post("/v1/hooks/claude-code", {
      hook_event_name: "PostToolUseFailure",
      session_id: "sess-1",
      prompt_id: "prompt-1",
      tool_name: "Bash",
      tool_use_id: "toolu_2",
      error: "wc: command not found",
      duration_ms: 31,
    });
    const nanos = `${BigInt(Date.parse("2026-10-27T10:00:02.500Z")) * 1_000_000n}`;
    const attr = (key: string, value: string | number) => ({ key, value: typeof value === "string" ? { stringValue: value } : { doubleValue: value } });
    await env.post("/v1/logs", {
      resourceLogs: [
        {
          resource: { attributes: [attr("service.name", "claude-code")] },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: nanos,
                  body: { stringValue: "claude_code.api_request" },
                  attributes: [attr("event.name", "api_request"), attr("session.id", "sess-1"), attr("prompt.id", "prompt-1"), attr("request_id", "req_1"), attr("model", "claude-sonnet-4-5"), attr("cost_usd", 0.0123), attr("duration_ms", 2300)],
                },
              ],
            },
          ],
        },
      ],
    });
    const { runs } = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(runs).toHaveLength(2);
    const count = runs.find((run) => run.name.startsWith("Count"))!;
    expect(count.llmCallCount).toBe(3);
    expect(count.costUsd).toBeCloseTo(0.0123);
    const detail = await env.get<{ steps: StepRow[] }>(`/api/runs/${count.id}`);
    expect(detail.steps.find((s) => s.externalId === "req_1")).toMatchObject({ costSource: "reported", durationMs: 2300 });
    expect(detail.steps.find((s) => s.externalId === "toolu_2")).toMatchObject({ status: "error", durationMs: 31 });
  });

  it("decodes OTLP protobuf traces", async () => {
    const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
    const body = encodeTraces({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "support-bot" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: hex(7, 32),
                  spanId: hex(1, 16),
                  name: "chat gpt-5-mini",
                  startTimeUnixNano: "1793095200000000000",
                  endTimeUnixNano: "1793095201000000000",
                  attributes: [
                    { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-5-mini" } },
                    { key: "gen_ai.input.messages", value: { stringValue: JSON.stringify([{ role: "user", content: "Hello from protobuf" }]) } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const response = await env.app.request("/otlp/v1/traces", {
      method: "POST",
      body: Buffer.from(body),
      headers: { "content-type": "application/x-protobuf" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("protobuf");
    const { runs } = await env.get<{ runs: (RunRow & { harness: string })[] }>("/api/runs?harness=support-bot");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: "Hello from protobuf", status: "ok" });
  });

  it("filters runs by status and search text", async () => {
    const errors = await env.get<{ runs: RunRow[] }>("/api/runs?status=error");
    expect(errors.runs.map((run) => run.name)).toEqual(["Count the lines in README.md"]);
    const search = await env.get<{ runs: RunRow[] }>("/api/runs?q=protobuf");
    expect(search.runs).toHaveLength(1);
  });

  it("stores transcripts that contain NUL characters (binary tool output)", async () => {
    const nul = String.fromCharCode(0);
    const response = await env.post("/v1/transcripts", {
      harness: "claude-code",
      fileKey: "sess-nul",
      file: { kind: "main" },
      startLine: 0,
      lines: [
        { type: "user", promptId: "p-nul", sessionId: "sess-nul", timestamp: "2026-10-27T12:00:00Z", message: { role: "user", content: `read the binary${nul}file` } },
        { type: "assistant", requestId: "req_nul", sessionId: "sess-nul", timestamp: "2026-10-27T12:00:01Z", message: { id: "m", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_nul", name: "Read", input: { file_path: "a.bin" } }] } },
        { type: "user", promptId: "p-nul", sessionId: "sess-nul", timestamp: "2026-10-27T12:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_nul", content: `PK${nul}${nul}\u0003\u0004` }] } },
      ],
    });
    expect(response.status).toBe(200);
    const { runs } = await env.get<{ runs: RunRow[] }>("/api/runs?q=binary");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.name).toBe("read the binary�file");
  });

  it("publishes live updates", async () => {
    const seen: string[][] = [];
    const stop = env.live.subscribe(env.projectId, (runIds) => seen.push(runIds));
    await env.post("/v1/hooks/claude-code", { hook_event_name: "Stop", session_id: "sess-1", prompt_id: "prompt-2", last_assistant_message: "Done" });
    stop();
    expect(seen).toHaveLength(1);
  });
});

describe("Hermes", () => {
  const T0 = 1_793_100_000;
  const TURN = "sess-h:task:1";
  it("turns plugin batches into a run, and skips imported sessions it already has live", async () => {
    const env = await setup();
    const response = await env.post("/v1/hooks/hermes", {
      events: [
        { hook: "pre_llm_call", ts: T0, session_id: "sess-h", turn_id: TURN, user_message: "Summarize the repo" },
        { hook: "pre_api_request", ts: T0, session_id: "sess-h", turn_id: TURN, api_request_id: `${TURN}:api:1`, model: "gpt-4o-mini", provider: "openrouter", started_at: T0, tool_names: ["read_file"] },
        { hook: "post_api_request", ts: T0 + 2, session_id: "sess-h", turn_id: TURN, api_request_id: `${TURN}:api:1`, model: "gpt-4o-mini", started_at: T0, ended_at: T0 + 2, api_duration: 2, usage: { input_tokens: 1_000_000, output_tokens: 0 }, response: { assistant_message: { content: "It is a monorepo." } } },
        { hook: "post_llm_call", ts: T0 + 3, session_id: "sess-h", turn_id: TURN, assistant_response: "It is a monorepo." },
      ],
    });
    expect(response.status).toBe(200);
    const { runs } = await env.get<{ runs: (RunRow & { harness: string })[] }>("/api/runs");
    expect(runs).toHaveLength(1);
    // Priced from the seed table: 1M input tokens of gpt-4o-mini.
    expect(runs[0]).toMatchObject({ harness: "hermes", name: "Summarize the repo", status: "ok", llmCallCount: 1 });
    expect(runs[0]!.costUsd).toBeCloseTo(0.15);

    const imported = await env.post("/v1/imports/hermes", {
      sessions: [
        { id: "sess-h", started_at: T0 },
        { id: "sess-old", started_at: T0 - 1000, title: "Older chat" },
      ],
      messages: [
        { id: 1, session_id: "sess-h", role: "user", content: "Summarize the repo", timestamp: T0 },
        { id: 2, session_id: "sess-old", role: "user", content: "Hello Hermes", timestamp: T0 - 999 },
        { id: 3, session_id: "sess-old", role: "assistant", content: "Hi!", timestamp: T0 - 998 },
      ],
    });
    expect(await imported.json()).toMatchObject({ imported: 1, skipped: 1, runs: 1 });
    const after = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(after.runs.map((run) => run.name).sort()).toEqual(["Hello Hermes", "Summarize the repo"]);

    // Replaying stored events through the normalizers changes nothing when nothing changed.
    const replay = await env.post("/api/reprocess", { harness: "hermes" });
    expect(await replay.json()).toMatchObject({ replayed: 2, runs: 2 });
    const again = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(again.runs).toHaveLength(2);
    expect(again.runs.find((run) => run.name === "Summarize the repo")).toMatchObject({ status: "ok", llmCallCount: 1 });

    // A rebuild starts the harness over from its raw events and ends up identical.
    const rebuilt = await env.post("/api/reprocess", { harness: "hermes", rebuild: true });
    expect(await rebuilt.json()).toMatchObject({ replayed: 2, runs: 2 });
    const fresh = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(fresh.runs.map((run) => run.name).sort()).toEqual(["Hello Hermes", "Summarize the repo"]);
    expect((await env.post("/api/reprocess", { harness: "claude-code", rebuild: true })).status).toBe(400);
  });

  it("accepts gzipped batches and refuses bodies that inflate past the cap", async () => {
    const env = await setup();
    const events = [{ hook: "pre_llm_call", ts: T0, session_id: "sess-gz", turn_id: "sess-gz:task:1", user_message: "Compressed hello" }];
    const zipped = await env.app.request("/v1/hooks/hermes", {
      method: "POST",
      body: gzipSync(JSON.stringify({ events })),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(zipped.status).toBe(200);
    const { runs } = await env.get<{ runs: RunRow[] }>("/api/runs");
    expect(runs.map((run) => run.name)).toEqual(["Compressed hello"]);

    // ~130 MB of zeros compresses to ~130 KB.
    const bomb = await env.app.request("/v1/hooks/hermes", {
      method: "POST",
      body: gzipSync(Buffer.alloc(130 * 1024 * 1024)),
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(bomb.status).toBe(413);
    const garbage = await env.app.request("/v1/hooks/hermes", {
      method: "POST",
      body: "not gzip at all",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
    expect(garbage.status).toBe(400);
  });
});

describe("redaction", () => {
  const KEY = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  // An agent that cats a .env: the secrets must not reach the raw copy, the run, or its steps.
  const leaky = (session: string) => [
    { type: "user", promptId: `p-${session}`, sessionId: session, timestamp: "2026-10-27T12:00:00Z", message: { role: "user", content: "Why does the deploy fail?" } },
    { type: "assistant", requestId: `req-${session}`, sessionId: session, timestamp: "2026-10-27T12:00:01Z", message: { id: "m", role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: `toolu-${session}`, name: "Bash", input: { command: "cat .env" } }] } },
    { type: "user", promptId: `p-${session}`, sessionId: session, timestamp: "2026-10-27T12:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu-${session}`, content: `ANTHROPIC_API_KEY=${KEY}\nDB_PASSWORD=hunter2hunter2\nADMIN_EMAIL=ops@example.com` }] } },
  ];
  const everything = async (env: Awaited<ReturnType<typeof setup>>) => {
    const raw = await env.db.select({ payload: schema.rawEvents.payload }).from(schema.rawEvents);
    const steps = await env.db.select({ input: schema.steps.inputPreview, output: schema.steps.outputPreview }).from(schema.steps);
    const blobs = await env.db.select({ content: schema.blobs.content }).from(schema.blobs);
    return JSON.stringify([raw, steps, blobs]);
  };

  it("scrubs secrets by default and keeps the rest readable", async () => {
    const env = await setup();
    expect((await env.post("/v1/transcripts", { harness: "claude-code", fileKey: "leak", file: { kind: "main" }, startLine: 0, lines: leaky("leak") })).status).toBe(200);
    const stored = await everything(env);
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain("hunter2hunter2");
    expect(stored).toContain("<SECRET_1>");
    // Not secrets: the email and the run itself are kept.
    expect(stored).toContain("ops@example.com");
    expect((await env.get<{ runs: RunRow[] }>("/api/runs")).runs.map((run) => run.name)).toEqual(["Why does the deploy fail?"]);
  });

  it("stores as received for a project that turned redaction off", async () => {
    const env = await setup();
    await env.db.update(schema.projects).set({ redaction: { categories: [] } }).where(eq(schema.projects.id, env.projectId));
    await env.post("/v1/transcripts", { harness: "claude-code", fileKey: "kept", file: { kind: "main" }, startLine: 0, lines: leaky("kept") });
    expect(await everything(env)).toContain(KEY);
  });
});

describe("usage", () => {
  type Sums = { runs: number; costUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; llmCalls: number };
  type Split = { input: number; cacheRead: number; cacheWrite: number; output: number } | null;
  type Usage = {
    totals: Sums & { unpricedRuns: number; split: Split };
    hours: (Sums & { at: string })[];
    agents: (Sums & { harness: string })[];
    models: { model: string; calls: number; unpriced: number; split: Split }[];
    top: { id: string }[];
  };

  it("adds up spend and tokens by hour, agent and model, and splits the cost by kind of token", async () => {
    const env = await setup();
    const now = new Date();
    const run = (id: string, harness: string, startedAt: Date, extra: Partial<typeof schema.runs.$inferInsert>) => ({ id, projectId: env.projectId, harness, externalId: id, source: "hook", status: "ok", startedAt, ...extra });
    await env.db.insert(schema.runs).values([
      run("r1", "hermes", now, { costUsd: 0.5, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, llmCallCount: 2 }),
      run("r2", "claude-code", now, { costUsd: 0.25, inputTokens: 100, outputTokens: 50, llmCallCount: 1, costIncomplete: 1 }),
      run("old", "hermes", new Date(Date.now() - 10 * 86_400_000), { costUsd: 9 }),
    ]);
    const step = (id: string, runId: string, extra: Partial<typeof schema.steps.$inferInsert>) => ({ id, projectId: env.projectId, runId, externalId: id, kind: "llm", name: "call", startedAt: now, ...extra });
    await env.db.insert(schema.steps).values([
      step("s1", "r1", { model: "gpt-4o", provider: "openai", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, costUsd: 0.5 }),
      step("s2", "r2", { model: "mystery-model", inputTokens: 100, outputTokens: 50 }),
    ]);

    const week = await env.get<Usage>("/api/usage?days=7");
    expect(week.totals).toMatchObject({ runs: 2, costUsd: 0.75, inputTokens: 1100, outputTokens: 250, cacheReadTokens: 5000, llmCalls: 3, unpricedRuns: 1 });
    expect(week.hours).toHaveLength(1);
    expect(week.hours[0]!.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
    expect(week.agents.map((a) => a.harness)).toEqual(["hermes", "claude-code"]);
    expect(week.top.map((r) => r.id)).toEqual(["r1", "r2"]);
    // gpt-4o at its list price ($2.50 in, $10 out per million; cache reads at the input price without a cache rate).
    const split = week.models.find((m) => m.model === "gpt-4o")!.split!;
    expect(split.input).toBeCloseTo(0.0025);
    expect(split.cacheRead).toBeCloseTo(0.0125);
    expect(split.output).toBeCloseTo(0.002);
    expect(week.models.find((m) => m.model === "mystery-model")).toMatchObject({ calls: 1, unpriced: 1, split: null });
    expect(week.totals.split!.input).toBeCloseTo(0.0025);

    expect((await env.get<Usage>("/api/usage?days=30")).totals.costUsd).toBeCloseTo(9.75);
    // Anything else is a week.
    expect((await env.get<Usage>("/api/usage?days=9999")).totals.runs).toBe(2);
  });
});

describe("ingest auth", () => {
  it("requires a key outside local mode and accepts a valid one", async () => {
    const env = await setup(false);
    const denied = await env.post("/v1/hooks/claude-code", { hook_event_name: "Stop", session_id: "s" });
    expect(denied.status).toBe(401);
    const { key } = await createApiKey(env.db, env.projectId, "test");
    const ok = await env.post("/v1/hooks/claude-code", { hook_event_name: "Stop", session_id: "s" }, { authorization: `Bearer ${key}` });
    expect(ok.status).toBe(200);
    const wrong = await env.post("/v1/hooks/claude-code", {}, { "x-api-key": "lucid_live_nope" });
    expect(wrong.status).toBe(401);
  });
});
