import { describe, expect, it } from "vitest";
import { type CallInput, type TurnStep, contextBreakdown, rebuildMessages } from "../src/contextBreakdown";

const tool = (name: string, size: number) => ({ type: "function", function: { name, description: "x".repeat(size), parameters: { type: "object", properties: {} } } });
const call = (fields: Partial<CallInput>): CallInput => ({
  stepId: "s1",
  messages: null,
  tools: null,
  inSubAgent: false,
  inputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  ...fields,
});

/** A chat on its second request: two earlier messages, the request, then one tool round. */
const chat = [
  { role: "system", content: `You are an agent.\n\n# Skills\n${"s".repeat(4000)}\n\n# Memory\n${"m".repeat(2000)}` },
  { role: "user", content: "Summarise the repo" },
  { role: "assistant", content: "a".repeat(8000) },
  { role: "user", content: "Update your plugin" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"curl\"}" } }] },
  { role: "tool", tool_call_id: "c1", content: "r".repeat(400) },
];

const part = (result: ReturnType<typeof contextBreakdown>, key: string) => result.parts.find((p) => p.key === key)!;

describe("contextBreakdown", () => {
  it("splits a call into tools, instructions, earlier chat, the request and the work since", () => {
    const result = contextBreakdown([call({ messages: chat, tools: [tool("terminal", 2000), tool("read_file", 400)] })], "Update your plugin");
    expect(result.measured).toBe(false);
    expect(part(result, "history").tokens).toBeGreaterThan(2000);
    expect(part(result, "history").items.map((i) => i.label)).toEqual(["The agent's replies and tool calls", "Earlier requests"]);
    expect(part(result, "request").items).toEqual([{ label: "What you wrote", tokens: 9 }]);
    expect(part(result, "work").items.map((i) => i.label)).toEqual(["Results from terminal", "The agent's replies and tool calls"]);
    expect(part(result, "system").items.map((i) => i.label)).toEqual(["Skills", "Memory", "Opening"]);
    expect(part(result, "tools").items[0]).toMatchObject({ label: "terminal" });
  });

  it("fits the parts to the provider's count, and puts new input at the end of the prompt", () => {
    const counted = { inputTokens: 6000, cacheReadTokens: 4000, cacheWriteTokens: 0 };
    const result = contextBreakdown([call({ messages: chat, tools: [tool("terminal", 2000)], ...counted })], "Update your plugin");
    expect(result.measured).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(9998);
    expect(result.total).toBeLessThanOrEqual(10_002);
    expect(result.newTokens).toBeGreaterThanOrEqual(5998);
    expect(result.newTokens).toBeLessThanOrEqual(6002);
    // The cache holds the start (tools, then instructions), so they're the part not new.
    expect(part(result, "tools").newTokens).toBe(0);
    expect(part(result, "work").newTokens).toBe(part(result, "work").tokens);
  });

  it("gives what's missing to a part that was cut short on capture", () => {
    const cut = [{ role: "system", content: `${"s".repeat(4000)}…[truncated by Lucid]` }, { role: "user", content: "hi" }];
    const result = contextBreakdown([call({ messages: cut, inputTokens: 5000 })], "hi");
    expect(part(result, "system").cut).toBe(true);
    expect(part(result, "system").items.find((i) => i.label === "Cut short when captured")!.tokens).toBeGreaterThan(3900);
    expect(part(result, "request").tokens).toBeLessThan(10);
  });

  it("counts a sub-agent's task as work, and skips calls the provider never counted", () => {
    const sub = call({ stepId: "s2", inSubAgent: true, messages: [{ role: "user", content: "Find the bug" }], inputTokens: 100 });
    const failed = call({ stepId: "s3", messages: chat });
    const missing = call({ stepId: "s4", inputTokens: 50 });
    const result = contextBreakdown([sub, failed, missing], "Fix it");
    expect(result.calls).toBe(1);
    expect(result.uncaptured).toBe(1);
    expect(part(result, "work").items).toEqual([{ label: "The task it was given", tokens: 100 }]);
    expect(part(result, "request").tokens).toBe(0);
  });

  it("names what an agent adds to the request", () => {
    const wrapped = [{ role: "user", content: `Fix it\n\nLessons from your owner, via Lucid (follow them):\n- ${"never run cron jobs ".repeat(10)}` }];
    const result = contextBreakdown([call({ messages: wrapped })], "Fix it");
    expect(part(result, "request").items.map((i) => i.label)).toEqual(["Added by the agent, incl. Lucid's lessons", "What you wrote"]);
  });

  it("gives a rebuilt call's uncounted tokens to the setup the chat doesn't hold", () => {
    const rebuilt = call({ messages: [{ role: "user", content: "Summarise the repo" }], inputTokens: 3000, rebuilt: true });
    const result = contextBreakdown([rebuilt], "Summarise the repo");
    expect(result.rebuilt).toBe(1);
    expect(part(result, "request").tokens).toBeLessThan(10);
    expect(part(result, "system").items).toEqual([{ label: "Instructions and setup (not recorded, sized from the token count)", tokens: expect.any(Number) }]);
    expect(Math.abs(result.total - 3000)).toBeLessThanOrEqual(1);
  });
});

describe("rebuildMessages", () => {
  const step = (fields: Partial<TurnStep> & { stepId: string; kind: string }): TurnStep => ({ parentId: null, toolName: null, toolCallId: null, input: undefined, output: undefined, ...fields });

  it("rebuilds each call of the last turn from the chat before it, and a sub-agent's from its task", () => {
    const earlier = {
      input: "Summarise the repo",
      steps: [
        step({ stepId: "a1", kind: "llm", output: { text: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "README.md" } }] } }),
        step({ stepId: "c1", kind: "tool", toolName: "read_file", toolCallId: "c1", output: "# Lucid" }),
        step({ stepId: "a2", kind: "llm", output: { text: "It's Lucid." } }),
      ],
    };
    const now = {
      input: "Check the tests",
      steps: [
        step({ stepId: "b1", kind: "llm", output: { text: "", toolCalls: [{ id: "c2", name: "delegate_task", input: { goal: "run them" } }] } }),
        step({ stepId: "sub", kind: "agent", input: "Run the tests" }),
        step({ stepId: "s1", kind: "llm", parentId: "sub", output: { text: "All pass." } }),
        step({ stepId: "c2", kind: "agent", toolName: "delegate_task", toolCallId: "c2", output: "All pass." }),
        step({ stepId: "b2", kind: "llm", output: { text: "Tests pass." } }),
      ],
    };
    const rebuilt = rebuildMessages([earlier, now]);
    expect([...rebuilt.keys()]).toEqual(["b1", "s1", "b2"]);
    expect(rebuilt.get("b1")).toEqual([
      { role: "user", content: "Summarise the repo" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "# Lucid" },
      { role: "assistant", content: "It's Lucid." },
      { role: "user", content: "Check the tests" },
    ]);
    expect(rebuilt.get("s1")).toEqual([{ role: "user", content: "Run the tests" }]);
    // The sub-agent's own work isn't in the main chat; its result is.
    expect(rebuilt.get("b2")!.slice(-2)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "delegate_task", arguments: '{"goal":"run them"}' } }] },
      { role: "tool", tool_call_id: "c2", name: "delegate_task", content: "All pass." },
    ]);
  });
});
