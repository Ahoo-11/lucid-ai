import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedBatch, StepUpsert } from "@lucid/schema";
import { describe, expect, it } from "vitest";
import { initialClaudeTranscriptState, normalizeClaudeHook, normalizeClaudeTranscript } from "../src/index";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

const main = fixture("claude-session.jsonl");
const sub = fixture("claude-subagent.jsonl");

const stepMap = (batch: NormalizedBatch) => {
  // Same merge rule as the server: later defined fields win, attrs merge.
  const map = new Map<string, StepUpsert>();
  for (const step of batch.steps) {
    const existing = map.get(step.externalId);
    const defined = Object.fromEntries(Object.entries(step).filter(([, value]) => value !== undefined));
    map.set(step.externalId, existing ? { ...existing, ...defined, attrs: { ...existing.attrs, ...step.attrs } } : step);
  }
  return map;
};

describe("Claude Code transcript", () => {
  const { batch } = normalizeClaudeTranscript(main, { kind: "main" });
  const steps = stepMap(batch);

  it("creates one session with its title and one run per prompt", () => {
    expect(batch.sessions).toHaveLength(1);
    expect(batch.sessions[0]).toMatchObject({ externalId: "sess-1", title: "Fix the login test", cwd: "/repo", gitBranch: "main" });
    const runs = Object.fromEntries(batch.runs.map((run) => [run.externalId, run]));
    expect(runs["prompt-1"]).toMatchObject({
      input: "Count the lines in README.md",
      status: "ok",
      output: "README.md has 3 lines.",
      model: "claude-sonnet-4-5",
      sessionExternalId: "sess-1",
    });
    expect(runs["prompt-1"]?.systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(runs["prompt-2"]).toMatchObject({ input: "Explore the repo for tests", status: "running" });
  });

  it("builds an LLM step per request with the decision context", () => {
    const llm = steps.get("req_1");
    expect(llm).toMatchObject({ kind: "llm", model: "claude-sonnet-4-5", runExternalId: "prompt-1" });
    expect(llm?.attrs?.availableTools).toEqual(["Read", "Bash", "Agent"]);
    expect(llm?.attrs?.reasoning).toContain("I should read the file first.");
    expect(llm?.attrs?.requestParams).toMatchObject({ max_tokens: 32000, effort: "high" });
    expect(llm?.usage).toMatchObject({ inputTokens: 10, outputTokens: 55, cacheReadTokens: 1000, cacheWriteTokens: 200 });
    expect(llm?.startedAt?.toISOString()).toBe("2026-10-27T10:00:00.200Z");
    expect(llm?.output).toMatchObject({ toolCalls: [{ id: "toolu_1", name: "Read" }] });
  });

  it("pairs tool calls with their results", () => {
    expect(steps.get("toolu_1")).toMatchObject({ kind: "tool", status: "ok", toolName: "Read", output: "line one\nline two\nline three" });
    expect(steps.get("toolu_1")?.attrs?.permissionDecision).toBe("accept");
    expect(steps.get("toolu_2")).toMatchObject({ status: "error", error: "wc: command not found" });
  });

  it("keeps an async sub-agent running until its own transcript finishes", () => {
    expect(steps.get("toolu_3")).toMatchObject({ kind: "agent", name: "Find the test files", status: "running" });
    const subResult = normalizeClaudeTranscript(sub, {
      kind: "subagent",
      agentId: "agent-a",
      parentToolUseId: "toolu_3",
      description: "Find the test files",
    });
    const subSteps = stepMap(subResult.batch);
    expect(subSteps.get("req_s1")).toMatchObject({ kind: "llm", runExternalId: "prompt-2", parentExternalId: "toolu_3", model: "claude-haiku-4-5" });
    expect(subSteps.get("toolu_3")).toMatchObject({ kind: "agent", status: "ok", output: "Found 4 test files." });
    expect(subResult.batch.runs).toHaveLength(0);
  });

  it("gives the same result when the file arrives in chunks", () => {
    for (const cut of [1, 4, 5, 6, 9, 12]) {
      const first = normalizeClaudeTranscript(main.slice(0, cut), { kind: "main" });
      const second = normalizeClaudeTranscript(main.slice(cut), { kind: "main" }, first.state);
      const chunked = stepMap({ sessions: [], runs: [], steps: [...first.batch.steps, ...second.batch.steps] });
      for (const [key, step] of steps) {
        const other = chunked.get(key);
        expect(other, `step ${key} after cut ${cut}`).toBeDefined();
        expect({ ...other, seq: undefined }).toMatchObject({ ...step, seq: undefined });
      }
    }
  });

  it("survives a JSON round trip of its state", () => {
    const first = normalizeClaudeTranscript(main.slice(0, 5), { kind: "main" });
    const restored = JSON.parse(JSON.stringify(first.state)) as typeof first.state;
    const second = normalizeClaudeTranscript(main.slice(5), { kind: "main" }, restored);
    expect(stepMap(second.batch).get("req_1")?.attrs?.availableTools).toEqual(["Read", "Bash", "Agent"]);
  });

  it("ignores garbage lines", () => {
    expect(() => normalizeClaudeTranscript([null, 3, "x", { type: "assistant" }], { kind: "main" }, initialClaudeTranscriptState())).not.toThrow();
  });
});

describe("Claude Code hooks", () => {
  it("maps a tool failure onto the transcript's tool step key", () => {
    const batch = normalizeClaudeHook({
      hook_event_name: "PostToolUseFailure",
      session_id: "sess-1",
      prompt_id: "prompt-1",
      tool_name: "Bash",
      tool_use_id: "toolu_2",
      tool_input: { command: "wc -l README.md" },
      error: "exit 127",
      duration_ms: 31,
    });
    expect(batch.steps[0]).toMatchObject({ externalId: "toolu_2", runExternalId: "prompt-1", status: "error", error: "exit 127", durationMs: 31 });
  });

  it("opens a run on UserPromptSubmit and closes it on Stop", () => {
    const open = normalizeClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p", prompt: "hello" });
    expect(open.runs[0]).toMatchObject({ externalId: "p", input: "hello", status: "running" });
    const stop = normalizeClaudeHook({ hook_event_name: "Stop", session_id: "s", prompt_id: "p", last_assistant_message: "hi" });
    expect(stop.runs[0]).toMatchObject({ externalId: "p", status: "ok", output: "hi" });
  });

  it("does nothing without a session id", () => {
    expect(normalizeClaudeHook({ hook_event_name: "Stop" })).toEqual({ sessions: [], runs: [], steps: [] });
  });
});
