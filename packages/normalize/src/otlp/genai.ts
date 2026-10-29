// Reads LLM/tool/agent fields from span attributes across the dialects in the
// wild: OTel GenAI (latest and v1.36 names), OpenInference, OpenLLMetry
// (traceloop), Vercel AI SDK (ai.*) and harness-native names.

import type { StepKind, Usage } from "@lucid/schema";
import { isRecord, num, parseJson, str } from "../util";
import { type Attributes, indexedList } from "./types";

export type Dialect = "genai" | "openinference" | "vercel" | "traceloop" | "claude-code" | "native";

export type Message = { role: string; content: string; toolCalls?: { id?: string; name: string; arguments?: unknown }[] };

const pick = (attrs: Attributes, ...keys: string[]) => {
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

export function classifySpan(name: string, attrs: Attributes): { kind: StepKind; dialect: Dialect } {
  const oi = str(attrs["openinference.span.kind"])?.toUpperCase();
  if (oi) {
    const map: Record<string, StepKind> = {
      LLM: "llm",
      TOOL: "tool",
      AGENT: "agent",
      RETRIEVER: "retrieval",
      RERANKER: "retrieval",
      EMBEDDING: "retrieval",
      GUARDRAIL: "guardrail",
      DECISION: "decision",
    };
    return { kind: map[oi] ?? "event", dialect: "openinference" };
  }
  const op = str(attrs["gen_ai.operation.name"]);
  if (op) {
    const map: Record<string, StepKind> = {
      chat: "llm",
      generate_content: "llm",
      text_completion: "llm",
      completion: "llm",
      execute_tool: "tool",
      invoke_agent: "agent",
      create_agent: "agent",
      invoke_workflow: "agent",
      embeddings: "retrieval",
      retrieval: "retrieval",
      plan: "decision",
    };
    return { kind: map[op] ?? "event", dialect: "genai" };
  }
  if (name.startsWith("ai.")) {
    if (name === "ai.toolCall") return { kind: "tool", dialect: "vercel" };
    if (/\.do(Generate|Stream)$/.test(name)) return { kind: "llm", dialect: "vercel" };
    if (name.startsWith("ai.embed")) return { kind: "retrieval", dialect: "vercel" };
    return { kind: "agent", dialect: "vercel" };
  }
  if (name.startsWith("claude_code.")) {
    if (name === "claude_code.llm_request") return { kind: "llm", dialect: "claude-code" };
    if (name === "claude_code.tool") return { kind: "tool", dialect: "claude-code" };
    if (name === "claude_code.interaction") return { kind: "agent", dialect: "claude-code" };
    return { kind: "event", dialect: "claude-code" };
  }
  const traceloopKind = str(attrs["traceloop.span.kind"]);
  if (traceloopKind) {
    const map: Record<string, StepKind> = { workflow: "agent", agent: "agent", tool: "tool", task: "event" };
    return { kind: map[traceloopKind] ?? "event", dialect: "traceloop" };
  }
  if (attrs["gen_ai.system"] || attrs["llm.request.type"]) return { kind: "llm", dialect: "traceloop" };
  return { kind: "event", dialect: "native" };
}

export function spanModel(attrs: Attributes) {
  return str(pick(attrs, "gen_ai.response.model", "gen_ai.request.model", "llm.model_name", "ai.response.model", "ai.model.id", "model"));
}

export function spanProvider(attrs: Attributes) {
  return str(pick(attrs, "gen_ai.provider.name", "gen_ai.system", "llm.provider", "llm.system", "ai.model.provider"));
}

export function spanUsage(attrs: Attributes, dialect: Dialect): Usage | undefined {
  const input = num(
    pick(
      attrs,
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.prompt_tokens",
      "llm.token_count.prompt",
      "ai.usage.inputTokens",
      "ai.usage.promptTokens",
      "input_tokens",
    ),
  );
  const output = num(
    pick(
      attrs,
      "gen_ai.usage.output_tokens",
      "gen_ai.usage.completion_tokens",
      "llm.token_count.completion",
      "ai.usage.outputTokens",
      "ai.usage.completionTokens",
      "output_tokens",
    ),
  );
  const cacheRead = num(
    pick(
      attrs,
      "gen_ai.usage.cache_read.input_tokens",
      "gen_ai.usage.cache_read_input_tokens",
      "llm.token_count.prompt_details.cache_read",
      "ai.usage.cachedInputTokens",
      "cache_read_tokens",
    ),
  );
  const cacheWrite = num(
    pick(
      attrs,
      "gen_ai.usage.cache_write.input_tokens",
      "gen_ai.usage.cache_creation.input_tokens",
      "gen_ai.usage.cache_creation_input_tokens",
      "llm.token_count.prompt_details.cache_write",
      "cache_creation_tokens",
    ),
  );
  const reasoning = num(
    pick(attrs, "gen_ai.usage.reasoning.output_tokens", "llm.token_count.completion_details.reasoning", "ai.usage.reasoningTokens"),
  );
  if ([input, output, cacheRead, cacheWrite, reasoning].every((value) => value === undefined)) return undefined;

  // OTel GenAI and OpenInference count cached tokens inside input_tokens; our
  // pricing follows Anthropic (input excludes cache). When the reported input
  // is smaller than the cache counts, the source already excluded them.
  let inputTokens = input;
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (input !== undefined && dialect !== "claude-code" && dialect !== "native" && input >= cached) inputTokens = input - cached;
  return { inputTokens, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: reasoning };
}

export function spanReportedCost(attrs: Attributes) {
  return num(pick(attrs, "llm.cost.total", "gen_ai.usage.cost", "cost_usd", "gen_ai.cost.total"));
}

function toMessage(value: unknown): Message | undefined {
  if (!isRecord(value)) return undefined;
  const role = str(value.role) ?? "user";
  // OTel GenAI latest: { role, parts: [{ type: "text", content }, { type: "tool_call", name, arguments }] }
  if (Array.isArray(value.parts)) {
    const text: string[] = [];
    const toolCalls: NonNullable<Message["toolCalls"]> = [];
    for (const part of value.parts) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.content === "string") text.push(part.content);
      else if (part.type === "tool_call") toolCalls.push({ id: str(part.id), name: str(part.name) ?? "tool", arguments: part.arguments });
      else if (part.type === "tool_call_response") text.push(typeof part.response === "string" ? part.response : JSON.stringify(part.response));
      else if (part.type === "reasoning" && typeof part.content === "string") text.push(part.content);
    }
    return { role, content: text.join("\n"), toolCalls: toolCalls.length ? toolCalls : undefined };
  }
  const content = value.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === "string" ? part : isRecord(part) ? (str(part.text) ?? str(part.content) ?? "") : ""))
            .filter(Boolean)
            .join("\n")
        : content === undefined || content === null
          ? ""
          : JSON.stringify(content);
  const rawCalls = Array.isArray(value.tool_calls) ? value.tool_calls : Array.isArray(value.toolCalls) ? value.toolCalls : [];
  const toolCalls = rawCalls
    .filter(isRecord)
    .map((call) => {
      const fn = isRecord(call.function) ? call.function : call;
      return { id: str(call.id) ?? str(call.toolCallId), name: str(fn.name) ?? str(call.toolName) ?? "tool", arguments: parseJson(fn.arguments ?? call.args) };
    });
  return { role, content: text, toolCalls: toolCalls.length ? toolCalls : undefined };
}

