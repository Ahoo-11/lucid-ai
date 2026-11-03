import { describe, expect, it } from "vitest";
import { MUSE_SPARK } from "../src/ai";
import { createApp } from "../src/app";
import type { AppContext } from "../src/context";
import { openDb } from "../src/db";
import type { ChatClient, ChatMessage, ChatRequest } from "../src/ee/arena/llm";
import { LESSONS_HEADER, withLesson } from "../src/fixtest";
import { ensureDefaultProject } from "../src/keys";
import { LiveHub } from "../src/live";

type FixTest = { status: string; lesson: string; revisedFrom?: string | null; results?: { pass: boolean; reason: string; decision: string }[]; standIn?: string | null; reason?: string };
type Issue = { id: string; runs: number; toolName: string | null; fixTest: FixTest | null };

const TOOLS = [
  { type: "function", function: { name: "execute_code", description: "Run Python", parameters: { type: "object", properties: { code: { type: "string" } } } } },
  { type: "function", function: { name: "terminal", description: "Run an approved shell command", parameters: { type: "object", properties: { command: { type: "string" } } } } },
];

/**
 * A stand-in for Muse Spark. Replays: the agent uses the terminal tool only
 * when a lesson in its turn says so. Judge: passes a decision that used it.
 * Rewrite: a lesson that names the terminal tool.
 */
function fakeModel(asked: ChatRequest[]): ChatClient {
  return async (request) => {
    asked.push(request);
    const system = String(request.messages[0]?.content ?? "");
    if (system.startsWith("You improve")) return { text: '{"lesson": "In cron jobs, run commands with the terminal tool, never execute_code."}', latencyMs: 1 };
    if (request.json) {
      const after = String(request.messages[1]!.content).split("## What it did with the fix")[1] ?? "";
      const pass = after.includes("Calls terminal");
      return { text: JSON.stringify({ pass, reason: pass ? "It used the terminal tool instead." : "It still ran execute_code." }), inputTokens: 300, outputTokens: 20, latencyMs: 1 };
    }
    const turn = request.messages.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
    const follows = turn.includes(LESSONS_HEADER) && turn.includes("terminal");
    return { toolCalls: [{ id: "call", name: follows ? "terminal" : "execute_code", input: { command: "git status" } }], inputTokens: 2_000, outputTokens: 30, latencyMs: 1 };
  };
}

async function setup(chat: ChatClient | undefined) {
  const { db } = await openDb();
  const projectId = await ensureDefaultProject(db);
  const ctx: AppContext = {
    db,
    live: new LiveHub(),
    localMode: true,
    defaultProjectId: projectId,
    log: { info() {}, warn() {}, error: console.error },
    chat,
    ai: chat ? { provider: "baseten", model: MUSE_SPARK, onlyModel: true } : undefined,
  };
  const app = createApp(ctx);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> };
  };
  /** A Hermes cron turn on kimi-k2 that ran execute_code and was blocked; replayable when the plugin sent the request. */
  const blockedTurn = (turn: string, ts: number, captured = true) =>
    call("POST", "/v1/hooks/hermes", {
      events: [
        { hook: "pre_llm_call", ts, session_id: `cron-${turn}`, turn_id: turn, user_message: "[cron] Check the repo" },
        {
          hook: "pre_api_request",
          ts,
          session_id: `cron-${turn}`,
          turn_id: turn,
          api_request_id: `${turn}:api`,
          model: "kimi-k2",
          provider: "openrouter",
          started_at: ts,
          tool_names: ["execute_code", "terminal"],
          ...(captured
            ? { tools_hash: "tools-1", tools_def: TOOLS, request: { body: { messages: [{ role: "system", content: "You are Hermes." }, { role: "user", content: "[cron] Check the repo" }], max_tokens: 1000 } } }
            : {}),
        },
        {
          hook: "post_api_request",
          ts: ts + 1,
          session_id: `cron-${turn}`,
          turn_id: turn,
          api_request_id: `${turn}:api`,
          model: "kimi-k2",
          started_at: ts,
          ended_at: ts + 1,
          response: { assistant_message: { content: "", tool_calls: [{ id: `${turn}:c`, type: "function", function: { name: "execute_code", arguments: '{"code": "import subprocess"}' } }] } },
        },
        { hook: "pre_tool_call", ts: ts + 2, session_id: `cron-${turn}`, turn_id: turn, tool_call_id: `${turn}:c`, tool_name: "execute_code", args: '{"code": "import subprocess"}' },
        {
          hook: "post_tool_call",
          ts: ts + 3,
          session_id: `cron-${turn}`,
          turn_id: turn,
          tool_call_id: `${turn}:c`,
          tool_name: "execute_code",
          status: "blocked",
          error_message: "BLOCKED: execute_code runs arbitrary local Python. Cron jobs run without a user present.",
        },
        { hook: "post_llm_call", ts: ts + 4, session_id: `cron-${turn}`, turn_id: turn, assistant_response: "Couldn't run it." },
      ],
    });
  const issue = async () => ((await call("GET", "/api/issues")).body.issues as Issue[]).find((i) => i.toolName === "execute_code")!;
  /** Starts a test and waits for its result. */
  const test = async (id: string, text: string) => {
    expect((await call("POST", `/api/issues/${id}/test`, { text })).body).toMatchObject({ fixTest: { status: "running", lesson: text } });
    for (let i = 0; i < 100; i++) {
      const fixTest = (await issue()).fixTest!;
      if (fixTest.status !== "running") return fixTest;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("The test never finished");
  };
  return { call, blockedTurn, issue, test };
}

