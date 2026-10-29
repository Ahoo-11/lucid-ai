// Claude Code session transcripts: ~/.claude/projects/<cwd>/<session>.jsonl and
// sub-agent transcripts in <session>/subagents/agent-<id>.jsonl.
//
// The format is not a public contract, so every field is optional here. What
// recent versions write, and how it maps:
//   user (string content, promptId)   → a Run (one user request)
//   assistant (one line per block,    → one LLM step per API request, keyed by
//     shared requestId / message.id)     requestId so OTel api_request events merge in
//   assistant tool_use block          → a Tool step keyed by tool_use id (hooks merge in)
//   user tool_result block            → completes that Tool step
//   api-request / api-request-shape   → model params and the tools the model could pick
//   custom-title                      → session title
// Files are uploaded in chunks, so parsing is resumable through `state`.

import { createHash } from "node:crypto";
import type { NormalizedBatch, RunUpsert, SessionUpsert, StepKind, StepUpsert } from "@lucid/schema";
import { contentText, firstLine, isRecord, num, str, toDate } from "../util";

export type ClaudeTranscriptFile = {
  kind: "main" | "subagent";
  agentId?: string;
  /** From agent-<id>.meta.json: the Agent tool call that launched this sub-agent. */
  parentToolUseId?: string;
  agentType?: string;
  description?: string;
};

type OpenMessage = {
  key: string;
  runId: string;
  model?: string;
  requestRef?: string;
  requestId?: string;
  text: string[];
  reasoning: string[];
  toolCalls: { id: string; name: string; input: unknown }[];
  usage?: Record<string, unknown>;
  stopReason?: string;
  firstAt?: string;
  lastAt?: string;
  isSidechain?: boolean;
  seq: number;
};

export type ClaudeTranscriptState = {
  sessionId?: string;
  promptId?: string;
  /** Prompt ids that already have their input recorded. */
  seenPrompts: string[];
  shapes: Record<string, { tools: string[]; systemHash?: string }>;
  requests: Record<string, { model?: string; shapeHash?: string; params?: Record<string, unknown>; at?: string }>;
  requestOrder: string[];
  message?: OpenMessage;
  pendingTools: Record<string, { name: string; kind: StepKind; runId: string }>;
  seq: number;
};

export const initialClaudeTranscriptState = (): ClaudeTranscriptState => ({
  seenPrompts: [],
  shapes: {},
  requests: {},
  requestOrder: [],
  pendingTools: {},
  seq: 0,
});

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const MAX_REQUESTS = 40;
const MAX_SEEN_PROMPTS = 200;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function toolKind(name: string): StepKind {
  return AGENT_TOOLS.has(name) ? "agent" : "tool";
}

function toolStepName(name: string, input: unknown) {
  if (AGENT_TOOLS.has(name) && isRecord(input)) return str(input.description) ?? name;
  return name;
}

function usageOf(raw: Record<string, unknown> | undefined) {
  if (!raw) return undefined;
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : undefined;
  return {
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    cacheReadTokens: num(raw.cache_read_input_tokens),
    cacheWriteTokens: num(raw.cache_creation_input_tokens),
    reasoningTokens: num(details?.thinking_tokens) ?? num(details?.reasoning_tokens),
  };
}

