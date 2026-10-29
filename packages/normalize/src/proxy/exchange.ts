// A model call captured by the Lucid proxy → runs and steps.
//
// A proxy sees model calls, not the agent, so structure is rebuilt from the
// traffic itself. Agents resend the whole conversation on every call, so:
//   - a Session is a conversation: the x-lucid-session header, or the hash of
//     its system prompt + first user message
//   - a Run is one user request: everything after the last user message
//   - Tool steps come from the assistant's tool calls, completed by the tool
//     results the agent sends back in its next call
// The full request is kept on each LLM step, so the Arena can replay any
// decision exactly, whichever framework made it.

import { createHash } from "node:crypto";
import type { NormalizedBatch, StepUpsert } from "@lucid/schema";
import { firstLine, isRecord, parseJson, str } from "../util";
import { type CanonicalMessage, type ProxyApi, canonicalRequest, canonicalResponse } from "./canonical";

export type ProxyExchange = {
  provider: string;
  api: ProxyApi;
  request: unknown;
  /** Parsed response body, or the object rebuilt from a stream. */
  response: unknown;
  status: number;
  startedAt: string;
  endedAt: string;
  /** Optional grouping from x-lucid-* request headers. */
  session?: string;
  run?: string;
  agent?: string;
  user?: string;
  /** Network failure before any response. */
  error?: string;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join("\n");
  return "";
};

/** A user message the person wrote (not tool output that some APIs send as role "user"). */
const isHumanTurn = (m: CanonicalMessage) => m.role === "user" && textOf(m.content).trim().length > 0;

function looksFailed(content: string) {
  const parsed = parseJson(content);
  if (isRecord(parsed)) return parsed.success === false || parsed.ok === false || (!!parsed.error && parsed.error !== null);
  return /^(error\b|traceback \(most recent call last\))/i.test(content.trim());
}

export function normalizeProxyExchange(exchange: ProxyExchange): NormalizedBatch {
  const request = canonicalRequest(exchange.api, exchange.request);
  const response = exchange.error ? { error: exchange.error } : canonicalResponse(exchange.api, exchange.response, exchange.status);
  const messages = request.messages;
  const harness = exchange.agent?.trim() || "proxy";

  const system = messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const firstUser = messages.find(isHumanTurn);
  const sessionKey = exchange.session?.trim() || `auto:${sha(`${system}\u0000${textOf(firstUser?.content)}`).slice(0, 16)}`;
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (isHumanTurn(m)) lastUser = i;
  });
  const userText = lastUser >= 0 ? textOf(messages[lastUser]!.content) : "";
  const runKey = exchange.run?.trim() || `${sessionKey}:u${lastUser}:${sha(userText).slice(0, 8)}`;

  const started = new Date(exchange.startedAt);
  const ended = new Date(exchange.endedAt);
  const failed = !!response.error;
  const finished = !failed && !response.toolCalls?.length && !!response.text;

  const blobs: NonNullable<NormalizedBatch["blobs"]> = [];
  const toolsRef = request.tools.length ? `tools:proxy:${sha(JSON.stringify(request.tools)).slice(0, 16)}` : undefined;
  if (toolsRef) blobs.push({ key: toolsRef, content: request.tools });
  const toolNames = request.tools
    .map((t) => (isRecord(t) && isRecord(t.function) ? str(t.function.name) : isRecord(t) ? str(t.name) : undefined))
    .filter((n): n is string => !!n);

  const steps: StepUpsert[] = [];
  steps.push({
    externalId: response.id ?? `${runKey}:${exchange.startedAt}`,
    runExternalId: runKey,
    kind: "llm",
    name: response.model ?? request.model ?? "LLM call",
    status: failed ? "error" : "ok",
    startedAt: started,
    endedAt: ended,
    durationMs: ended.getTime() - started.getTime(),
    model: response.model ?? request.model,
    provider: exchange.provider,
    usage: response.usage,
    reportedCostUsd: response.costUsd,
    input: messages,
    output: failed ? undefined : { text: response.text, toolCalls: response.toolCalls },
    error: response.error,
    attrs: {
      availableTools: toolNames.length ? toolNames : undefined,
      toolsRef,
      requestParams: Object.keys(request.params).length ? request.params : undefined,
      reasoning: response.reasoning || (response.toolCalls?.length ? response.text : undefined),
      stopReason: response.stopReason,
      requestId: response.id,
      extra: { api: exchange.api, stream: request.stream },
    },
  });

  // Tool calls made since the user's message, completed by the results the
  // agent sent back. Their ids are stable, so later calls simply update them.
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const m of messages.slice(lastUser + 1)) {
    for (const call of m.tool_calls ?? []) calls.set(call.id, { name: call.function.name, input: parseJson(call.function.arguments) });
    if (m.role === "tool" && m.tool_call_id && calls.has(m.tool_call_id)) {
      const call = calls.get(m.tool_call_id)!;
      const output = textOf(m.content);
      const bad = looksFailed(output);
      steps.push({
        externalId: m.tool_call_id,
        runExternalId: runKey,
        kind: "tool",
        name: call.name,
        toolName: call.name,
        toolCallId: m.tool_call_id,
        status: bad ? "error" : "ok",
        input: call.input,
        output: parseJson(output),
        error: bad ? firstLine(output, 300) : undefined,
        endedAt: started,
      });
    }
  }
  // Calls this response asks for: running until the next request brings results.
  for (const call of response.toolCalls ?? []) {
    if (!call.id) continue;
    steps.push({
      externalId: call.id,
      runExternalId: runKey,
      kind: "tool",
      name: call.name,
      toolName: call.name,
      toolCallId: call.id,
      status: "running",
      startedAt: ended,
      input: call.input,
    });
  }

  return {
    sessions: [{ harness, externalId: sessionKey, startedAt: started, lastEventAt: ended, userRef: exchange.user, metadata: { via: "proxy", provider: exchange.provider } }],
    runs: [
      {
        harness,
        externalId: runKey,
        sessionExternalId: sessionKey,
        source: "proxy",
        input: userText || undefined,
        name: firstLine(userText, 90),
        startedAt: started,
        endedAt: ended,
        status: failed ? "error" : finished ? "ok" : "running",
        output: finished ? response.text : undefined,
        model: response.model ?? request.model,
        systemPromptHash: system ? sha(system) : undefined,
      },
    ],
    steps,
    blobs,
  };
}
