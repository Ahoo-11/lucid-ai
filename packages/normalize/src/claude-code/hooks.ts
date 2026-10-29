// Claude Code hook payloads (https://code.claude.com/docs/en/hooks). Hooks fire
// live, so they make a run appear while it is still going; the transcript
// upload that follows each hook fills in the full detail. Steps share keys with
// the transcript (prompt_id, tool_use_id), so both sources merge into one run.

import type { NormalizedBatch, StepUpsert } from "@lucid/schema";
import { emptyBatch } from "@lucid/schema";
import { firstLine, isRecord, num, str } from "../util";

const AGENT_TOOLS = new Set(["Agent", "Task"]);

export function normalizeClaudeHook(payload: unknown, receivedAt = new Date()): NormalizedBatch {
  const batch = emptyBatch();
  if (!isRecord(payload)) return batch;
  const event = str(payload.hook_event_name);
  const sessionId = str(payload.session_id);
  const promptId = str(payload.prompt_id);
  const harness = "claude-code";
  if (!sessionId) return batch;

  batch.sessions.push({ harness, externalId: sessionId, cwd: str(payload.cwd), lastEventAt: receivedAt });

  if (event === "SessionStart") {
    batch.sessions[0] = { ...batch.sessions[0]!, startedAt: receivedAt, metadata: { model: str(payload.model), source: str(payload.source) } };
    return batch;
  }
  // Without a prompt id there is nothing to key a run on; the transcript covers it.
  if (!promptId) return batch;

  if (event === "UserPromptSubmit") {
    const prompt = str(payload.prompt);
    batch.runs.push({
      harness,
      externalId: promptId,
      sessionExternalId: sessionId,
      source: "hook",
      input: prompt,
      name: firstLine(prompt, 90),
      startedAt: receivedAt,
      status: "running",
    });
    return batch;
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const toolUseId = str(payload.tool_use_id);
    const toolName = str(payload.tool_name) ?? "Tool";
    if (!toolUseId) return batch;
    const failed = event === "PostToolUseFailure";
    const input = payload.tool_input;
    const step: StepUpsert = {
      externalId: toolUseId,
      runExternalId: promptId,
      kind: AGENT_TOOLS.has(toolName) ? "agent" : "tool",
      name: AGENT_TOOLS.has(toolName) && isRecord(input) ? str(input.description) ?? toolName : toolName,
      toolName,
      toolCallId: toolUseId,
      input,
      output: failed ? undefined : payload.tool_response,
      status: failed ? "error" : "ok",
      error: failed ? str(payload.error) ?? (payload.is_interrupt === true ? "Interrupted by the user" : "Tool failed") : undefined,
      durationMs: num(payload.duration_ms),
      endedAt: receivedAt,
    };
    batch.runs.push({ harness, externalId: promptId, sessionExternalId: sessionId, source: "hook" });
    batch.steps.push(step);
    return batch;
  }

  if (event === "Stop" || event === "StopFailure") {
    batch.runs.push({
      harness,
      externalId: promptId,
      sessionExternalId: sessionId,
      source: "hook",
      status: event === "StopFailure" ? "error" : "ok",
      output: str(payload.last_assistant_message),
      endedAt: receivedAt,
    });
  }
  return batch;
}
