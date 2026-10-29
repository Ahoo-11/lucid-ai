// Rebuilds the exact request behind a captured decision (an LLM step):
// the messages the model saw, the tool schemas it was offered, and its
// parameters. Sources store these in different shapes; this returns one
// OpenAI-style request, or the reason a decision can't be replayed.

import type { StepAttrs } from "@lucid/schema";
import type { ChatMessage, ToolCall } from "./llm";

export type DecisionRequest = {
  messages: ChatMessage[];
  tools: unknown[];
  params: { maxTokens?: number; temperature?: number };
};

export type DecisionContext = { request?: string; recent?: { role: string; text: string }[]; tools?: string[] };

/**
 * Where a payload was shortened: by the Lucid plugin, or by Hermes' own hook
 * sanitizer ("<dict depth limit>").
 */
const TRUNCATION_MARKER = /\[truncated by Lucid\]|<\w+ depth limit>/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (text: string | null | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const asArgs = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value ?? {}));

/** Hermes sends OpenAI chat messages; OTel sources use { role, content, toolCalls }. */
export function toChatMessages(raw: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.role !== "string") continue;
    const role = item.role === "developer" ? "system" : item.role;
    const calls = Array.isArray(item.tool_calls) ? item.tool_calls : Array.isArray(item.toolCalls) ? item.toolCalls : [];
    const toolCalls = calls.filter(isRecord).map((call, index) => {
      const fn = isRecord(call.function) ? call.function : call;
      return {
        id: String(call.id ?? `call_${messages.length}_${index}`),
        type: "function" as const,
        function: { name: String(fn.name ?? "tool"), arguments: asArgs(fn.arguments ?? call.input) },
      };
    });
    const content = item.content ?? (toolCalls.length ? null : "");
    if (role === "tool" && typeof item.tool_call_id !== "string") {
      // A tool result with no call id can't be sent as a tool message.
      messages.push({ role: "user", content: `[tool result] ${typeof content === "string" ? content : JSON.stringify(content)}` });
      continue;
    }
    messages.push({
      role,
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(typeof item.tool_call_id === "string" ? { tool_call_id: item.tool_call_id } : {}),
      ...(typeof item.name === "string" && role === "tool" ? { name: item.name } : {}),
    });
  }
  return messages;
}

/** OpenAI's { type, function: {...} } shape; OTel GenAI and Vercel write the fields flat. */
export function toChatTools(raw: unknown[]): unknown[] {
  return raw.filter(isRecord).map((tool) => {
    if (isRecord(tool.function)) return { type: "function", function: tool.function };
    const { type: _type, ...fn } = tool;
    return { type: "function", function: { ...fn, parameters: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} } } };
  });
}

export function outputOf(raw: string | null | undefined): { text?: string; toolCalls?: ToolCall[] } {
  const parsed = parse(raw);
  if (typeof parsed === "string") return { text: parsed };
  if (!isRecord(parsed)) return {};
  const calls = Array.isArray(parsed.toolCalls) ? parsed.toolCalls.filter(isRecord) : [];
  return {
    text: typeof parsed.text === "string" ? parsed.text : undefined,
    toolCalls: calls.length
      ? calls.map((call) => ({ id: typeof call.id === "string" ? call.id : undefined, name: String(call.name ?? "tool"), input: call.input ?? parse(call.arguments as string) ?? call.arguments }))
      : undefined,
  };
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  return content === null || content === undefined ? "" : JSON.stringify(content);
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function contextOf(messages: ChatMessage[], runInput: string | null, tools: unknown[]): DecisionContext {
  const recent = messages
    .filter((m) => m.role !== "system")
    .slice(-4)
    .map((m) => ({
      role: m.role,
      text: clip(
        [textOf(m.content), ...(m.tool_calls ?? []).map((c) => `→ ${c.function.name}(${clip(c.function.arguments, 200)})`)].filter(Boolean).join("\n"),
        800,
      ),
    }));
  const names = tools.map((tool) => (isRecord(tool) && isRecord(tool.function) ? String(tool.function.name) : "")).filter(Boolean);
  return { request: runInput ?? undefined, recent, tools: names };
}

type StepLike = {
  kind: string;
  status: string;
  inputHash: string | null;
  outputHash: string | null;
  attrs: StepAttrs | null;
};

/**
 * `loadBlob` returns stored content by key. Returns the request or a reason
 * phrased for the person who clicked "Try this decision".
 */
export async function decisionRequest(
  step: StepLike,
  loadBlob: (key: string) => Promise<string | null>,
): Promise<{ ok: true; request: DecisionRequest } | { ok: false; reason: string }> {
  if (step.kind !== "llm") return { ok: false, reason: "Only model calls can be replayed." };
  const input = step.inputHash ? parse(await loadBlob(step.inputHash)) : undefined;
  const raw = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.messages) ? input.messages : null;
  if (!raw?.length) {
    return { ok: false, reason: "The messages sent to the model weren't captured for this call, so it can't be replayed. (Claude Code session files don't include them yet; Hermes and OpenTelemetry with content capture do.)" };
  }
  const messages = toChatMessages(raw);
  if (!messages.some((m) => m.role === "user")) return { ok: false, reason: "The captured request has no user message to replay." };

  let tools: unknown[] = [];
  const toolsRef = step.attrs?.toolsRef;
  if (toolsRef) {
    const content = await loadBlob(toolsRef);
    // Early versions of the Hermes plugin cut deep schemas short; providers
    // that validate schemas (Anthropic) reject those, and the rest would
    // replay a different tool set than the agent had.
    if (content && TRUNCATION_MARKER.test(content)) {
      return { ok: false, reason: "The tool definitions for this call were cut short when captured (an older Lucid plugin did this), so a replay wouldn't be faithful. Calls captured with the current plugin can be replayed." };
    }
    const stored = parse(content);
    if (Array.isArray(stored)) tools = toChatTools(stored);
  }
  if (!tools.length && (step.attrs?.availableTools?.length ?? 0) > 0) {
    return { ok: false, reason: "The tool definitions for this call weren't captured, and replaying without them would change the decision. New calls captured from now on include them." };
  }
  const params = step.attrs?.requestParams ?? {};
  const maxTokens = typeof params.max_tokens === "number" ? Math.min(params.max_tokens, 8192) : 4096;
  const temperature = typeof params.temperature === "number" ? params.temperature : undefined;
  return { ok: true, request: { messages, tools, params: { maxTokens, temperature } } };
}

/** Applies a variant's prompt change to the system message. */
export function withSystemPrompt(messages: ChatMessage[], mode: string | null, prompt: string | null): ChatMessage[] {
  if (!prompt?.trim() || !mode || mode === "none") return messages;
  const index = messages.findIndex((m) => m.role === "system");
  if (index === -1) return [{ role: "system", content: prompt }, ...messages];
  const current = textOf(messages[index]!.content);
  const content = mode === "replace" ? prompt : `${current}\n\n${prompt}`;
  return messages.map((m, i) => (i === index ? { ...m, content } : m));
}
