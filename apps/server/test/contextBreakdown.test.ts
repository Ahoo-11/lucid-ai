import { describe, expect, it } from "vitest";
import { type CallInput, contextBreakdown } from "../src/contextBreakdown";

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
});
