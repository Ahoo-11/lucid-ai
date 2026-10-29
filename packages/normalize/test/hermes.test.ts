import type { NormalizedBatch, StepUpsert } from "@lucid/schema";
import { describe, expect, it } from "vitest";
import { type HermesEvent, normalizeHermesEvents, normalizeHermesHistory } from "../src/index";
import { providerError } from "../src/hermes/events";

const T0 = 1_793_100_000; // epoch seconds, as Hermes sends them
const TURN = "sess-h:task-1:ab12cd34";
const CHILD = "sess-child";

const steps = (batch: NormalizedBatch) => {
  const map = new Map<string, StepUpsert>();
  for (const step of batch.steps) {
    const existing = map.get(step.externalId);
    const defined = Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined));
    map.set(step.externalId, existing ? { ...existing, ...defined, attrs: { ...existing.attrs, ...step.attrs } } : step);
  }
  return map;
};

// What the Lucid plugin forwards for one turn: an API call that picks a tool,
// the tool, a delegated sub-agent (whose events the plugin re-tags), a denied
// approval, a failed retry, and the final answer.
const events: HermesEvent[] = [
  { hook: "on_session_start", ts: T0, session_id: "sess-h", platform: "cli", model: "deepseek/deepseek-v4-flash" },
  { hook: "pre_llm_call", ts: T0 + 1, session_id: "sess-h", turn_id: TURN, user_message: "Find the failing test and fix it", model: "deepseek/deepseek-v4-flash", platform: "cli" },
  {
    hook: "pre_api_request",
    ts: T0 + 1,
    session_id: "sess-h",
    turn_id: TURN,
    api_request_id: `${TURN}:api:1`,
    model: "deepseek/deepseek-v4-flash",
    provider: "openrouter",
    started_at: T0 + 1,
    tool_names: ["search_files", "terminal", "delegate_task"],
    request: { method: "POST", body: { messages: [{ role: "system", content: "You are Hermes" }, { role: "user", content: "Find the failing test and fix it" }], max_tokens: 8000 } },
  },
  {
    hook: "post_api_request",
    ts: T0 + 3,
    session_id: "sess-h",
    turn_id: TURN,
    api_request_id: `${TURN}:api:1`,
    model: "deepseek/deepseek-v4-flash",
    response_model: "deepseek/deepseek-v4-flash-0731",
    started_at: T0 + 1,
    ended_at: T0 + 3,
    api_duration: 2.25,
    finish_reason: "tool_calls",
    usage: { input_tokens: 900, output_tokens: 40, cache_read_tokens: 3000, cache_write_tokens: 0, reasoning_tokens: 12 },
    reasoning: "The test output will tell me which file to open.",
    response: {
      assistant_message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }],
      },
    },
  },
  { hook: "pre_tool_call", ts: T0 + 3, session_id: "sess-h", turn_id: TURN, tool_call_id: "call_1", tool_name: "terminal", args: { command: "npm test" }, api_request_id: `${TURN}:api:1` },
  { hook: "post_tool_call", ts: T0 + 5, session_id: "sess-h", turn_id: TURN, tool_call_id: "call_1", tool_name: "terminal", result: '{"exit_code":1,"output":"1 failing"}', status: "error", error_message: "exit code 1", duration_ms: 1980 },
  { hook: "subagent_start", ts: T0 + 6, parent_session_id: "sess-h", parent_turn_id: TURN, child_session_id: CHILD, child_role: "researcher", child_goal: "Read the test file and explain the failure" },
  // The child's own events, re-tagged by the plugin onto the parent's run.
  { hook: "pre_api_request", ts: T0 + 6, session_id: CHILD, turn_id: "sess-child:t:1", api_request_id: "sess-child:t:1:api:1", model: "deepseek/deepseek-v4-flash", started_at: T0 + 6, lucid_root_turn_id: TURN, lucid_root_session_id: "sess-h", lucid_parent_step: `subagent:${CHILD}` },
  { hook: "post_api_request", ts: T0 + 7, session_id: CHILD, turn_id: "sess-child:t:1", api_request_id: "sess-child:t:1:api:1", started_at: T0 + 6, ended_at: T0 + 7, api_duration: 1, usage: { input_tokens: 100, output_tokens: 20 }, response: { assistant_message: { content: "The assertion expects 3 items." } }, lucid_root_turn_id: TURN, lucid_root_session_id: "sess-h", lucid_parent_step: `subagent:${CHILD}` },
  { hook: "pre_llm_call", ts: T0 + 6, session_id: CHILD, turn_id: "sess-child:t:1", user_message: "Read the test file", lucid_root_turn_id: TURN, lucid_root_session_id: "sess-h", lucid_parent_step: `subagent:${CHILD}` },
  { hook: "subagent_stop", ts: T0 + 8, parent_session_id: "sess-h", parent_turn_id: TURN, child_session_id: CHILD, child_status: "completed", child_summary: "The assertion expects 3 items.", duration_ms: 2000, tool_call_history: [{ tool: "read_file" }] },
  { hook: "pre_approval_request", ts: T0 + 9, command: "rm -rf build", description: "Delete the build folder", session_key: "k", lucid_turn_id: TURN, lucid_approval_id: "approval-1" },
  { hook: "post_approval_response", ts: T0 + 12, command: "rm -rf build", description: "Delete the build folder", choice: "deny", session_key: "k", lucid_turn_id: TURN, lucid_approval_id: "approval-1" },
  { hook: "api_request_error", ts: T0 + 13, session_id: "sess-h", turn_id: TURN, api_request_id: `${TURN}:api:2`, model: "deepseek/deepseek-v4-flash", started_at: T0 + 12, ended_at: T0 + 13, status_code: 429, retry_count: 1, max_retries: 3, error: { type: "RateLimitError", message: "Rate limit exceeded" } },
  { hook: "post_llm_call", ts: T0 + 20, session_id: "sess-h", turn_id: TURN, user_message: "Find the failing test and fix it", assistant_response: "Fixed: the fixture now has 3 items." },
];

