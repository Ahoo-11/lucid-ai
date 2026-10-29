// Hermes Agent observer hooks (telemetry_schema_version "hermes.observer.v1"),
// as forwarded by the Lucid Hermes plugin: { hook, ts, ...hook kwargs }.
//
//   pre_llm_call / post_llm_call      → a Run per user turn (turn_id)
//   pre_api_request / post_api_request → an LLM step per provider attempt (api_request_id)
//   api_request_error                 → that LLM step fails, plus an error step per attempt
//   pre_tool_call / post_tool_call    → a Tool step (tool_call_id)
//   subagent_start / subagent_stop    → a Sub-agent step; the plugin tags the
//                                       child's events with lucid_root_turn_id
//                                       and lucid_parent_step so they nest under it
//   pre_approval_request / post_approval_response → a Decision step (allowed / denied)
//
// Hermes token counts follow the same convention as Lucid: input_tokens
// excludes cache reads and writes.

import type { NormalizedBatch, RunUpsert, SessionUpsert, StepUpsert } from "@lucid/schema";
import { firstLine, isRecord, num, parseJson, str } from "../util";

export type HermesEvent = Record<string, unknown> & { hook: string; ts?: number };

const HARNESS = "hermes";
const DELEGATE_TOOLS = new Set(["delegate_task", "delegate"]);

const fromEpochSeconds = (value: unknown) => {
  const seconds = num(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000) : undefined;
};

const definedOnly = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

function toolCallsOf(message: unknown) {
  if (!isRecord(message) || !Array.isArray(message.tool_calls)) return undefined;
  const calls = message.tool_calls.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : call;
    return { id: str(call.id) ?? str(call.call_id), name: str(fn.name) ?? "tool", input: parseJson(fn.arguments ?? call.input) };
  });
  return calls.length ? calls : undefined;
}

function requestParams(body: Record<string, unknown> | undefined) {
  if (!body) return undefined;
  const params = definedOnly({
    max_tokens: num(body.max_tokens) ?? num(body.max_completion_tokens),
    temperature: num(body.temperature),
    top_p: num(body.top_p),
    reasoning: isRecord(body.reasoning) ? str(body.reasoning.effort) : str(body.reasoning_effort),
  });
  return Object.keys(params).length ? params : undefined;
}

/**
 * Provider SDK errors arrive as Python reprs, e.g.
 * "Error code: 401 - {'error': {'message': 'User not found.', 'code': 401}}".
 * Keep the human part: "HTTP 401: User not found."
 */
