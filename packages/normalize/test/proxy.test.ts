import type { NormalizedBatch, StepUpsert } from "@lucid/schema";
import { describe, expect, it } from "vitest";
import { type ProxyExchange, assembleStream, canonicalRequest, normalizeProxyExchange, withoutBlobs } from "../src/index";

const TOOLS = [{ type: "function", function: { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
const SYSTEM = { role: "system", content: "You are a travel agent." };
const USER = { role: "user", content: "Should I pack an umbrella for Paris?" };
const CALL = { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] };

const exchange = (patch: Partial<ProxyExchange>): ProxyExchange => ({
  provider: "openrouter",
  api: "openai-chat",
  request: {},
  response: {},
  status: 200,
  startedAt: "2026-10-28T12:00:00.000Z",
  endedAt: "2026-10-28T12:00:02.000Z",
  ...patch,
});

const merged = (...batches: NormalizedBatch[]) => {
  const steps = new Map<string, StepUpsert>();
  for (const step of batches.flatMap((b) => b.steps)) {
    const prev = steps.get(step.externalId);
    const defined = Object.fromEntries(Object.entries(step).filter(([, v]) => v !== undefined));
    steps.set(step.externalId, prev ? { ...prev, ...defined, attrs: { ...prev.attrs, ...step.attrs } } : step);
  }
  return steps;
};

describe("proxy: an OpenAI-style tool loop", () => {
  // Call 1: the model asks for a tool. Call 2: the agent sends the result back.
  const first = normalizeProxyExchange(
    exchange({
      request: { model: "openai/gpt-5-mini", messages: [SYSTEM, USER], tools: TOOLS, max_tokens: 500 },
      response: {
        id: "gen-1",
        model: "openai/gpt-5-mini",
        choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: CALL.tool_calls } }],
        usage: { prompt_tokens: 1200, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 1000 }, cost: 0.00042 },
      },
    }),
  );
  const second = normalizeProxyExchange(
    exchange({
      startedAt: "2026-10-28T12:00:03.000Z",
      endedAt: "2026-10-28T12:00:04.000Z",
      request: { model: "openai/gpt-5-mini", messages: [SYSTEM, USER, CALL, { role: "tool", tool_call_id: "call_1", content: '{"rain":0.8}' }], tools: TOOLS },
      response: { id: "gen-2", model: "openai/gpt-5-mini", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Yes, 80% chance of rain." } }], usage: { prompt_tokens: 1300, completion_tokens: 9 } },
    }),
  );
  const steps = merged(first, second);

  it("groups both calls into one run of one session", () => {
    expect(first.runs[0]!.externalId).toBe(second.runs[0]!.externalId);
    expect(first.sessions[0]!.externalId).toBe(second.sessions[0]!.externalId);
    expect(first.runs[0]).toMatchObject({ harness: "proxy", input: "Should I pack an umbrella for Paris?", status: "running" });
    expect(second.runs[0]).toMatchObject({ status: "ok", output: "Yes, 80% chance of rain." });
  });

  it("keeps the exact request on the LLM step, for replay", () => {
    const llm = steps.get("gen-1")!;
    expect(llm).toMatchObject({ kind: "llm", model: "openai/gpt-5-mini", reportedCostUsd: 0.00042, usage: { inputTokens: 200, cacheReadTokens: 1000, outputTokens: 20 } });
    expect((llm.input as unknown[]).length).toBe(2);
    expect(llm.attrs).toMatchObject({ availableTools: ["get_weather"], toolsRef: expect.stringMatching(/^tools:proxy:/), requestParams: { max_tokens: 500 }, stopReason: "tool_calls" });
    expect(first.blobs?.[0]?.content).toEqual(TOOLS);
  });

  it("opens the tool step on the call and completes it with the agent's result", () => {
    expect(first.steps.find((s) => s.externalId === "call_1")).toMatchObject({ status: "running", input: { city: "Paris" } });
    expect(steps.get("call_1")).toMatchObject({ kind: "tool", name: "get_weather", status: "ok", output: { rain: 0.8 } });
  });

  it("starts a new run when the person writes again, in the same session", () => {
    const next = normalizeProxyExchange(
      exchange({ request: { messages: [SYSTEM, USER, CALL, { role: "tool", tool_call_id: "call_1", content: "{}" }, { role: "assistant", content: "Yes." }, { role: "user", content: "And Rome?" }] }, response: { choices: [] } }),
    );
    expect(next.runs[0]!.externalId).not.toBe(first.runs[0]!.externalId);
    expect(next.sessions[0]!.externalId).toBe(first.sessions[0]!.externalId);
    expect(next.runs[0]!.input).toBe("And Rome?");
  });

  it("honours explicit grouping headers and marks upstream errors", () => {
    const failed = normalizeProxyExchange(exchange({ session: "s-42", run: "r-7", agent: "support-bot", status: 401, request: { messages: [USER] }, response: { error: { message: "Invalid API key" } } }));
    expect(failed.runs[0]).toMatchObject({ externalId: "r-7", sessionExternalId: "s-42", harness: "support-bot", status: "error" });
    expect(failed.steps[0]).toMatchObject({ status: "error", error: "HTTP 401: Invalid API key" });
  });
});