describe("Hermes observer events", () => {
  const batch = normalizeHermesEvents(events);
  const byId = steps(batch);

  it("makes one run per turn, in one session, ignoring the sub-agent's own turn hooks", () => {
    expect(batch.runs).toHaveLength(1);
    expect(batch.runs[0]).toMatchObject({
      harness: "hermes",
      externalId: TURN,
      sessionExternalId: "sess-h",
      input: "Find the failing test and fix it",
      output: "Fixed: the fixture now has 3 items.",
      status: "ok",
    });
    expect(batch.sessions.map((s) => s.externalId)).toEqual(["sess-h"]);
  });

  it("joins pre and post API hooks into one LLM step with the decision context", () => {
    expect(byId.get(`${TURN}:api:1`)).toMatchObject({
      kind: "llm",
      status: "ok",
      model: "deepseek/deepseek-v4-flash-0731",
      durationMs: 2250,
      usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 3000 },
      output: { toolCalls: [{ id: "call_1", name: "terminal", input: { command: "npm test" } }] },
      attrs: { availableTools: ["search_files", "terminal", "delegate_task"], reasoning: "The test output will tell me which file to open.", stopReason: "tool_calls", requestParams: { max_tokens: 8000 } },
    });
  });

  it("records failed tool calls with their reason", () => {
    expect(byId.get("call_1")).toMatchObject({ kind: "tool", status: "error", error: "exit code 1", durationMs: 1980, input: { command: "npm test" }, output: { exit_code: 1, output: "1 failing" } });
  });

  it("nests the sub-agent's calls under its step in the parent run", () => {
    expect(byId.get(`subagent:${CHILD}`)).toMatchObject({ kind: "agent", runExternalId: TURN, status: "ok", output: "The assertion expects 3 items.", durationMs: 2000 });
    expect(byId.get("sess-child:t:1:api:1")).toMatchObject({ kind: "llm", runExternalId: TURN, parentExternalId: `subagent:${CHILD}` });
  });

  it("keeps approval decisions, and marks the failed API attempt", () => {
    expect(byId.get("approval-1")).toMatchObject({ kind: "decision", name: "Approval: Delete the build folder", status: "ok", output: "deny", attrs: { permissionDecision: "denied (deny)" } });
    expect(byId.get(`${TURN}:api:2`)).toMatchObject({ kind: "llm", status: "error", error: "HTTP 429: Rate limit exceeded", attrs: { extra: { retry: "1 of 3", statusCode: 429 } } });
    // No second "error" step for the same failure: it would count twice.
    expect([...byId.values()].filter((s) => s.kind === "error")).toHaveLength(0);
  });

  it("marks interrupted and failed turns as failed", () => {
    const interrupted = normalizeHermesEvents([{ hook: "on_session_end", ts: T0, session_id: "s", lucid_turn_id: "t", interrupted: true, completed: false }]);
    expect(interrupted.runs[0]).toMatchObject({ externalId: "t", status: "error" });
    // What Hermes sends when the provider rejects the key before any answer.
    const failed = normalizeHermesEvents([{ hook: "on_session_end", ts: T0, session_id: "s", turn_id: "t2", completed: false, failed: true, interrupted: false, turn_exit_reason: "api_error" }]);
    expect(failed.runs[0]).toMatchObject({ externalId: "t2", status: "error", metadata: { exitReason: "api_error" } });
  });

  it("turns provider error reprs into readable messages", () => {
    expect(providerError("Error code: 401 - {'error': {'message': 'User not found.', 'code': 401}}", 401)).toBe("HTTP 401: User not found.");
    expect(providerError("Error code: 429 - {'error': {'message': 'Rate limit exceeded'}}", undefined)).toBe("HTTP 429: Rate limit exceeded");
    expect(providerError("Connection reset", undefined)).toBe("Connection reset");
    const first = normalizeHermesEvents([{ hook: "api_request_error", ts: T0, turn_id: "t", api_request_id: "t:api:1", retry_count: 0, max_retries: 3, status_code: 401, error: { message: "Error code: 401 - {'error': {'message': 'User not found.'}}" } }]);
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toMatchObject({ kind: "llm", status: "error", error: "HTTP 401: User not found." });
  });

  it("ends the run on an error Hermes will not retry (captured from a real 401)", () => {
    const batch = normalizeHermesEvents([
      { hook: "pre_llm_call", ts: T0, session_id: "s", turn_id: "t", user_message: "Say hi" },
      { hook: "api_request_error", ts: T0 + 2, session_id: "s", turn_id: "t", api_request_id: "t:api:1", retryable: false, reason: "auth", retry_count: 0, max_retries: 3, status_code: 401, error: { message: "User not found." } },
    ]);
    expect(batch.runs[0]).toMatchObject({ externalId: "t", status: "error", metadata: { exitReason: "auth" } });
    // A retryable error leaves the run open: Hermes is about to try again.
    const retrying = normalizeHermesEvents([{ hook: "api_request_error", ts: T0, session_id: "s", turn_id: "t", api_request_id: "t:api:1", retryable: true, retry_count: 1, max_retries: 3 }]);
    expect(retrying.runs).toHaveLength(0);
  });
});

