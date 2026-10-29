// One shape for every model call that passes through the proxy, whatever API
// the agent speaks. OpenAI chat format is the common denominator: the Arena
// replays it through any OpenAI-compatible provider.

import { isRecord, num, parseJson, str } from "../util";

export type ProxyApi = "openai-chat" | "anthropic-messages";

export type CanonicalMessage = {
  role: string;
  content: unknown;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type CanonicalRequest = {
  model?: string;
  messages: CanonicalMessage[];
  tools: unknown[];
  params: Record<string, unknown>;
  stream: boolean;
};

export type CanonicalResponse = {
  id?: string;
  model?: string;
  text?: string;
  reasoning?: string;
  toolCalls?: { id?: string; name: string; input?: unknown }[];
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
  costUsd?: number;
  error?: string;
};

const asArgs = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? {}));

/** Big inline images and files would bloat every stored step; keep a marker instead. */
export function withoutBlobs(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:") && value.length > 1024) return `[${value.slice(5, value.indexOf(";")) || "file"} omitted, ${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map(withoutBlobs);
  if (isRecord(value)) {
    // Anthropic image/document sources: { type: "base64", data: "…" }.
    if (value.type === "base64" && typeof value.data === "string" && value.data.length > 1024) {
      return { ...value, data: `[base64 omitted, ${value.data.length} chars]` };
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutBlobs(v)]));
  }
  return value;
}

const PARAM_KEYS = ["max_tokens", "max_completion_tokens", "temperature", "top_p", "tool_choice", "reasoning_effort", "reasoning", "thinking", "response_format", "stop"];

function params(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

export function canonicalRequest(api: ProxyApi, raw: unknown): CanonicalRequest {
  const body = isRecord(raw) ? raw : {};
  const stream = body.stream === true;
  if (api === "openai-chat") {
    const messages = (Array.isArray(body.messages) ? body.messages : []).filter(isRecord).map((m) => {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isRecord) : [];
      return {
        role: m.role === "developer" ? "system" : String(m.role ?? "user"),
        content: m.content ?? null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => {
                const fn = isRecord(c.function) ? c.function : {};
                return { id: String(c.id ?? ""), type: "function" as const, function: { name: String(fn.name ?? "tool"), arguments: asArgs(fn.arguments) } };
              }),
            }
          : {}),
        ...(typeof m.tool_call_id === "string" ? { tool_call_id: m.tool_call_id } : {}),
      };
    });
    return { model: str(body.model), messages, tools: Array.isArray(body.tools) ? body.tools : [], params: params(body), stream };
  }

  // Anthropic Messages: system apart, content blocks, tool_use / tool_result blocks.
  const messages: CanonicalMessage[] = [];
  const system = typeof body.system === "string" ? body.system : Array.isArray(body.system) ? body.system.map((b) => (isRecord(b) ? str(b.text) ?? "" : "")).join("\n") : "";
  if (system) messages.push({ role: "system", content: system });
  for (const m of Array.isArray(body.messages) ? body.messages.filter(isRecord) : []) {
    const role = String(m.role ?? "user");
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content.filter(isRecord) : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n");
    if (role === "assistant") {
      const calls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: String(b.id ?? ""), type: "function" as const, function: { name: String(b.name ?? "tool"), arguments: asArgs(b.input) } }));
      messages.push({ role, content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const result of blocks.filter((b) => b.type === "tool_result")) {
      const content = typeof result.content === "string" ? result.content : Array.isArray(result.content) ? result.content.map((p) => (isRecord(p) ? str(p.text) ?? "" : "")).join("\n") : "";
      messages.push({ role: "tool", tool_call_id: String(result.tool_use_id ?? ""), content: result.is_error === true ? `Error: ${content}` : content });
    }
    const other = blocks.filter((b) => b.type !== "tool_result");
    if (other.length) messages.push({ role, content: text || (other.some((b) => b.type === "image") ? "[image]" : "") });
  }
  const tools = (Array.isArray(body.tools) ? body.tools.filter(isRecord) : [])
    .filter((t) => t.input_schema || !t.type || t.type === "custom")
    .map((t) => ({ type: "function", function: { name: String(t.name ?? "tool"), description: str(t.description), parameters: t.input_schema ?? { type: "object", properties: {} } } }));
  return { model: str(body.model), messages, tools, params: params(body), stream };
}

export function canonicalResponse(api: ProxyApi, raw: unknown, status: number): CanonicalResponse {
  const body = isRecord(raw) ? raw : {};
  if (status >= 400 || body.error) {
    const error = isRecord(body.error) ? (str(body.error.message) ?? JSON.stringify(body.error)) : (str(body.error) ?? `HTTP ${status}`);
    return { error: status >= 400 && !error.includes(String(status)) ? `HTTP ${status}: ${error}` : error };
  }
  if (api === "openai-chat") {
    const choice = Array.isArray(body.choices) ? body.choices.find(isRecord) : undefined;
    const message = isRecord(choice?.message) ? choice.message : {};
    const usage = isRecord(body.usage) ? body.usage : {};
    const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    const cached = num(promptDetails.cached_tokens) ?? 0;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    return {
      id: str(body.id),
      model: str(body.model),
      text: typeof message.content === "string" && message.content.trim() ? message.content : undefined,
      reasoning: str(message.reasoning) ?? str(message.reasoning_content),
      toolCalls: calls.length
        ? calls.map((c) => {
            const fn = isRecord(c.function) ? c.function : {};
            return { id: str(c.id), name: String(fn.name ?? "tool"), input: parseJson(fn.arguments) };
          })
        : undefined,
      stopReason: str(choice?.finish_reason),
      usage: {
        inputTokens: num(usage.prompt_tokens) !== undefined ? Math.max(0, num(usage.prompt_tokens)! - cached) : undefined,
        outputTokens: num(usage.completion_tokens),
        cacheReadTokens: cached || undefined,
        reasoningTokens: num(completionDetails.reasoning_tokens),
      },
      costUsd: num(usage.cost),
    };
  }
  const blocks = Array.isArray(body.content) ? body.content.filter(isRecord) : [];
  const usage = isRecord(body.usage) ? body.usage : {};
  const calls = blocks.filter((b) => b.type === "tool_use");
  return {
    id: str(body.id),
    model: str(body.model),
    text: blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n") || undefined,
    reasoning: blocks.filter((b) => b.type === "thinking").map((b) => str(b.thinking) ?? "").join("\n") || undefined,
    toolCalls: calls.length ? calls.map((b) => ({ id: str(b.id), name: String(b.name ?? "tool"), input: b.input })) : undefined,
    stopReason: str(body.stop_reason),
    usage: {
      inputTokens: num(usage.input_tokens),
      outputTokens: num(usage.output_tokens),
      cacheReadTokens: num(usage.cache_read_input_tokens),
      cacheWriteTokens: num(usage.cache_creation_input_tokens),
    },
  };
}