export function normalizeClaudeTranscript(
  lines: unknown[],
  file: ClaudeTranscriptFile,
  previous: ClaudeTranscriptState = initialClaudeTranscriptState(),
): { batch: NormalizedBatch; state: ClaudeTranscriptState } {
  const state: ClaudeTranscriptState = structuredClone(previous);
  const sessions = new Map<string, SessionUpsert>();
  const runs = new Map<string, RunUpsert>();
  const steps = new Map<string, StepUpsert>();
  const harness = "claude-code";

  const touchSession = (patch: Partial<SessionUpsert>) => {
    if (!state.sessionId) return;
    const existing = sessions.get(state.sessionId) ?? { harness, externalId: state.sessionId };
    sessions.set(state.sessionId, { ...existing, ...definedOnly(patch) });
  };
  const touchRun = (runId: string, patch: Partial<RunUpsert>) => {
    const existing = runs.get(runId) ?? { harness, externalId: runId, source: "transcript", sessionExternalId: state.sessionId };
    runs.set(runId, { ...existing, ...definedOnly(patch) });
  };
  const putStep = (step: StepUpsert) => {
    const existing = steps.get(step.externalId);
    steps.set(step.externalId, existing ? { ...existing, ...definedOnly(step), attrs: { ...existing.attrs, ...step.attrs } } : step);
  };

  const flushMessage = (final: boolean) => {
    const message = state.message;
    if (!message) return;
    const request = message.requestRef ? state.requests[message.requestRef] : undefined;
    const shape = request?.shapeHash ? state.shapes[request.shapeHash] : undefined;
    putStep({
      externalId: message.key,
      runExternalId: message.runId,
      parentExternalId: file.parentToolUseId,
      kind: "llm",
      name: message.model ?? request?.model ?? "LLM call",
      status: "ok",
      startedAt: toDate(request?.at) ?? toDate(message.firstAt),
      endedAt: toDate(message.lastAt),
      model: message.model ?? request?.model,
      provider: "anthropic",
      usage: usageOf(message.usage),
      output: {
        text: message.text.join("\n\n") || undefined,
        toolCalls: message.toolCalls.length > 0 ? message.toolCalls : undefined,
      },
      seq: message.seq,
      attrs: {
        availableTools: shape?.tools,
        reasoning: [...message.reasoning, ...(message.toolCalls.length > 0 ? message.text : [])].filter(Boolean).join("\n\n") || undefined,
        stopReason: message.stopReason,
        requestParams: request?.params,
        requestId: message.requestId,
        isSidechain: message.isSidechain || undefined,
        agentId: file.agentId,
      },
    });
    if (shape?.systemHash && file.kind === "main") touchRun(message.runId, { systemPromptHash: shape.systemHash });
    if (message.model && file.kind === "main") touchRun(message.runId, { model: message.model });

    // A turn is over when the model stops on its own and no tool call is open.
    const finished = message.stopReason === "end_turn" || message.stopReason === "stop_sequence";
    if (finished && message.toolCalls.length === 0) {
      const answer = message.text.join("\n\n") || undefined;
      if (file.kind === "main") {
        touchRun(message.runId, { status: "ok", output: answer, endedAt: toDate(message.lastAt) });
      } else if (file.parentToolUseId) {
        putStep({
          externalId: file.parentToolUseId,
          runExternalId: message.runId,
          kind: "agent",
          name: file.description ?? file.agentType ?? "Sub-agent",
          status: "ok",
          output: answer,
          endedAt: toDate(message.lastAt),
        });
      }
    }
    if (final) state.message = undefined;
  };

  let lastAt: string | undefined;
  for (const raw of lines) {
    if (!isRecord(raw)) continue;
    const line = raw;
    const type = str(line.type);
    const at = str(line.timestamp);
    if (at) lastAt = at;
    if (!state.sessionId && str(line.sessionId)) state.sessionId = str(line.sessionId);

    if (type === "custom-title") {
      touchSession({ title: str(line.customTitle) });
      continue;
    }

    if (type === "api-request-shape" && str(line.shapeHash) && isRecord(line.shape)) {
      const tools = Array.isArray(line.shape.tools)
        ? line.shape.tools.map((tool) => (isRecord(tool) ? str(tool.name) : undefined)).filter((name): name is string => !!name)
        : [];
      const system = Array.isArray(line.shape.system) ? contentText(line.shape.system) : "";
      state.shapes[line.shapeHash as string] = { tools, systemHash: system ? sha256(system) : undefined };
      continue;
    }

    if (type === "api-request" && str(line.id)) {
      const params = isRecord(line.params) ? line.params : {};
      const outputConfig = isRecord(params.output_config) ? params.output_config : undefined;
      state.requests[line.id as string] = {
        model: str(params.model),
        shapeHash: str(line.shapeHash),
        at,
        params: definedOnly({
          max_tokens: num(params.max_tokens),
          thinking: isRecord(params.thinking) ? str(params.thinking.type) : undefined,
          effort: str(outputConfig?.effort),
          temperature: num(params.temperature),
        }),
      };
      state.requestOrder.push(line.id as string);
      while (state.requestOrder.length > MAX_REQUESTS) delete state.requests[state.requestOrder.shift() as string];
      continue;
    }

    if (type !== "user" && type !== "assistant" && type !== "system") continue;
    const message = isRecord(line.message) ? line.message : undefined;

    if (type === "user" && message) {
      const content = message.content;
      const toolResults = Array.isArray(content) ? content.filter((block) => isRecord(block) && block.type === "tool_result") : [];
      const runId = str(line.promptId) ?? state.promptId;

      if (toolResults.length > 0) {
        flushMessage(true);
        for (const block of toolResults as Record<string, unknown>[]) {
          const toolUseId = str(block.tool_use_id);
          if (!toolUseId || !runId) continue;
          const pending = state.pendingTools[toolUseId];
          const isError = block.is_error === true;
          const text = contentText(block.content);
          const decision = isRecord(line.permissionDecision) ? str(line.permissionDecision.decision) : undefined;
          putStep({
            externalId: toolUseId,
            runExternalId: pending?.runId ?? runId,
            parentExternalId: file.parentToolUseId,
            kind: pending?.kind ?? "tool",
            name: pending?.name ?? "Tool",
            status: isError ? "error" : pending?.kind === "agent" && isAsyncLaunch(line.toolUseResult) ? "running" : "ok",
            output: text || line.toolUseResult,
            error: isError ? firstLine(text, 500) ?? "Tool failed" : undefined,
            endedAt: isAsyncLaunch(line.toolUseResult) ? undefined : toDate(at),
            attrs: { permissionDecision: decision },
          });
          delete state.pendingTools[toolUseId];
        }
        if (runId && file.kind === "main") touchRun(runId, { endedAt: toDate(at) });
        continue;
      }

      // A plain user message: a new request in the main thread, or the task
      // prompt that opens a sub-agent transcript.
      if (file.kind === "subagent") {
        if (runId) state.promptId = runId;
        continue;
      }
      if (line.isMeta === true) continue;
      const text = contentText(content).trim();
      const promptId = runId ?? str(line.uuid);
      if (!promptId || !text) continue;
      flushMessage(true);
      state.promptId = promptId;
      if (!state.seenPrompts.includes(promptId)) {
        state.seenPrompts.push(promptId);
        if (state.seenPrompts.length > MAX_SEEN_PROMPTS) state.seenPrompts.shift();
        const origin = isRecord(line.origin) ? str(line.origin.kind) : undefined;
        touchRun(promptId, {
          input: text,
          name: promptTitle(text),
          startedAt: toDate(at),
          status: "running",
          metadata: definedOnly({ origin, promptSource: str(line.promptSource), systemTurn: text.startsWith("<") || undefined }),
        });
      }
      touchSession({
        cwd: str(line.cwd),
        gitBranch: str(line.gitBranch),
        startedAt: toDate(at),
        lastEventAt: toDate(at),
      });
      continue;
    }

    if (type === "assistant" && message) {
      const runId = state.promptId ?? str(line.promptId);
      if (!runId) continue;
      const key = str(line.requestId) ?? str(message.id) ?? str(line.uuid);
      if (!key) continue;
      if (state.message?.key !== key) {
        flushMessage(true);
        state.message = { key, runId, text: [], reasoning: [], toolCalls: [], firstAt: at, seq: state.seq++ };
      }
      const open = state.message as OpenMessage;
      open.model = str(message.model) ?? open.model;
      open.requestRef = str(line.requestRef) ?? open.requestRef;
      open.requestId = str(line.requestId) ?? open.requestId;
      open.usage = isRecord(message.usage) ? message.usage : open.usage;
      open.stopReason = str(message.stop_reason) ?? open.stopReason;
      open.lastAt = at ?? open.lastAt;
      open.isSidechain = line.isSidechain === true || open.isSidechain;

      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && str(block.text)) open.text.push(block.text as string);
        if (block.type === "thinking" && str(block.thinking)) open.reasoning.push(block.thinking as string);
        if (block.type === "tool_use" && str(block.id) && str(block.name)) {
          const name = block.name as string;
          const id = block.id as string;
          if (open.toolCalls.some((call) => call.id === id)) continue;
          open.toolCalls.push({ id, name, input: block.input });
          const kind = toolKind(name);
          const stepName = toolStepName(name, block.input);
          state.pendingTools[id] = { name: stepName, kind, runId };
          putStep({
            externalId: id,
            runExternalId: runId,
            parentExternalId: file.parentToolUseId,
            kind,
            name: stepName,
            status: "running",
            startedAt: toDate(at),
            toolName: name,
            toolCallId: id,
            input: block.input,
            seq: state.seq++,
            attrs: { extra: { calledBy: key }, agentId: file.agentId },
          });
        }
      }

      if (line.isApiErrorMessage === true) {
        putStep({
          externalId: `${str(line.uuid) ?? key}:error`,
          runExternalId: runId,
          parentExternalId: file.parentToolUseId,
          kind: "error",
          name: "API error",
          status: "error",
          startedAt: toDate(at),
          error: contentText(message.content) || "API error",
          seq: state.seq++,
        });
        if (file.kind === "main") touchRun(runId, { status: "error" });
      }
      if (file.kind === "main") touchRun(runId, { endedAt: toDate(at) });
      continue;
    }

    if (type === "system" && (line.level === "error" || line.subtype === "api_error")) {
      const runId = state.promptId;
      if (!runId) continue;
      // api_error lines are retried requests: { error: { formatted, message }, retryAttempt, maxRetries }.
      const error = isRecord(line.error) ? line.error : undefined;
      const attempt = num(line.retryAttempt);
      const maxRetries = num(line.maxRetries);
      putStep({
        externalId: str(line.uuid) ?? `system:${state.seq}`,
        runExternalId: runId,
        parentExternalId: file.parentToolUseId,
        kind: "error",
        name: line.subtype === "api_error" ? `API error${attempt ? ` (retry ${attempt}${maxRetries ? ` of ${maxRetries}` : ""})` : ""}` : "Harness error",
        status: "error",
        startedAt: toDate(at),
        error: str(error?.formatted) ?? str(error?.message) ?? str(line.content) ?? str(line.subtype) ?? "Error",
        seq: state.seq++,
        attrs: { extra: definedOnly({ retryAttempt: attempt, maxRetries, retryInMs: num(line.retryInMs), source: str(line.source) }) },
      });
    }
  }

  // Emit the message still open at the end of this chunk; it stays in state so
  // the next chunk can add the rest of its blocks.
  flushMessage(false);
  touchSession({ lastEventAt: toDate(lastAt) });

  return {
    batch: { sessions: [...sessions.values()], runs: [...runs.values()], steps: [...steps.values()] },
    state,
  };
}

/**
 * Harness-injected turns (background task notifications, slash-command
 * output) arrive as XML-ish text; name them by their summary, not by the tag.
 */
export function promptTitle(text: string) {
  if (!text.startsWith("<")) return firstLine(text, 90);
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1];
  const plain = (summary ?? text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return firstLine(plain, 90) ?? "System message";
}

function isAsyncLaunch(result: unknown) {
  return isRecord(result) && (result.isAsync === true || result.status === "async_launched");
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