describe("testing a fix before it reaches the agent", () => {
  it("replays the decisions that went wrong with the fix where the plugin puts it, and unlocks Apply on a pass", async () => {
    const asked: ChatRequest[] = [];
    const { call, blockedTurn, issue, test } = await setup(fakeModel(asked));
    const t0 = Date.now() / 1000 - 3_600;
    await blockedTurn("t1", t0);
    await blockedTurn("t2", t0 + 60);
    const { id } = await issue();
    const fix = "When running as a cron job, use the terminal tool, never execute_code.";

    const result = await test(id, fix);
    expect(result).toMatchObject({ status: "passed", lesson: fix, revisedFrom: null, standIn: "kimi-k2" });
    expect(result.results).toHaveLength(2);
    expect(result.results!.every((r) => r.pass && r.decision.startsWith("Calls terminal"))).toBe(true);

    // Each replay is the captured request with the fix in the turn's lessons block, on Lucid's model.
    const replays = asked.filter((r) => !r.json);
    expect(replays).toHaveLength(2);
    expect(replays[0]).toMatchObject({ model: MUSE_SPARK, tools: TOOLS });
    expect(replays[0]!.messages.at(-1)!.content).toBe(`[cron] Check the repo\n\n${LESSONS_HEADER}\n- ${fix}`);
    // The judge saw the mistake, the original decision and the new one.
    const judged = String(asked.find((r) => String(r.messages[0]?.content).startsWith("You check whether a fix worked"))!.messages[1]!.content);
    expect(judged).toContain("execute_code");
    expect(judged).toContain('Calls execute_code({"code":"import subprocess"})');

    // Only the words that passed can be applied.
    expect((await call("POST", `/api/issues/${id}/lesson`, { text: `${fix} Always.` })).status).toBe(409);
    expect((await call("POST", `/api/issues/${id}/lesson`, { text: fix })).status).toBe(201);
  });

  it("rewrites a fix that failed, tests it again, and lets only the rewrite through", async () => {
    const asked: ChatRequest[] = [];
    const { call, blockedTurn, issue, test } = await setup(fakeModel(asked));
    await blockedTurn("t1", Date.now() / 1000 - 600);
    await blockedTurn("t2", Date.now() / 1000 - 300);
    const { id } = await issue();

    const result = await test(id, "Be careful with code.");
    expect(result).toMatchObject({ status: "passed", lesson: "In cron jobs, run commands with the terminal tool, never execute_code.", revisedFrom: "Be careful with code." });
    // Two rounds of two replays, each judged, and one rewrite.
    expect(asked.filter((r) => !r.json)).toHaveLength(4);
    expect(asked.filter((r) => String(r.messages[0]?.content).startsWith("You improve"))).toHaveLength(1);
    expect((await call("POST", `/api/issues/${id}/lesson`, { text: "Be careful with code." })).status).toBe(409);
    expect((await call("POST", `/api/issues/${id}/lesson`, { text: result.lesson })).status).toBe(201);
  });

  it("fails when the rewrite doesn't help either", async () => {
    const asked: ChatRequest[] = [];
    const stubborn: ChatClient = async (request) => {
      asked.push(request);
      if (String(request.messages[0]?.content).startsWith("You improve")) return { text: '{"lesson": "Please be even more careful."}', latencyMs: 1 };
      if (request.json) return { text: '{"pass": false, "reason": "It still ran execute_code."}', latencyMs: 1 };
      return { toolCalls: [{ name: "execute_code", input: {} }], latencyMs: 1 };
    };
    const { blockedTurn, issue, test } = await setup(stubborn);
    await blockedTurn("t1", Date.now() / 1000 - 600);
    await blockedTurn("t2", Date.now() / 1000 - 300);
    const result = await test((await issue()).id, "Be careful.");
    expect(result).toMatchObject({ status: "failed", lesson: "Please be even more careful.", revisedFrom: "Be careful." });
    expect(result.results!.map((r) => r.reason)).toEqual(["It still ran execute_code.", "It still ran execute_code."]);
  });

  it("says when nothing can be replayed, and needs a model key", async () => {
    const { call, blockedTurn, issue, test } = await setup(fakeModel([]));
    await blockedTurn("t1", Date.now() / 1000 - 600, false);
    await blockedTurn("t2", Date.now() / 1000 - 300, false);
    const { id } = await issue();
    const result = await test(id, "Use the terminal tool.");
    expect(result).toMatchObject({ status: "untestable" });
    expect(result.reason).toMatch(/weren't captured/);
    expect((await call("POST", `/api/issues/${id}/lesson`, { text: "Use the terminal tool." })).status).toBe(409);

    const off = await setup(undefined);
    await off.blockedTurn("t1", Date.now() / 1000 - 600);
    expect((await off.call("POST", `/api/issues/${(await off.issue()).id}/test`, { text: "x" })).status).toBe(409);
  });

  it("adds the fix to a lessons block that's already in the turn, first", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are Hermes." },
      { role: "user", content: `Check the repo\n\n${LESSONS_HEADER}\n- Older lesson.` },
      { role: "tool", content: "ok", tool_call_id: "c1" },
    ];
    expect(withLesson(messages, "New lesson.")[1]!.content).toBe(`Check the repo\n\n${LESSONS_HEADER}\n- New lesson.\n- Older lesson.`);
    expect(withLesson([{ role: "system", content: "x" }], "Only.")[0]).toEqual({ role: "system", content: `${LESSONS_HEADER}\n- Only.` });
  });
});