function messagesFromJson(value: unknown): Message[] | undefined {
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    const messages = parsed.map(toMessage).filter((m): m is Message => !!m);
    return messages.length ? messages : undefined;
  }
  return undefined;
}

function openInferenceMessages(attrs: Attributes, prefix: string): Message[] | undefined {
  const items = indexedList(attrs, prefix);
  if (!items.length) return undefined;
  return items.map((item) => {
    const calls = indexedList(item as Attributes, "message.tool_calls").map((call) => ({
      id: str(call["tool_call.id"]),
      name: str(call["tool_call.function.name"]) ?? "tool",
      arguments: parseJson(call["tool_call.function.arguments"]),
    }));
    return {
      role: str(item["message.role"]) ?? "user",
      content: str(item["message.content"]) ?? "",
      toolCalls: calls.length ? calls : undefined,
    };
  });
}

function legacyIndexed(attrs: Attributes, prefix: string): Message[] | undefined {
  const items = indexedList(attrs, prefix);
  if (!items.length) return undefined;
  return items.map((item) => ({ role: str(item.role) ?? "user", content: str(item.content) ?? "" }));
}

export function spanInputMessages(attrs: Attributes): Message[] | undefined {
  const messages =
    messagesFromJson(attrs["gen_ai.input.messages"]) ??
    openInferenceMessages(attrs, "llm.input_messages") ??
    messagesFromJson(attrs["ai.prompt.messages"]) ??
    legacyIndexed(attrs, "gen_ai.prompt");
  const system = attrs["gen_ai.system_instructions"];
  if (system !== undefined) {
    const parsed = parseJson(system);
    const text = Array.isArray(parsed)
      ? parsed.map((part) => (isRecord(part) ? (str(part.content) ?? "") : String(part))).join("\n")
      : String(parsed);
    return [{ role: "system", content: text }, ...(messages ?? [])];
  }
  if (messages) return messages;
  const prompt = attrs["ai.prompt"];
  if (prompt !== undefined) {
    const parsed = parseJson(prompt);
    if (isRecord(parsed)) {
      const fromPrompt = messagesFromJson(parsed.messages);
      if (fromPrompt) return fromPrompt;
      if (typeof parsed.prompt === "string") return [{ role: "user", content: parsed.prompt }];
    }
  }
  const inputValue = str(attrs["input.value"]);
  return inputValue ? [{ role: "user", content: inputValue }] : undefined;
}

