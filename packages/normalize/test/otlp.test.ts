import { describe, expect, it } from "vitest";
import { normalizeOtlpLogs, normalizeOtlpTraces } from "../src/index";
import type { KeyValue, OtlpSpan } from "../src/otlp/types";

const kv = (attrs: Record<string, string | number | boolean | string[]>): KeyValue[] =>
  Object.entries(attrs).map(([key, value]) => ({
    key,
    value: Array.isArray(value)
      ? { arrayValue: { values: value.map((item) => ({ stringValue: item })) } }
      : typeof value === "string"
        ? { stringValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : Number.isInteger(value)
            ? { intValue: String(value) }
            : { doubleValue: value },
  }));

const nanos = (iso: string) => `${BigInt(new Date(iso).getTime()) * 1_000_000n}`;
const TRACE = "0af7651916cd43dd8448eb211c80319c";

const traces = (service: string, scope: string, spans: OtlpSpan[]) => ({
  resourceSpans: [{ resource: { attributes: kv({ "service.name": service }) }, scopeSpans: [{ scope: { name: scope }, spans }] }],
});

describe("OTLP traces: OTel GenAI conventions", () => {
  const batch = normalizeOtlpTraces(
    traces("support-bot", "my.agent", [
      {
        traceId: TRACE,
        spanId: "00000000000000a1",
        name: "invoke_agent Support",
        startTimeUnixNano: nanos("2026-10-27T10:00:00Z"),
        endTimeUnixNano: nanos("2026-10-27T10:00:05Z"),
        attributes: kv({ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "Support", "gen_ai.conversation.id": "conv-9" }),
      },
      {
        traceId: TRACE,
        spanId: "00000000000000b2",
        parentSpanId: "00000000000000a1",
        name: "chat gpt-5-mini",
        startTimeUnixNano: nanos("2026-10-27T10:00:01Z"),
        endTimeUnixNano: nanos("2026-10-27T10:00:02Z"),
        attributes: kv({
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-5-mini",
          "gen_ai.usage.input_tokens": 1200,
          "gen_ai.usage.cache_read.input_tokens": 1000,
          "gen_ai.usage.output_tokens": 30,
          "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "Where is my order 42?" }] }]),
          "gen_ai.output.messages": JSON.stringify([
            { role: "assistant", parts: [{ type: "tool_call", id: "call_1", name: "lookup_order", arguments: { id: 42 } }] },
          ]),
          "gen_ai.tool.definitions": JSON.stringify([{ type: "function", name: "lookup_order" }, { type: "function", name: "refund" }]),
        }),
      },
      {
        traceId: TRACE,
        spanId: "00000000000000c3",
        parentSpanId: "00000000000000a1",
        name: "execute_tool lookup_order",
        startTimeUnixNano: nanos("2026-10-27T10:00:02Z"),
        endTimeUnixNano: nanos("2026-10-27T10:00:03Z"),
        status: { code: 2, message: "order service timeout" },
        attributes: kv({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "lookup_order", "gen_ai.tool.call.id": "call_1", "gen_ai.tool.call.arguments": '{"id":42}' }),
      },
    ]),
  );
  const step = (id: string) => batch.steps.find((s) => s.externalId === id);

  it("makes one run per trace, tied to the conversation", () => {
    expect(batch.runs).toHaveLength(1);
    expect(batch.runs[0]).toMatchObject({ externalId: TRACE, harness: "support-bot", sessionExternalId: "conv-9", input: "Where is my order 42?", status: "ok", model: "gpt-5-mini" });
    expect(batch.sessions[0]).toMatchObject({ externalId: "conv-9" });
  });

  it("maps chat spans to LLM steps with tools and cache-aware usage", () => {
    expect(step("00000000000000b2")).toMatchObject({
      kind: "llm",
      name: "gpt-5-mini",
      provider: "openai",
      parentExternalId: "00000000000000a1",
      usage: { inputTokens: 200, cacheReadTokens: 1000, outputTokens: 30 },
      output: { toolCalls: [{ id: "call_1", name: "lookup_order", arguments: { id: 42 } }] },
      attrs: { availableTools: ["lookup_order", "refund"] },
    });
  });

  it("maps execute_tool spans with errors", () => {
    expect(step("00000000000000c3")).toMatchObject({ kind: "tool", name: "lookup_order", status: "error", error: "order service timeout", input: { id: 42 }, durationMs: 1000 });
  });

  it("names agent steps after the agent", () => {
    expect(step("00000000000000a1")).toMatchObject({ kind: "agent", name: "Support" });
  });
});

describe("OTLP traces: OpenInference", () => {
  const batch = normalizeOtlpTraces(
    traces("rag-app", "openinference.instrumentation.langchain", [
      {
        traceId: TRACE,
        spanId: "1111111111111111",
        name: "ChatOpenAI",
        startTimeUnixNano: nanos("2026-10-27T10:00:00Z"),
        endTimeUnixNano: nanos("2026-10-27T10:00:01Z"),
        attributes: kv({
          "openinference.span.kind": "LLM",
          "llm.model_name": "gpt-4o",
          "llm.token_count.prompt": 100,
          "llm.token_count.completion": 20,
          "llm.input_messages.0.message.role": "system",
          "llm.input_messages.0.message.content": "Be brief",
          "llm.input_messages.1.message.role": "user",
          "llm.input_messages.1.message.content": "What is OTel?",
          "llm.output_messages.0.message.role": "assistant",
          "llm.output_messages.0.message.content": "A telemetry standard.",
          "llm.tools.0.tool.json_schema": JSON.stringify({ type: "function", function: { name: "search" } }),
          "session.id": "s-7",
        }),
      },
    ]),
  );

  it("reads flattened messages, tools and session", () => {
    expect(batch.runs[0]).toMatchObject({ harness: "langchain", input: "What is OTel?", output: "A telemetry standard.", sessionExternalId: "s-7" });
    expect(batch.steps[0]).toMatchObject({ kind: "llm", model: "gpt-4o", usage: { inputTokens: 100, outputTokens: 20 }, attrs: { availableTools: ["search"] } });
    expect((batch.steps[0]?.input as { role: string }[])[0]).toMatchObject({ role: "system", content: "Be brief" });
  });
});

describe("OTLP traces: Vercel AI SDK", () => {
  const batch = normalizeOtlpTraces(
    traces("next-app", "ai", [
      { traceId: TRACE, spanId: "2222222222222222", name: "ai.generateText", startTimeUnixNano: nanos("2026-10-27T10:00:00Z"), endTimeUnixNano: nanos("2026-10-27T10:00:03Z"), attributes: kv({ "ai.prompt": JSON.stringify({ prompt: "Weather in Paris?" }) }) },
      {
        traceId: TRACE,
        spanId: "3333333333333333",
        parentSpanId: "2222222222222222",
        name: "ai.generateText.doGenerate",
        startTimeUnixNano: nanos("2026-10-27T10:00:00Z"),
        endTimeUnixNano: nanos("2026-10-27T10:00:01Z"),
        attributes: kv({
          "ai.model.id": "claude-haiku-4-5",
          "ai.model.provider": "anthropic.messages",
          "ai.prompt.messages": JSON.stringify([{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }] }]),
          "ai.prompt.tools": [JSON.stringify({ type: "function", name: "weather" })],
          "ai.response.toolCalls": JSON.stringify([{ toolCallId: "t1", toolName: "weather", args: '{"city":"Paris"}' }]),
          "ai.usage.promptTokens": 50,
          "ai.usage.completionTokens": 10,
        }),
      },
      { traceId: TRACE, spanId: "4444444444444444", parentSpanId: "2222222222222222", name: "ai.toolCall", startTimeUnixNano: nanos("2026-10-27T10:00:01Z"), endTimeUnixNano: nanos("2026-10-27T10:00:02Z"), attributes: kv({ "ai.toolCall.name": "weather", "ai.toolCall.id": "t1", "ai.toolCall.args": '{"city":"Paris"}', "ai.toolCall.result": '{"temp":18}' }) },
    ]),
  );

  it("maps doGenerate to LLM steps and toolCall to tool steps", () => {
    expect(batch.runs[0]).toMatchObject({ harness: "vercel-ai", input: "Weather in Paris?" });
    const llm = batch.steps.find((s) => s.kind === "llm");
    expect(llm).toMatchObject({ model: "claude-haiku-4-5", attrs: { availableTools: ["weather"] }, output: { toolCalls: [{ id: "t1", name: "weather", arguments: { city: "Paris" } }] } });
    expect(batch.steps.find((s) => s.kind === "tool")).toMatchObject({ name: "weather", input: { city: "Paris" }, output: { temp: 18 } });
  });
});