export function providerError(raw: string | undefined, statusCode: number | undefined) {
  const code = statusCode ?? num(/Error code: (\d{3})/.exec(raw ?? "")?.[1]);
  const inner = /['"]message['"]\s*:\s*['"]([^'"]+)['"]/.exec(raw ?? "")?.[1];
  const text = inner ?? raw;
  if (code && text) return text.includes(String(code)) ? text : `HTTP ${code}: ${text}`;
  return text ?? (code ? `HTTP ${code}` : "API request failed");
}

export function normalizeHermesEvents(events: HermesEvent[]): NormalizedBatch {
  const sessions = new Map<string, SessionUpsert>();
  const runs = new Map<string, RunUpsert>();
  const steps: StepUpsert[] = [];
  const blobs: NonNullable<NormalizedBatch["blobs"]> = [];

  const touchSession = (id: string | undefined, patch: Partial<SessionUpsert> = {}) => {
    if (!id) return;
    sessions.set(id, { ...(sessions.get(id) ?? { harness: HARNESS, externalId: id }), ...definedOnly(patch) });
  };
  const touchRun = (id: string, patch: Partial<RunUpsert>) => {
    const existing = runs.get(id) ?? { harness: HARNESS, externalId: id, source: "hook" as const };
    runs.set(id, { ...existing, ...definedOnly(patch) });
  };

  for (const event of events) {
    if (!isRecord(event) || typeof event.hook !== "string") continue;
    const at = fromEpochSeconds(event.ts);
    // Sub-agent events belong to the parent's run and session.
    const child = !!str(event.lucid_root_turn_id);
    const runId = str(event.lucid_root_turn_id) ?? str(event.turn_id) ?? str(event.parent_turn_id) ?? str(event.lucid_turn_id);
    const sessionId = str(event.lucid_root_session_id) ?? str(event.session_id) ?? str(event.parent_session_id);
    const parent = str(event.lucid_parent_step);
    touchSession(sessionId, { lastEventAt: at });

    switch (event.hook) {
      case "on_session_start":
        if (!child) touchSession(sessionId, { startedAt: at, metadata: definedOnly({ platform: str(event.platform), model: str(event.model) }) });
        break;

      case "pre_llm_call": {
        if (child || !runId) break;
        const message = str(event.user_message);
        touchRun(runId, {
          sessionExternalId: sessionId,
          input: message,
          name: firstLine(message, 90),
          startedAt: at,
          status: "running",
          model: str(event.model),
          metadata: definedOnly({ platform: str(event.platform), sender: str(event.sender_id) }),
        });
        break;
      }

      case "post_llm_call":
        if (child || !runId) break;
        touchRun(runId, { sessionExternalId: sessionId, status: "ok", output: str(event.assistant_response), endedAt: at });
        break;

      case "on_session_end": {
        // Turn-scoped in Hermes; a failed or interrupted turn never reaches post_llm_call.
        if (child || !runId) break;
        const reason = str(event.turn_exit_reason) ?? str(event.reason);
        if (event.failed === true || event.interrupted === true) {
          touchRun(runId, { status: "error", endedAt: at, metadata: definedOnly({ exitReason: reason, interrupted: event.interrupted === true || undefined }) });
        } else if (event.completed === true) {
          touchRun(runId, { status: "ok", endedAt: at, metadata: definedOnly({ exitReason: reason }) });
        }
        break;
      }

      case "pre_api_request": {
        const id = str(event.api_request_id);
        if (!id || !runId) break;
        const request = isRecord(event.request) ? event.request : undefined;
        const body = isRecord(request?.body) ? request.body : undefined;
        const toolNames = Array.isArray(event.tool_names) ? event.tool_names.filter((n): n is string => typeof n === "string") : undefined;
        // The plugin sends full tool schemas once per distinct set, and the
        // set's hash on every call; replaying a decision needs the schemas.
        const toolsRef = str(event.tools_hash) ? `tools:hermes:${event.tools_hash}` : undefined;
        if (toolsRef && Array.isArray(event.tools_def)) blobs.push({ key: toolsRef, content: event.tools_def });
        if (!child) touchRun(runId, { sessionExternalId: sessionId, model: str(event.model) });
        steps.push({
          externalId: id,
          runExternalId: runId,
          parentExternalId: parent,
          kind: "llm",
          name: str(event.model) ?? "LLM call",
          status: "running",
          startedAt: fromEpochSeconds(event.started_at) ?? at,
          model: str(event.model),
          provider: str(event.provider),
          input: Array.isArray(body?.messages) ? body.messages : undefined,
          attrs: {
            availableTools: toolNames,
            toolsRef,
            requestParams: requestParams(body),
            extra: definedOnly({ apiMode: str(event.api_mode), platform: str(event.platform), attempt: num(event.api_call_count), messageCount: num(event.message_count) }),
          },
        });
        break;
      }

      case "post_api_request": {
        const id = str(event.api_request_id);
        if (!id || !runId) break;
        const response = isRecord(event.response) ? event.response : undefined;
        const message = isRecord(response?.assistant_message) ? response.assistant_message : undefined;
        const usage = isRecord(event.usage) ? event.usage : isRecord(response?.usage) ? response.usage : undefined;
        const text = str(message?.content);
        const duration = num(event.api_duration);
        steps.push({
          externalId: id,
          runExternalId: runId,
          parentExternalId: parent,
          kind: "llm",
          name: str(event.response_model) ?? str(event.model) ?? "LLM call",
          status: "ok",
          startedAt: fromEpochSeconds(event.started_at),
          endedAt: fromEpochSeconds(event.ended_at) ?? at,
          durationMs: duration !== undefined ? Math.round(duration * 1000) : undefined,
          model: str(event.response_model) ?? str(event.model),
          provider: str(event.provider),
          usage: usage && {
            inputTokens: num(usage.input_tokens),
            outputTokens: num(usage.output_tokens),
            cacheReadTokens: num(usage.cache_read_tokens),
            cacheWriteTokens: num(usage.cache_write_tokens),
            reasoningTokens: num(usage.reasoning_tokens),
          },
          output: { text, toolCalls: toolCallsOf(message) },
          attrs: {
            stopReason: str(event.finish_reason) ?? str(response?.finish_reason),
            reasoning: str(event.reasoning),
          },
        });
        break;
      }

      case "api_request_error": {
        const id = str(event.api_request_id);
        if (!id || !runId) break;
        const error = isRecord(event.error) ? event.error : undefined;
        const message = providerError(str(error?.message) ?? str(event.reason), num(event.status_code));
        const retry = num(event.retry_count) || undefined;
        const max = num(event.max_retries);
        // One step per attempt (each retry has its own api_request_id), so the
        // failure lives on the model call itself rather than a second error step.
        steps.push({
          externalId: id,
          runExternalId: runId,
          parentExternalId: parent,
          kind: "llm",
          name: str(event.model) ?? "LLM call",
          status: "error",
          error: message,
          startedAt: fromEpochSeconds(event.started_at),
          endedAt: fromEpochSeconds(event.ended_at) ?? at,
          attrs: {
            extra: definedOnly({
              statusCode: num(event.status_code),
              retryable: typeof event.retryable === "boolean" ? event.retryable : undefined,
              retry: retry !== undefined ? `${retry}${max ? ` of ${max}` : ""}` : undefined,
              type: str(error?.type),
              reason: str(event.reason),
            }),
          },
        });
        // Hermes ends the turn on an error it won't retry (e.g. a rejected key)
        // without firing post_llm_call or on_session_end, so this is the end.
        const final = event.retryable === false || (retry !== undefined && max !== undefined && retry >= max);
        if (final && !child) touchRun(runId, { status: "error", endedAt: fromEpochSeconds(event.ended_at) ?? at, metadata: definedOnly({ exitReason: str(event.reason) ?? "api_error" }) });
        if (final && child && parent) {
          steps.push({ externalId: parent, runExternalId: runId, kind: "agent", name: "Sub-agent", status: "error", error: message, endedAt: at });
        }
        break;
      }

      case "pre_tool_call":
      case "post_tool_call": {
        const id = str(event.tool_call_id) ?? str(event.lucid_tool_id);
        const toolName = str(event.tool_name) ?? "Tool";
        if (!id || !runId) break;
        const post = event.hook === "post_tool_call";
        const status = str(event.status) ?? "ok";
        const failed = post && status !== "ok";
        const reason =
          status === "blocked"
            ? `Blocked: ${str(event.error_message) ?? "a hook stopped this tool"}`
            : status === "cancelled"
              ? "Cancelled before it finished"
              : (str(event.error_message) ?? str(event.error_type) ?? "Tool failed");
        steps.push({
          externalId: id,
          runExternalId: runId,
          parentExternalId: parent,
          kind: DELEGATE_TOOLS.has(toolName) ? "agent" : "tool",
          name: toolName,
          toolName,
          toolCallId: str(event.tool_call_id),
          status: post ? (failed ? "error" : "ok") : "running",
          startedAt: post ? undefined : at,
          endedAt: post ? at : undefined,
          durationMs: post ? num(event.duration_ms) : undefined,
          input: post ? undefined : parseJson(event.args),
          output: post ? parseJson(event.result) : undefined,
          error: failed ? reason : undefined,
          attrs: post ? { extra: definedOnly({ outcome: status }) } : { extra: definedOnly({ calledBy: str(event.api_request_id) }) },
        });
        break;
      }

      case "subagent_start":
      case "subagent_stop": {
        const childSession = str(event.child_session_id);
        if (!childSession || !runId) break;
        const stop = event.hook === "subagent_stop";
        const childStatus = str(event.child_status)?.toLowerCase();
        const failed = stop && !!childStatus && !["ok", "completed", "success", "done"].includes(childStatus);
        const goal = str(event.child_goal);
        const history = Array.isArray(event.tool_call_history) ? event.tool_call_history.length : undefined;
        steps.push({
          externalId: `subagent:${childSession}`,
          runExternalId: runId,
          parentExternalId: parent,
          kind: "agent",
          name: firstLine(goal, 80) ?? str(event.child_role) ?? "Sub-agent",
          status: stop ? (failed ? "error" : "ok") : "running",
          startedAt: stop ? undefined : at,
          endedAt: stop ? at : undefined,
          durationMs: stop ? num(event.duration_ms) : undefined,
          input: stop ? undefined : goal,
          output: stop ? str(event.child_summary) : undefined,
          error: failed ? `Sub-agent ended with status ${childStatus}` : undefined,
          attrs: { agentId: childSession, extra: definedOnly({ role: str(event.child_role), toolCalls: history }) },
        });
        break;
      }

      case "pre_approval_request":
      case "post_approval_response": {
        const id = str(event.lucid_approval_id);
        if (!id || !runId) break;
        const post = event.hook === "post_approval_response";
        const choice = str(event.choice);
        const denied = !!choice && ["deny", "timeout", "cancelled"].includes(choice);
        const command = str(event.command);
        steps.push({
          externalId: id,
          runExternalId: runId,
          parentExternalId: parent,
          kind: "decision",
          name: `Approval: ${firstLine(str(event.description) ?? command, 70) ?? "dangerous command"}`,
          status: post ? "ok" : "running",
          startedAt: post ? undefined : at,
          endedAt: post ? at : undefined,
          input: post ? undefined : definedOnly({ command, description: str(event.description), pattern: str(event.pattern_key) }),
          output: post ? choice : undefined,
          attrs: post ? { permissionDecision: denied ? `denied (${choice})` : `allowed (${choice})` } : undefined,
        });
        break;
      }
    }
  }

  return { sessions: [...sessions.values()], runs: [...runs.values()], steps, blobs };
}