export function spanOutputMessages(attrs: Attributes): Message[] | undefined {
  const messages =
    messagesFromJson(attrs["gen_ai.output.messages"]) ??
    openInferenceMessages(attrs, "llm.output_messages") ??
    legacyIndexed(attrs, "gen_ai.completion");
  if (messages) return messages;
  const text = str(attrs["ai.response.text"]);
  const calls = parseJson(attrs["ai.response.toolCalls"]);
  if (text || Array.isArray(calls)) {
    const message = toMessage({ role: "assistant", content: text ?? "", toolCalls: Array.isArray(calls) ? calls : undefined });
    return message ? [message] : undefined;
  }
  const outputValue = str(attrs["output.value"]);
  return outputValue ? [{ role: "assistant", content: outputValue }] : undefined;
}

export function spanAvailableTools(attrs: Attributes): string[] | undefined {
  const names = new Set<string>();
  const add = (def: unknown) => {
    const parsed = parseJson(def);
    if (!isRecord(parsed)) return;
    const fn = isRecord(parsed.function) ? parsed.function : parsed;
    const name = str(fn.name);
    if (name) names.add(name);
  };
  const definitions = parseJson(attrs["gen_ai.tool.definitions"]);
  if (Array.isArray(definitions)) definitions.forEach(add);
  for (const item of indexedList(attrs, "llm.tools")) add(item["tool.json_schema"]);
  const vercelTools = attrs["ai.prompt.tools"];
  if (Array.isArray(vercelTools)) vercelTools.forEach(add);
  for (const item of indexedList(attrs, "gen_ai.request.functions")) if (str(item.name)) names.add(item.name as string);
  return names.size ? [...names] : undefined;
}

/** Full tool definitions (with JSON schemas), when the source records them. */
export function spanToolDefinitions(attrs: Attributes): unknown[] | undefined {
  const definitions = parseJson(attrs["gen_ai.tool.definitions"]);
  if (Array.isArray(definitions) && definitions.length) return definitions;
  const openInference = indexedList(attrs, "llm.tools").map((item) => parseJson(item["tool.json_schema"])).filter(isRecord);
  if (openInference.length) return openInference;
  const vercel = attrs["ai.prompt.tools"];
  if (Array.isArray(vercel)) {
    const parsed = vercel.map(parseJson).filter(isRecord);
    if (parsed.length) return parsed;
  }
  return undefined;
}

export function spanTool(attrs: Attributes) {
  return {
    name: str(pick(attrs, "gen_ai.tool.name", "tool.name", "ai.toolCall.name", "tool_name")),
    callId: str(pick(attrs, "gen_ai.tool.call.id", "ai.toolCall.id", "tool_call.id", "tool_use_id")),
    args: parseJson(pick(attrs, "gen_ai.tool.call.arguments", "tool.parameters", "ai.toolCall.args", "input.value", "tool_input")),
    result: parseJson(pick(attrs, "gen_ai.tool.call.result", "ai.toolCall.result", "output.value", "tool_output")),
  };
}

export function spanAgentName(attrs: Attributes) {
  return str(pick(attrs, "gen_ai.agent.name", "agent.name", "graph.node.id"));
}

export function spanSessionId(attrs: Attributes) {
  return str(
    pick(
      attrs,
      "gen_ai.conversation.id",
      "session.id",
      "langsmith.trace.session_id",
      "ai.telemetry.metadata.sessionId",
      "traceloop.association.properties.session_id",
      "conversation.id",
    ),
  );
}
