import { createHash } from "node:crypto";
import type { NormalizedBatch, RunUpsert, SessionUpsert, StepUpsert } from "@lucid/schema";
import { firstLine, fromUnixNano, str } from "../util";
import {
  type Dialect,
  type Message,
  classifySpan,
  spanAgentName,
  spanAvailableTools,
  spanInputMessages,
  spanModel,
  spanOutputMessages,
  spanProvider,
  spanReportedCost,
  spanSessionId,
  spanTool,
  spanToolDefinitions,
  spanUsage,
} from "./genai";
import { type Attributes, type ExportTraceServiceRequest, type OtlpSpan, attributes } from "./types";

// Content attributes are stored as step input/output, not duplicated in attrs.
const CONTENT_KEY = /^(gen_ai\.(input|output)\.messages|gen_ai\.system_instructions|gen_ai\.tool\.definitions|gen_ai\.(prompt|completion)\.|gen_ai\.tool\.call\.(arguments|result)|llm\.(input|output)_messages\.|llm\.tools\.|input\.value|output\.value|ai\.prompt|ai\.response\.(text|toolCalls|object)|ai\.toolCall\.(args|result)|tool\.parameters)/;

export function detectHarness(resource: Attributes, scopeName: string, dialect: Dialect): string {
  const service = (str(resource["service.name"]) ?? "").toLowerCase();
  const scope = scopeName.toLowerCase();
  if (dialect === "claude-code" || service.includes("claude-code") || service.includes("claude_code")) return "claude-code";
  if (service.includes("codex")) return "codex";
  if (service.includes("gemini")) return "gemini-cli";
  if (scope.includes("openai_agents") || scope.includes("openai-agents") || scope === "openai.agents") return "openai-agents";
  if (scope.includes("langchain") || scope.includes("langgraph") || scope.includes("langsmith")) return "langchain";
  if (dialect === "vercel" || scope === "ai") return "vercel-ai";
  if (scope.includes("crewai")) return "crewai";
  if (scope.includes("pydantic") || scope.includes("logfire")) return "pydantic-ai";
  if (service && !service.startsWith("unknown_service")) return service;
  return "otel";
}

/** OTLP/JSON ids are hex; some exporters send base64 anyway. */
export function normalizeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (/^[0-9a-f]+$/i.test(id)) return /^0+$/.test(id) ? undefined : id.toLowerCase();
  try {
    const hex = Buffer.from(id, "base64").toString("hex");
    return hex && !/^0+$/.test(hex) ? hex : undefined;
  } catch {
    return undefined;
  }
}

function isError(span: OtlpSpan) {
  const code = span.status?.code;
  return code === 2 || code === "STATUS_CODE_ERROR" || code === "ERROR";
}

function exceptionMessage(span: OtlpSpan) {
  for (const event of span.events ?? []) {
    if (event.name !== "exception") continue;
    const attrs = attributes(event.attributes);
    return str(attrs["exception.message"]) ?? str(attrs["exception.type"]);
  }
  return undefined;
}

const lastOf = (messages: Message[] | undefined, role: string) =>
  [...(messages ?? [])].reverse().find((message) => message.role === role);

function extraAttrs(attrs: Attributes) {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (CONTENT_KEY.test(key)) continue;
    extra[key] = typeof value === "string" && value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  }
  return Object.keys(extra).length ? extra : undefined;
}

