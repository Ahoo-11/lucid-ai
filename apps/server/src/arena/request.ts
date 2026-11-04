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

export const textOf = (content: unknown): string => {
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

/** The step's captured messages, or null when they weren't sent. */
async function capturedMessages(step: StepLike, loadBlob: (key: string) => Promise<string | null>) {
  const input = step.inputHash ? parse(await loadBlob(step.inputHash)) : undefined;
  const raw = Array.isArray(input) ? input : isRecord(input) && Array.isArray(input.messages) ? input.messages : null;
  return raw?.length ? raw : null;
}

/** The step's captured tool definitions: the list, "cut" when an older plugin cut them short, or null when none were sent. */
async function capturedTools(step: StepLike, loadBlob: (key: string) => Promise<string | null>) {
  const toolsRef = step.attrs?.toolsRef;
  if (!toolsRef) return null;
  const content = await loadBlob(toolsRef);
  if (content && TRUNCATION_MARKER.test(content)) return "cut" as const;
  const stored = parse(content);
  return Array.isArray(stored) && stored.length ? toChatTools(stored) : null;
}

function paramsOf(step: StepLike) {
  const params = step.attrs?.requestParams ?? {};
  const maxTokens = typeof params.max_tokens === "number" ? Math.min(params.max_tokens, 8192) : 4096;
  const temperature = typeof params.temperature === "number" ? params.temperature : undefined;
  return { maxTokens, temperature };
}

/**
 * `loadBlob` returns stored content by key. Returns the request or a reason
 * phrased for the person who clicked "Try this decision"; `missing` says
 * what wasn't captured, for callers that can make do (rebuiltRequest).
 */
export async function decisionRequest(
  step: StepLike,
  loadBlob: (key: string) => Promise<string | null>,
): Promise<{ ok: true; request: DecisionRequest } | { ok: false; reason: string; missing?: "messages" | "tools" }> {
  if (step.kind !== "llm") return { ok: false, reason: "Only model calls can be replayed." };
  const raw = await capturedMessages(step, loadBlob);
  if (!raw) {
    return {
      ok: false,
      missing: "messages",
      reason: "The messages sent to the model weren't captured for this call, so it can't be replayed. (Claude Code session files don't include them yet; Hermes and OpenTelemetry with content capture do.)",
    };
  }
  const messages = toChatMessages(raw);
  if (!messages.some((m) => m.role === "user")) return { ok: false, reason: "The captured request has no user message to replay." };

  const tools = await capturedTools(step, loadBlob);
  // Early versions of the Hermes plugin cut deep schemas short; providers
  // that validate schemas (Anthropic) reject those, and the rest would
  // replay a different tool set than the agent had.
  if (tools === "cut") {
    return {
      ok: false,
      missing: "tools",
      reason: "The tool definitions for this call were cut short when captured (an older Lucid plugin did this), so a replay wouldn't be faithful. Calls captured with the current plugin can be replayed.",
    };
  }
  if (!tools && (step.attrs?.availableTools?.length ?? 0) > 0) {
    return {
      ok: false,
      missing: "tools",
      reason: "The tool definitions for this call weren't captured, and replaying without them would change the decision. New calls captured from now on include them.",
    };
  }
  return { ok: true, request: { messages, tools: tools ?? [], params: paramsOf(step) } };
}

/** Tools known only by name: open parameters, so the model can still call them as the agent did. */
export function looseTools(names: string[]): unknown[] {
  return [...new Set(names)].map((name) => ({
    type: "function",
    function: { name, description: "One of the agent's tools (its definition wasn't recorded).", parameters: { type: "object", properties: {}, additionalProperties: true } },
  }));
}

/**
 * Keeps tool calls and their results paired as providers require: a call
 * whose results don't all follow it, or a result with no call, becomes plain
 * text. Rebuilt chats can have either (a call id that wasn't recorded).
 */
export function pairToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const asResult = (message: ChatMessage): ChatMessage => ({ role: "user", content: `[tool result] ${textOf(message.content)}` });
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "tool") {
      out.push(asResult(message));
      continue;
    }
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      out.push(message);
      continue;
    }
    const results: ChatMessage[] = [];
    while (messages[i + 1]?.role === "tool") results.push(messages[++i]!);
    const ids = new Set(message.tool_calls.map((call) => call.id));
    if (results.length === ids.size && results.every((result) => result.tool_call_id && ids.has(result.tool_call_id))) {
      out.push(message, ...results);
      continue;
    }
    const calls = message.tool_calls.map((call) => `Called ${call.function.name}(${clip(call.function.arguments, 2000)})`);
    out.push({ role: "assistant", content: [textOf(message.content), ...calls].filter(Boolean).join("\n") }, ...results.map(asResult));
  }
  return out;
}

/**
 * A stand-in for a decision whose exact request wasn't captured, for fix
 * tests: the messages as captured or else `rebuilt` from the recorded chat
 * (without the agent's own instructions), and the tools as captured or else
 * by name (`toolNames`, plus the ones the step was offered and the chat
 * called). Null when there's no task to replay.
 */
export async function rebuiltRequest(
  step: StepLike,
  loadBlob: (key: string) => Promise<string | null>,
  rebuilt: unknown[] | null | undefined,
  toolNames: string[],
): Promise<DecisionRequest | null> {
  if (step.kind !== "llm") return null;
  const raw = (await capturedMessages(step, loadBlob)) ?? (rebuilt?.length ? rebuilt : null);
  if (!raw) return null;
  const messages = pairToolCalls(toChatMessages(raw));
  if (!messages.some((m) => m.role === "user" && !textOf(m.content).startsWith("[tool result]"))) return null;
  const captured = await capturedTools(step, loadBlob);
  const called = messages.flatMap((m) => m.tool_calls?.map((call) => call.function.name) ?? []);
  const tools = Array.isArray(captured) ? captured : looseTools([...(step.attrs?.availableTools ?? []), ...toolNames, ...called]);
  return { messages, tools, params: paramsOf(step) };
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
