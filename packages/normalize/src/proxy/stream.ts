// Rebuilds the final response object from a streamed (SSE) reply, so a
// streamed call is stored exactly like a non-streamed one.

import { isRecord } from "../util";
import type { ProxyApi } from "./canonical";

export function sseEvents(text: string): { event?: string; data: string }[] {
  const events: { event?: string; data: string }[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return events;
}

const parse = (data: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(data);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
};

/** OpenAI chat.completion.chunk stream → a chat.completion object. */
function assembleOpenAI(text: string) {
  let id: unknown;
  let model: unknown;
  let usage: unknown;
  let finish: unknown;
  let content = "";
  let reasoning = "";
  const calls: { id?: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  for (const { data } of sseEvents(text)) {
    if (data === "[DONE]") continue;
    const chunk = parse(data);
    if (!chunk) continue;
    id ??= chunk.id;
    model ??= chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices.filter(isRecord) : []) {
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls.filter(isRecord) : []) {
        const index = typeof part.index === "number" ? part.index : calls.length;
        const call = (calls[index] ??= { type: "function", function: { name: "", arguments: "" } });
        if (typeof part.id === "string") call.id = part.id;
        const fn = isRecord(part.function) ? part.function : {};
        if (typeof fn.name === "string") call.function.name += fn.name;
        if (typeof fn.arguments === "string") call.function.arguments += fn.arguments;
      }
    }
  }
  return {
    id,
    model,
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: content || null, ...(reasoning ? { reasoning } : {}), ...(calls.length ? { tool_calls: calls.filter(Boolean) } : {}) } }],
    usage,
  };
}

/** Anthropic message stream (message_start, content_block_*, message_delta) → a message object. */
function assembleAnthropic(text: string) {
  let message: Record<string, unknown> = {};
  const blocks: Record<string, unknown>[] = [];
  const partialJson: string[] = [];
  for (const { data } of sseEvents(text)) {
    const event = parse(data);
    if (!event) continue;
    if (event.type === "message_start" && isRecord(event.message)) message = { ...event.message };
    if (event.type === "content_block_start" && typeof event.index === "number" && isRecord(event.content_block)) {
      blocks[event.index] = { ...event.content_block };
      partialJson[event.index] = "";
    }
    if (event.type === "content_block_delta" && typeof event.index === "number" && isRecord(event.delta)) {
      const block = (blocks[event.index] ??= { type: "text", text: "" });
      const delta = event.delta;
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text ?? ""}`;
      if (delta.type === "thinking_delta") block.thinking = `${block.thinking ?? ""}${delta.thinking ?? ""}`;
      if (delta.type === "input_json_delta") partialJson[event.index] = `${partialJson[event.index] ?? ""}${delta.partial_json ?? ""}`;
    }
    if (event.type === "message_delta") {
      if (isRecord(event.delta)) message = { ...message, ...event.delta };
      if (isRecord(event.usage)) message.usage = { ...(isRecord(message.usage) ? message.usage : {}), ...event.usage };
    }
  }
  blocks.forEach((block, index) => {
    if (block?.type === "tool_use" && partialJson[index]) {
      try {
        block.input = JSON.parse(partialJson[index]!);
      } catch {
        block.input = partialJson[index];
      }
    }
  });
  return { ...message, content: blocks.filter(Boolean) };
}

export function assembleStream(api: ProxyApi, text: string): unknown {
  return api === "openai-chat" ? assembleOpenAI(text) : assembleAnthropic(text);
}