export function normalizeOtlpTraces(request: ExportTraceServiceRequest): NormalizedBatch {
  const sessions = new Map<string, SessionUpsert>();
  const runs = new Map<string, RunUpsert>();
  const steps: StepUpsert[] = [];
  const blobs = new Map<string, unknown>();

  for (const resourceSpans of request.resourceSpans ?? []) {
    const resource = attributes(resourceSpans.resource?.attributes);
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      const scopeName = scopeSpans.scope?.name ?? "";
      for (const span of scopeSpans.spans ?? []) {
        const traceId = normalizeId(span.traceId);
        const spanId = normalizeId(span.spanId);
        if (!traceId || !spanId) continue;
        const attrs = attributes(span.attributes);
        const spanName = span.name ?? "span";
        const { kind, dialect } = classifySpan(spanName, attrs);
        const harness = detectHarness(resource, scopeName, dialect);
        const parentId = normalizeId(span.parentSpanId);
        const startedAt = fromUnixNano(span.startTimeUnixNano);
        const endedAt = fromUnixNano(span.endTimeUnixNano);
        const failed = isError(span);
        const errorText = failed ? (span.status?.message || exceptionMessage(span) || "Failed") : undefined;

        // Claude Code tags its spans with the prompt id it also writes to the
        // transcript and hooks, so those sources land on the same run.
        const runKey = str(attrs["prompt.id"]) ?? traceId;
        const sessionId = spanSessionId(attrs) ?? spanSessionId(resource);
        if (sessionId) {
          const existing = sessions.get(sessionId);
          sessions.set(sessionId, {
            harness,
            externalId: sessionId,
            ...existing,
            lastEventAt: endedAt ?? startedAt,
            userRef: str(attrs["user.id"]) ?? str(attrs["enduser.id"]) ?? existing?.userRef,
          });
        }
        const run: RunUpsert = runs.get(runKey) ?? { harness, externalId: runKey, source: "otlp", sessionExternalId: sessionId };
        run.sessionExternalId ??= sessionId;

        const model = spanModel(attrs);
        const inputMessages = kind === "llm" ? spanInputMessages(attrs) : undefined;
        const outputMessages = kind === "llm" ? spanOutputMessages(attrs) : undefined;
        const answer = lastOf(outputMessages, "assistant") ?? outputMessages?.[outputMessages.length - 1];
        const tool = kind === "tool" ? spanTool(attrs) : undefined;
        // Every call repeats the same tool schemas: store them once, by content.
        const toolDefinitions = kind === "llm" ? spanToolDefinitions(attrs) : undefined;
        const toolsRef = toolDefinitions
          ? `tools:otel:${createHash("sha256").update(JSON.stringify(toolDefinitions)).digest("hex").slice(0, 16)}`
          : undefined;
        if (toolsRef) blobs.set(toolsRef, toolDefinitions);

        let name = spanName;
        if (kind === "llm") name = model ?? spanName;
        if (kind === "tool") name = tool?.name ?? spanName.replace(/^execute_tool\s+/, "");
        if (kind === "agent") name = spanAgentName(attrs) ?? spanName.replace(/^(invoke_agent|create_agent|invoke_workflow)\s+/, "");

        const step: StepUpsert = {
          externalId: spanId,
          runExternalId: runKey,
          parentExternalId: parentId,
          kind: failed && kind === "event" ? "error" : kind,
          name,
          status: failed ? "error" : endedAt ? "ok" : "running",
          startedAt,
          endedAt,
          durationMs: startedAt && endedAt ? endedAt.getTime() - startedAt.getTime() : undefined,
          model,
          provider: spanProvider(attrs),
          usage: kind === "llm" ? spanUsage(attrs, dialect) : undefined,
          reportedCostUsd: spanReportedCost(attrs),
          toolName: tool?.name,
          toolCallId: tool?.callId,
          input: kind === "llm" ? inputMessages : kind === "tool" ? tool?.args : (attrs["input.value"] ?? undefined),
          output:
            kind === "llm"
              ? answer
                ? { text: answer.content || undefined, toolCalls: answer.toolCalls }
                : undefined
              : kind === "tool"
                ? tool?.result
                : (attrs["output.value"] ?? undefined),
          error: errorText,
          attrs: {
            availableTools: kind === "llm" ? spanAvailableTools(attrs) : undefined,
            toolsRef,
            extra: extraAttrs({ ...attrs, "otel.scope": scopeName || undefined, "otel.dialect": dialect }),
          },
        };
        steps.push(step);

        if (!parentId) {
          run.name ??= firstLine(spanAgentName(attrs) ?? spanName, 90);
          run.startedAt = startedAt;
          run.endedAt = endedAt;
          run.status = failed ? "error" : endedAt ? "ok" : "running";
          const rootInput = str(attrs["input.value"]);
          const rootOutput = str(attrs["output.value"]);
          if (rootInput) run.input = rootInput;
          if (rootOutput) run.output = rootOutput;
        }
        if (kind === "llm") {
          run.model ??= model;
          const userMessage = lastOf(inputMessages, "user");
          if (!run.input && userMessage?.content) {
            run.input = userMessage.content;
            run.name = firstLine(userMessage.content, 90);
          }
          if (answer?.content && !answer.toolCalls?.length) run.output = answer.content;
        }
        if (failed && !parentId) run.status = "error";
        runs.set(runKey, run);
      }
    }
  }
  return {
    sessions: [...sessions.values()],
    runs: [...runs.values()],
    steps,
    blobs: [...blobs].map(([key, content]) => ({ key, content })),
  };
}