describe("Hermes history (state.db)", () => {
  const batch = normalizeHermesHistory({
    sessions: [
      { id: "20260831_2250_abc", source: "desktop", model: "deepseek/deepseek-v4-flash", started_at: T0, ended_at: T0 + 100, title: "Fix tests", estimated_cost_usd: 0.43 },
      { id: "20260831_2251_child", parent_session_id: "20260831_2250_abc", model: "deepseek/deepseek-v4-flash", started_at: T0 + 30, ended_at: T0 + 40 },
    ],
    messages: [
      { id: 1, session_id: "20260831_2250_abc", role: "user", content: "Run the tests", timestamp: T0 + 1 },
      { id: 2, session_id: "20260831_2250_abc", role: "assistant", content: "", timestamp: T0 + 3, finish_reason: "tool_calls", reasoning: "Run them first.", tool_calls: JSON.stringify([{ id: "call_9", call_id: "call_9", type: "function", function: { name: "terminal", arguments: '{"command":"npm test"}' } }]) },
      { id: 3, session_id: "20260831_2250_abc", role: "tool", tool_call_id: "call_9", tool_name: "terminal", content: '{"error":"npm: not found"}', timestamp: T0 + 4 },
      { id: 4, session_id: "20260831_2250_abc", role: "assistant", content: "npm isn't installed.", timestamp: T0 + 6, finish_reason: "stop" },
      { id: 5, session_id: "20260831_2251_child", role: "user", content: "Check package.json", timestamp: T0 + 30 },
      { id: 6, session_id: "20260831_2251_child", role: "assistant", content: "It uses pnpm.", timestamp: T0 + 35 },
      { id: 7, session_id: "20260831_2250_abc", role: "user", content: "Use pnpm then", timestamp: T0 + 50 },
    ],
  });
  const byId = steps(batch);

  it("turns each user message into a run with the final answer", () => {
    expect(batch.runs.map((r) => r.name)).toEqual(["Run the tests", "Use pnpm then"]);
    expect(batch.runs[0]).toMatchObject({ output: "npm isn't installed.", source: "import", sessionExternalId: "20260831_2250_abc" });
    expect(batch.sessions[0]).toMatchObject({ title: "Fix tests", metadata: { estimatedCostUsd: 0.43, imported: true } });
  });

  it("pairs tool results with the call that asked for them", () => {
    expect(byId.get("call_9")).toMatchObject({ kind: "tool", status: "error", error: "npm: not found", input: { command: "npm test" } });
    expect(byId.get("m2")).toMatchObject({ kind: "llm", attrs: { reasoning: "Run them first.", stopReason: "tool_calls" } });
  });

  it("nests sub-agent sessions under the run active when they started", () => {
    const first = batch.runs[0]!.externalId;
    expect(byId.get("subagent:20260831_2251_child")).toMatchObject({ kind: "agent", runExternalId: first, input: "Check package.json", output: "It uses pnpm." });
    expect(byId.get("m6")).toMatchObject({ runExternalId: first, parentExternalId: "subagent:20260831_2251_child" });
  });
});
