// Hermes session history from state.db (sessions + messages tables), for
// `lucid import hermes`. Each user message starts a Run; assistant messages
// are LLM steps; tool messages complete the tool calls the assistant made.
// Sub-agent sessions (parent_session_id) nest under the parent run that was
// active when they started.
//
// History has no per-call timing or token usage: durations are the gap since
// the previous message, and cost is only known per session (kept on the
// session's metadata).

import type { NormalizedBatch, RunUpsert, SessionUpsert, StepUpsert } from "@lucid/schema";
import { firstLine, isRecord, num, parseJson, str } from "../util";

export type HermesSessionRow = Record<string, unknown> & { id: string; parent_session_id?: string | null; started_at?: number | null };
export type HermesMessageRow = Record<string, unknown> & { id: number; session_id: string; role: string; timestamp?: number | null };

const HARNESS = "hermes";

const fromEpochSeconds = (value: unknown) => {
  const seconds = num(value);
  return seconds && seconds > 0 ? new Date(seconds * 1000) : undefined;
};

const definedOnly = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;

function toolCalls(raw: unknown) {
  const parsed = parseJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((call) => {
    const fn = isRecord(call.function) ? call.function : call;
    return { id: str(call.id) ?? str(call.call_id), name: str(fn.name) ?? "tool", input: parseJson(fn.arguments) };
  });
}

/** Hermes stores tool results as text; failures are JSON with an error, or an error string. */
export function toolResultFailed(content: unknown) {
  const parsed = parseJson(content);
  if (isRecord(parsed)) {
    if (parsed.success === false || parsed.ok === false || parsed.status === "error") return true;
    return typeof parsed.error === "string" ? parsed.error.length > 0 : !!parsed.error;
  }
  return typeof parsed === "string" && /^(error\b|traceback \(most recent call last\))/i.test(parsed.trim());
}

function errorText(content: unknown) {
  const parsed = parseJson(content);
  if (isRecord(parsed) && parsed.error) return typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
  return firstLine(typeof parsed === "string" ? parsed : JSON.stringify(parsed), 500);
}