describe("proxy: Anthropic Messages", () => {
  const request = {
    model: "claude-haiku-4-5",
    system: [{ type: "text", text: "You are a coding agent." }],
    tools: [{ name: "read_file", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
    messages: [
      { role: "user", content: "What's in notes.txt?" },
      { role: "assistant", content: [{ type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "notes.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "buy milk" }] },
    ],
    max_tokens: 1024,
  };

  it("converts to the common shape the Arena replays", () => {
    const canonical = canonicalRequest("anthropic-messages", request);
    expect(canonical.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(canonical.messages[2]!.tool_calls![0]).toEqual({ id: "toolu_1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } });
    expect(canonical.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }]);
  });

  it("treats a tool-result message as the agent's, not a new request", () => {
    const batch = normalizeProxyExchange(
      exchange({
        api: "anthropic-messages",
        provider: "anthropic",
        request,
        response: { id: "msg_2", model: "claude-haiku-4-5", content: [{ type: "text", text: "It says: buy milk." }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 900 } },
      }),
    );
    expect(batch.runs[0]).toMatchObject({ input: "What's in notes.txt?", status: "ok", output: "It says: buy milk." });
    expect(batch.steps.find((s) => s.externalId === "toolu_1")).toMatchObject({ status: "ok", output: "buy milk" });
    expect(batch.steps[0]).toMatchObject({ usage: { inputTokens: 50, cacheReadTokens: 900 } });
  });
});

describe("proxy: streamed replies", () => {
  it("rebuilds an OpenAI stream, tool-call fragments included", () => {
    const sse = [
      { id: "gen-9", model: "m", choices: [{ delta: { role: "assistant", content: "" } }] },
      { id: "gen-9", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "get_weather", arguments: '{"ci' } }] } }] },
      { id: "gen-9", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Oslo"}' } }] }, finish_reason: "tool_calls" }] },
      { id: "gen-9", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join("")
      .concat("data: [DONE]\n\n");
    expect(assembleStream("openai-chat", sse)).toMatchObject({
      id: "gen-9",
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "call_9", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } }] } }],
      usage: { prompt_tokens: 10 },
    });
  });

  it("rebuilds an Anthropic stream", () => {
    const events = [
      { type: "message_start", message: { id: "msg_9", model: "claude", usage: { input_tokens: 30, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_9", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.md"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    expect(assembleStream("anthropic-messages", sse)).toMatchObject({
      id: "msg_9",
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 12 },
      content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_9", input: { path: "a.md" } }],
    });
  });

  it("drops inline images from what gets stored", () => {
    const image = `data:image/png;base64,${"A".repeat(5000)}`;
    expect(withoutBlobs({ content: [{ type: "image_url", image_url: { url: image } }] })).toEqual({ content: [{ type: "image_url", image_url: { url: "[image/png omitted, 5022 chars]" } }] });
  });
});