describe("OTLP logs: Claude Code events", () => {
  const record = (event: string, attrs: Record<string, string | number | boolean>, at: string) => ({
    timeUnixNano: nanos(at),
    body: { stringValue: `claude_code.${event}` },
    attributes: kv({ "event.name": event, "event.timestamp": at, "session.id": "sess-1", "prompt.id": "prompt-1", ...attrs }),
  });
  const batch = normalizeOtlpLogs({
    resourceLogs: [
      {
        resource: { attributes: kv({ "service.name": "claude-code" }) },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events" },
            logRecords: [
              record("user_prompt", { prompt: "Count the lines in README.md", prompt_length: 28 }, "2026-10-27T10:00:00Z"),
              record("api_request", { model: "claude-sonnet-4-5", request_id: "req_1", cost_usd: 0.0123, duration_ms: 2300, input_tokens: 10, output_tokens: 55, cache_read_tokens: 1000, cache_creation_tokens: 200 }, "2026-10-27T10:00:02.500Z"),
              record("tool_result", { tool_name: "Bash", tool_use_id: "toolu_2", success: false, duration_ms: 31, error: "exit 127" }, "2026-10-27T10:00:05Z"),
            ],
          },
        ],
      },
    ],
  });

  it("keys runs and steps on the same ids the transcript uses", () => {
    expect(batch.runs[0]).toMatchObject({ externalId: "prompt-1", sessionExternalId: "sess-1", input: "Count the lines in README.md", model: "claude-sonnet-4-5" });
    expect(batch.steps.find((s) => s.externalId === "req_1")).toMatchObject({ kind: "llm", reportedCostUsd: 0.0123, durationMs: 2300, usage: { cacheReadTokens: 1000 } });
    expect(batch.steps.find((s) => s.externalId === "toolu_2")).toMatchObject({ kind: "tool", status: "error", error: "exit 127" });
  });
});