export function normalizeHermesHistory(input: { sessions: HermesSessionRow[]; messages: HermesMessageRow[] }): NormalizedBatch {
  const sessions: SessionUpsert[] = [];
  const runs = new Map<string, RunUpsert>();
  const steps: StepUpsert[] = [];

  const bySession = new Map<string, HermesMessageRow[]>();
  for (const message of input.messages) {
    const list = bySession.get(message.session_id) ?? [];
    list.push(message);
    bySession.set(message.session_id, list);
  }
  for (const list of bySession.values()) list.sort((a, b) => (num(a.timestamp) ?? 0) - (num(b.timestamp) ?? 0) || a.id - b.id);

  const known = new Set(input.sessions.map((s) => s.id));
  // Parents before children, so a child can find the run it belongs to.
  const ordered = [...input.sessions].sort((a, b) => (num(a.started_at) ?? 0) - (num(b.started_at) ?? 0));
  /** Per session: its root session id, its runs in time order, and the step children hang under. */
  const placement = new Map<string, { rootSession: string; runs: { id: string; at: number }[]; parentStep?: string; fixedRun?: string }>();

  for (const session of ordered) {
    const parentId = str(session.parent_session_id);
    const parent = parentId && known.has(parentId) ? placement.get(parentId) : undefined;
    const messages = bySession.get(session.id) ?? [];

    if (!parent) {
      sessions.push({
        harness: HARNESS,
        externalId: session.id,
        title: str(session.title),
        cwd: str(session.cwd),
        gitBranch: str(session.git_branch),
        startedAt: fromEpochSeconds(session.started_at),
        lastEventAt: fromEpochSeconds(session.ended_at) ?? fromEpochSeconds(messages[messages.length - 1]?.timestamp),
        metadata: definedOnly({
          imported: true,
          source: str(session.source),
          model: str(session.model),
          endReason: str(session.end_reason),
          billingProvider: str(session.billing_provider),
          estimatedCostUsd: num(session.estimated_cost_usd),
          actualCostUsd: num(session.actual_cost_usd),
          inputTokens: num(session.input_tokens),
          outputTokens: num(session.output_tokens),
          cacheReadTokens: num(session.cache_read_tokens),
        }),
      });
      placement.set(session.id, { rootSession: session.id, runs: [] });
    } else {
      // The parent run active when this sub-agent started.
      const startedAt = num(session.started_at) ?? 0;
      const candidates = parent.fixedRun ? [{ id: parent.fixedRun, at: 0 }] : parent.runs;
      const run = [...candidates].reverse().find((r) => r.at <= startedAt) ?? candidates[0];
      if (!run) continue;
      const stepId = `subagent:${session.id}`;
      const goal = messages.find((m) => m.role === "user");
      const answer = [...messages].reverse().find((m) => m.role === "assistant" && str(m.content));
      steps.push({
        externalId: stepId,
        runExternalId: run.id,
        parentExternalId: parent.parentStep,
        kind: "agent",
        name: firstLine(str(session.title) ?? str(goal?.content), 80) ?? "Sub-agent",
        status: "ok",
        startedAt: fromEpochSeconds(session.started_at),
        endedAt: fromEpochSeconds(session.ended_at) ?? fromEpochSeconds(answer?.timestamp),
        input: str(goal?.content),
        output: str(answer?.content),
        attrs: { agentId: session.id, extra: definedOnly({ model: str(session.model), endReason: str(session.end_reason) }) },
      });
      placement.set(session.id, { rootSession: parent.rootSession, runs: [], parentStep: stepId, fixedRun: run.id });
    }

    const place = placement.get(session.id)!;
    let currentRun = place.fixedRun;
    let previousAt: number | undefined = num(session.started_at);
    const pending = new Map<string, { name: string; input: unknown; at?: number }>();

    for (const message of messages) {
      const at = num(message.timestamp);
      if (message.role === "user") {
        if (place.fixedRun) {
          previousAt = at;
          continue; // a sub-agent's task prompt, already on its step
        }
        const text = str(message.content) ?? "";
        currentRun = `${session.id}:m${message.id}`;
        place.runs.push({ id: currentRun, at: at ?? 0 });
        runs.set(currentRun, {
          harness: HARNESS,
          externalId: currentRun,
          sessionExternalId: session.id,
          source: "import",
          input: text,
          name: firstLine(text, 90) ?? "Message",
          startedAt: fromEpochSeconds(at),
          endedAt: fromEpochSeconds(at),
          status: "ok",
          model: str(session.model),
          systemPromptHash: str(session.system_prompt_hash),
          metadata: definedOnly({ imported: true, systemTurn: str(message.display_kind) ? true : undefined, kind: str(message.display_kind) }),
        });
        previousAt = at;
        continue;
      }
      if (!currentRun) continue;
      const run = runs.get(currentRun);

      if (message.role === "assistant") {
        const calls = toolCalls(message.tool_calls);
        const text = str(message.content);
        for (const call of calls) if (call.id) pending.set(call.id, { name: call.name, input: call.input, at });
        steps.push({
          externalId: `m${message.id}`,
          runExternalId: currentRun,
          parentExternalId: place.parentStep,
          kind: "llm",
          name: str(session.model) ?? "LLM call",
          status: "ok",
          startedAt: fromEpochSeconds(previousAt),
          endedAt: fromEpochSeconds(at),
          model: str(session.model),
          output: { text, toolCalls: calls.length ? calls : undefined },
          attrs: {
            reasoning: str(message.reasoning) ?? str(message.reasoning_content),
            stopReason: str(message.finish_reason),
          },
        });
        if (run && !place.parentStep) {
          if (text && calls.length === 0) run.output = text;
          run.endedAt = fromEpochSeconds(at) ?? run.endedAt;
        }
      } else if (message.role === "tool") {
        const callId = str(message.tool_call_id);
        const call = callId ? pending.get(callId) : undefined;
        const name = str(message.tool_name) ?? call?.name ?? "Tool";
        const failed = toolResultFailed(message.content);
        steps.push({
          externalId: callId ?? `m${message.id}`,
          runExternalId: currentRun,
          parentExternalId: place.parentStep,
          kind: name === "delegate_task" ? "agent" : "tool",
          name,
          toolName: name,
          toolCallId: callId,
          status: failed ? "error" : "ok",
          startedAt: fromEpochSeconds(call?.at ?? previousAt),
          endedAt: fromEpochSeconds(at),
          input: call?.input,
          output: parseJson(message.content),
          error: failed ? errorText(message.content) : undefined,
        });
        if (run && !place.parentStep) run.endedAt = fromEpochSeconds(at) ?? run.endedAt;
      }
      previousAt = at ?? previousAt;
    }
  }

  return { sessions, runs: [...runs.values()], steps };
}
