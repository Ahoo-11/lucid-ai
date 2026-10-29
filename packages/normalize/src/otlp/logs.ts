// OTLP log events. Claude Code sends its telemetry as events (user_prompt,
// api_request, tool_result, …) tagged with session.id and prompt.id — the same
// ids its transcript and hooks use, so all three merge into one run.
// Unknown events are ignored here; the raw payload is still kept.

import type { NormalizedBatch, RunUpsert, SessionUpsert, StepUpsert } from "@lucid/schema";
import { firstLine, fromUnixNano, isRecord, num, parseJson, str, toDate } from "../util";
import { detectHarness } from "./traces";
import { type ExportLogsServiceRequest, anyValue, attributes } from "./types";

const PREFIXES = /^(claude_code|codex|gemini_cli)\./;

export function normalizeOtlpLogs(request: ExportLogsServiceRequest): NormalizedBatch {
  const sessions = new Map<string, SessionUpsert>();
  const runs = new Map<string, RunUpsert>();
  const steps = new Map<string, StepUpsert>();

  const put = (step: StepUpsert) => {
    const existing = steps.get(step.externalId);
    steps.set(step.externalId, existing ? { ...existing, ...step, attrs: { ...existing.attrs, ...step.attrs } } : step);
  };

  for (const resourceLogs of request.resourceLogs ?? []) {
    const resource = attributes(resourceLogs.resource?.attributes);
    for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
      for (const record of scopeLogs.logRecords ?? []) {
        const attrs = { ...resource, ...attributes(record.attributes) };
        const body = anyValue(record.body);
        const rawName = record.eventName ?? str(attrs["event.name"]) ?? (typeof body === "string" ? body : "");
        // Claude Code puts "api_request" in event.name and "claude_code.api_request" in the body.
        const prefix = PREFIXES.exec(rawName)?.[1] ?? PREFIXES.exec(typeof body === "string" ? body : "")?.[1];
        const event = rawName.replace(PREFIXES, "");
        const harness = prefix === "claude_code" ? "claude-code" : prefix === "codex" ? "codex" : prefix === "gemini_cli" ? "gemini-cli" : detectHarness(resource, scopeLogs.scope?.name ?? "", "native");
        if (harness !== "claude-code") continue;

        const at = toDate(str(attrs["event.timestamp"])) ?? fromUnixNano(record.timeUnixNano) ?? fromUnixNano(record.observedTimeUnixNano);
        const sessionId = str(attrs["session.id"]);
        const promptId = str(attrs["prompt.id"]);
        if (sessionId) sessions.set(sessionId, { harness, externalId: sessionId, lastEventAt: at, userRef: str(attrs["user.email"]) ?? str(attrs["user.account_uuid"]) });
        if (!promptId) continue;
        const run = runs.get(promptId) ?? { harness, externalId: promptId, source: "otlp" as const, sessionExternalId: sessionId };
        runs.set(promptId, run);

        if (event === "user_prompt") {
          const prompt = str(attrs.prompt);
          if (prompt) {
            run.input = prompt;
            run.name = firstLine(prompt, 90);
          }
          run.startedAt = at;
          continue;
        }

        if (event === "api_request" || event === "api_error") {
          const duration = num(attrs.duration_ms);
          const requestId = str(attrs.request_id) ?? str(attrs["request.id"]);
          const key = requestId ?? `${promptId}:${event}:${str(attrs["event.sequence"]) ?? at?.getTime() ?? steps.size}`;
          const failed = event === "api_error";
          put({
            externalId: key,
            runExternalId: promptId,
            kind: failed ? "error" : "llm",
            name: failed ? "API error" : (str(attrs.model) ?? "LLM call"),
            status: failed ? "error" : "ok",
            model: str(attrs.model),
            provider: "anthropic",
            startedAt: at && duration !== undefined ? new Date(at.getTime() - duration) : at,
            endedAt: at,
            durationMs: duration,
            usage: failed
              ? undefined
              : {
                  inputTokens: num(attrs.input_tokens),
                  outputTokens: num(attrs.output_tokens),
                  cacheReadTokens: num(attrs.cache_read_tokens),
                  cacheWriteTokens: num(attrs.cache_creation_tokens),
                },
            reportedCostUsd: failed ? undefined : num(attrs.cost_usd),
            error: failed ? (str(attrs.error) ?? `HTTP ${str(attrs.status_code) ?? "error"}`) : undefined,
            attrs: { requestId, extra: { attempt: num(attrs.attempt), speed: str(attrs.speed) } },
          });
          if (!run.model && !failed) run.model = str(attrs.model);
          continue;
        }

        if (event === "api_request_body" || event === "api_response_body") {
          const requestId = str(attrs.request_id) ?? str(attrs["request.id"]);
          const payload = parseJson(attrs.body ?? body);
          if (!requestId || !isRecord(payload)) continue;
          const tools = Array.isArray(payload.tools)
            ? payload.tools.map((tool) => (isRecord(tool) ? str(tool.name) : undefined)).filter((name): name is string => !!name)
            : undefined;
          put({
            externalId: requestId,
            runExternalId: promptId,
            kind: "llm",
            name: str(payload.model) ?? "LLM call",
            ...(event === "api_request_body" ? { input: payload } : { output: payload }),
            attrs: { availableTools: tools, requestId },
          });
          continue;
        }

        if (event === "tool_result") {
          const toolName = str(attrs.tool_name) ?? "Tool";
          const toolUseId = str(attrs.tool_use_id);
          const key = toolUseId ?? `${promptId}:tool:${str(attrs["event.sequence"]) ?? at?.getTime() ?? steps.size}`;
          const failed = attrs.success === false || attrs.success === "false";
          const duration = num(attrs.duration_ms);
          put({
            externalId: key,
            runExternalId: promptId,
            kind: toolName === "Agent" || toolName === "Task" ? "agent" : "tool",
            name: toolName,
            toolName,
            toolCallId: toolUseId,
            status: failed ? "error" : "ok",
            startedAt: at && duration !== undefined ? new Date(at.getTime() - duration) : undefined,
            endedAt: at,
            durationMs: duration,
            input: parseJson(attrs.tool_input ?? attrs.tool_parameters),
            error: failed ? (str(attrs.error) ?? "Tool failed") : undefined,
            attrs: { permissionDecision: str(attrs.decision) },
          });
          continue;
        }

        if (event === "tool_decision") {
          const toolUseId = str(attrs.tool_use_id);
          const toolName = str(attrs.tool_name) ?? "Tool";
          if (!toolUseId) continue;
          put({
            externalId: toolUseId,
            runExternalId: promptId,
            kind: toolName === "Agent" || toolName === "Task" ? "agent" : "tool",
            name: toolName,
            toolName,
            attrs: { permissionDecision: str(attrs.decision), extra: { decisionSource: str(attrs.source) } },
          });
          continue;
        }

        if (event === "assistant_response") {
          const text = str(attrs.response) ?? str(attrs.content);
          if (text) run.output = text;
        }
      }
    }
  }

  return { sessions: [...sessions.values()], runs: [...runs.values()], steps: [...steps.values()] };
}
