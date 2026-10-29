// Writes normalized batches. Every source upserts on its natural ids (prompt
// id, request id, tool_use id, span id), so the transcript, hooks and OTel
// events of one Claude Code run land on the same rows. Merge rules:
//   - the first non-null input/name/model wins (what the user asked is stable)
//   - later output/status/usage win, but a run or step never goes back to "running"
//   - start times take the earliest value, end times the latest
//   - a cost the harness reported beats our estimate

import { createHash, randomUUID } from "node:crypto";
import type { NormalizedBatch, RunUpsert, SessionUpsert, StepUpsert } from "@lucid/schema";
import { type SQL, inArray, sql } from "drizzle-orm";
import { type Db, schema } from "./db";
import { priceStep } from "./pricing";

const { blobs, runs, sessions, steps } = schema;
const PREVIEW = 280;
const FALLBACK_NAMES = ["Tool", "LLM call"];

const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

function mergeByKey<T>(items: T[], key: (item: T) => string, merge: (a: T, b: T) => T) {
  const map = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const existing = map.get(k);
    map.set(k, existing ? merge(existing, item) : item);
  }
  return [...map.values()];
}

const mergeStep = (a: StepUpsert, b: StepUpsert): StepUpsert => ({
  ...a,
  ...defined(b),
  attrs: { ...a.attrs, ...b.attrs },
  seq: a.seq ?? b.seq,
});

const sessionKey = (harness: string, externalId: string) => `${harness}\u0000${externalId}`;

export function previewOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const clip = (text: string) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat || undefined;
  };
  if (typeof value === "string") return clip(value);
  if (Array.isArray(value) && value.every((item) => item && typeof item === "object" && "role" in item)) {
    const messages = value as { role: string; content?: unknown }[];
    const last = [...messages].reverse().find((m) => m.role === "user") ?? messages[messages.length - 1];
    return last ? clip(typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")) : undefined;
  }
  if (typeof value === "object" && ("text" in value || "toolCalls" in value)) {
    const output = value as { text?: string; toolCalls?: { name: string }[] };
    if (output.text) return clip(output.text);
    if (output.toolCalls?.length) return clip(`Calls ${output.toolCalls.map((call) => call.name).join(", ")}`);
  }
  return clip(JSON.stringify(value));
}

type BlobRow = { projectId: string; hash: string; content: string; bytes: number };

function toBlob(projectId: string, value: unknown, pending: Map<string, BlobRow>) {
  if (value === undefined || value === null) return {};
  const content = typeof value === "string" ? value : JSON.stringify(value);
  if (!content) return {};
  const hash = createHash("sha256").update(content).digest("hex");
  pending.set(hash, { projectId, hash, content, bytes: Buffer.byteLength(content) });
  return { hash, preview: previewOf(value) };
}

/** A status update that never moves a finished row back to "running". */
function statusSet(column: SQL | typeof runs.status | typeof steps.status, status: string | undefined) {
  if (!status) return undefined;
  if (status !== "running") return sql`${status}`;
  return sql`case when ${column} in ('ok', 'error') then ${column} else 'running' end`;
}

export async function writeBatch(db: Db, projectId: string, batch: NormalizedBatch, defaultHarness = "otel") {
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const pendingBlobs = new Map<string, BlobRow>();

    // Runs referenced only by steps (a sub-agent transcript, a late hook) still
    // need a row; an upsert with no fields leaves an existing run untouched.
    const runInputs: RunUpsert[] = [...batch.runs];
    const knownRuns = new Set(batch.runs.map((run) => run.externalId));
    for (const step of batch.steps) {
      if (!knownRuns.has(step.runExternalId)) {
        runInputs.push({ harness: defaultHarness, externalId: step.runExternalId, source: "import" });
        knownRuns.add(step.runExternalId);
      }
    }
    const runList = mergeByKey(runInputs, (run) => run.externalId, (a, b) => ({
      ...a,
      ...defined(b),
      input: a.input ?? b.input,
      name: a.name ?? b.name,
      metadata: { ...a.metadata, ...b.metadata },
    }));

    // Sessions, including ones only named by a run.
    const sessionInputs: SessionUpsert[] = [...batch.sessions];
    for (const run of runList) {
      if (run.sessionExternalId) sessionInputs.push({ harness: run.harness, externalId: run.sessionExternalId });
    }
    const sessionIds = new Map<string, string>();
    for (const session of mergeByKey(sessionInputs, (s) => sessionKey(s.harness, s.externalId), (a, b) => ({ ...a, ...defined(b) }))) {
      const [row] = await tx
        .insert(sessions)
        .values({
          id: randomUUID(),
          projectId,
          harness: session.harness,
          externalId: session.externalId,
          title: session.title,
          cwd: session.cwd,
          gitBranch: session.gitBranch,
          userRef: session.userRef,
          startedAt: session.startedAt,
          lastEventAt: session.lastEventAt ?? session.startedAt,
          metadata: session.metadata,
        })
        .onConflictDoUpdate({
          target: [sessions.projectId, sessions.harness, sessions.externalId],
          set: {
            title: sql`coalesce(excluded.title, ${sessions.title})`,
            cwd: sql`coalesce(${sessions.cwd}, excluded.cwd)`,
            gitBranch: sql`coalesce(excluded.git_branch, ${sessions.gitBranch})`,
            userRef: sql`coalesce(${sessions.userRef}, excluded.user_ref)`,
            startedAt: sql`least(${sessions.startedAt}, excluded.started_at)`,
            lastEventAt: sql`greatest(${sessions.lastEventAt}, excluded.last_event_at)`,
            metadata: sql`coalesce(${sessions.metadata}, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb)`,
          },
        })
        .returning({ id: sessions.id });
      sessionIds.set(sessionKey(session.harness, session.externalId), row!.id);
    }

    const runIds = new Map<string, string>();
    for (const run of runList) {
      const sessionId = run.sessionExternalId ? sessionIds.get(sessionKey(run.harness, run.sessionExternalId)) : undefined;
      const [row] = await tx
        .insert(runs)
        .values({
          id: randomUUID(),
          projectId,
          sessionId,
          harness: run.harness,
          externalId: run.externalId,
          source: run.source,
          name: run.name,
          input: run.input,
          output: run.output,
          status: run.status ?? "running",
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          model: run.model,
          systemPromptHash: run.systemPromptHash,
          metadata: run.metadata,
        })
        .onConflictDoUpdate({
          target: [runs.projectId, runs.externalId],
          set: defined({
            sessionId: sql`coalesce(${runs.sessionId}, excluded.session_id)`,
            name: sql`coalesce(${runs.name}, excluded.name)`,
            input: sql`coalesce(${runs.input}, excluded.input)`,
            output: sql`coalesce(excluded.output, ${runs.output})`,
            status: statusSet(runs.status, run.status),
            startedAt: sql`least(${runs.startedAt}, excluded.started_at)`,
            endedAt: sql`greatest(${runs.endedAt}, excluded.ended_at)`,
            model: sql`coalesce(${runs.model}, excluded.model)`,
            systemPromptHash: sql`coalesce(${runs.systemPromptHash}, excluded.system_prompt_hash)`,
            metadata: sql`coalesce(${runs.metadata}, '{}'::jsonb) || coalesce(excluded.metadata, '{}'::jsonb)`,
            updatedAt: sql`now()`,
          }),
        })
        .returning({ id: runs.id });
      runIds.set(run.externalId, row!.id);
    }

    for (const step of mergeByKey(batch.steps, (s) => `${s.runExternalId}\u0000${s.externalId}`, mergeStep)) {
      const runId = runIds.get(step.runExternalId)!;
      const input = toBlob(projectId, step.input, pendingBlobs);
      const output = toBlob(projectId, step.output, pendingBlobs);
      const reported = step.reportedCostUsd;
      const [row] = await tx
        .insert(steps)
        .values({
          id: randomUUID(),
          projectId,
          runId,
          externalId: step.externalId,
          parentExternalId: step.parentExternalId,
          kind: step.kind,
          name: step.name,
          status: step.status ?? "ok",
          seq: step.seq,
          startedAt: step.startedAt,
          endedAt: step.endedAt,
          durationMs: step.durationMs,
          model: step.model,
          provider: step.provider,
          inputTokens: step.usage?.inputTokens,
          outputTokens: step.usage?.outputTokens,
          cacheReadTokens: step.usage?.cacheReadTokens,
          cacheWriteTokens: step.usage?.cacheWriteTokens,
          reasoningTokens: step.usage?.reasoningTokens,
          costUsd: reported,
          costSource: reported !== undefined ? "reported" : undefined,
          toolName: step.toolName,
          toolCallId: step.toolCallId,
          inputHash: input.hash,
          inputPreview: input.preview,
          outputHash: output.hash,
          outputPreview: output.preview,
          error: step.error,
          attrs: step.attrs,
        })
        .onConflictDoUpdate({
          target: [steps.runId, steps.externalId],
          set: defined({
            parentExternalId: sql`coalesce(${steps.parentExternalId}, excluded.parent_external_id)`,
            name: sql`case when ${steps.name} in (${sql.join(FALLBACK_NAMES.map((n) => sql`${n}`), sql`, `)}) then excluded.name else ${steps.name} end`,
            status: statusSet(steps.status, step.status),
            seq: sql`coalesce(${steps.seq}, excluded.seq)`,
            startedAt: sql`least(${steps.startedAt}, excluded.started_at)`,
            endedAt: sql`greatest(${steps.endedAt}, excluded.ended_at)`,
            durationMs: sql`coalesce(excluded.duration_ms, ${steps.durationMs})`,
            model: sql`coalesce(excluded.model, ${steps.model})`,
            provider: sql`coalesce(excluded.provider, ${steps.provider})`,
            inputTokens: sql`coalesce(excluded.input_tokens, ${steps.inputTokens})`,
            outputTokens: sql`coalesce(excluded.output_tokens, ${steps.outputTokens})`,
            cacheReadTokens: sql`coalesce(excluded.cache_read_tokens, ${steps.cacheReadTokens})`,
            cacheWriteTokens: sql`coalesce(excluded.cache_write_tokens, ${steps.cacheWriteTokens})`,
            reasoningTokens: sql`coalesce(excluded.reasoning_tokens, ${steps.reasoningTokens})`,
            costUsd: reported !== undefined ? sql`excluded.cost_usd` : undefined,
            costSource: reported !== undefined ? sql`'reported'` : undefined,
            toolName: sql`coalesce(excluded.tool_name, ${steps.toolName})`,
            toolCallId: sql`coalesce(excluded.tool_call_id, ${steps.toolCallId})`,
            inputHash: sql`coalesce(excluded.input_hash, ${steps.inputHash})`,
            inputPreview: sql`coalesce(excluded.input_preview, ${steps.inputPreview})`,
            outputHash: sql`coalesce(excluded.output_hash, ${steps.outputHash})`,
            outputPreview: sql`coalesce(excluded.output_preview, ${steps.outputPreview})`,
            error: sql`coalesce(excluded.error, ${steps.error})`,
            attrs: sql`coalesce(${steps.attrs}, '{}'::jsonb) || coalesce(excluded.attrs, '{}'::jsonb)`,
          }),
        })
        .returning();

      if (row && row.kind === "llm" && row.costSource !== "reported") {
        const priced = priceStep(row);
        if (priced.costUsd !== row.costUsd || priced.costSource !== row.costSource) {
          await tx.update(steps).set(priced).where(sql`${steps.id} = ${row.id}`);
        }
      }
    }

    // Shared payloads under the source's own key (e.g. "tools:hermes:<hash>").
    for (const named of batch.blobs ?? []) {
      const content = typeof named.content === "string" ? named.content : JSON.stringify(named.content);
      pendingBlobs.set(named.key, { projectId, hash: named.key, content, bytes: Buffer.byteLength(content) });
    }
    const blobRows = [...pendingBlobs.values()];
    for (let i = 0; i < blobRows.length; i += 100) {
      await tx.insert(blobs).values(blobRows.slice(i, i + 100)).onConflictDoNothing();
    }

    const touched = [...runIds.values()];
    await rollupRuns(tx, touched);
    return { runIds: touched };
  });
}

/** Recomputes a run's totals from its steps. */
export async function rollupRuns(db: Db, runIds: string[]) {
  if (runIds.length === 0) return;
  // Sources that send start and end separately (transcripts) never state a duration.
  await db.execute(sql`
    update ${steps} set duration_ms = (extract(epoch from (ended_at - started_at)) * 1000)::int
    where ${inArray(steps.runId, runIds)} and duration_ms is null and started_at is not null and ended_at >= started_at
  `);
  await db.execute(sql`
    update ${runs} as r set
      step_count = s.step_count,
      llm_call_count = s.llm_calls,
      tool_call_count = s.tool_calls,
      error_count = s.errors,
      input_tokens = s.input_tokens,
      output_tokens = s.output_tokens,
      cache_read_tokens = s.cache_read_tokens,
      cache_write_tokens = s.cache_write_tokens,
      reasoning_tokens = s.reasoning_tokens,
      cost_usd = s.cost_usd,
      cost_incomplete = s.unpriced,
      started_at = least(r.started_at, s.min_start),
      ended_at = greatest(r.ended_at, s.max_end),
      duration_ms = (extract(epoch from (greatest(r.ended_at, s.max_end) - least(r.started_at, s.min_start))) * 1000)::int,
      updated_at = now()
    from (
      select run_id,
        count(*)::int as step_count,
        (count(*) filter (where kind = 'llm'))::int as llm_calls,
        (count(*) filter (where kind in ('tool', 'agent')))::int as tool_calls,
        (count(*) filter (where status = 'error'))::int as errors,
        coalesce(sum(input_tokens), 0)::int as input_tokens,
        coalesce(sum(output_tokens), 0)::int as output_tokens,
        coalesce(sum(cache_read_tokens), 0)::int as cache_read_tokens,
        coalesce(sum(cache_write_tokens), 0)::int as cache_write_tokens,
        coalesce(sum(reasoning_tokens), 0)::int as reasoning_tokens,
        sum(cost_usd) as cost_usd,
        (count(*) filter (where kind = 'llm' and cost_usd is null))::int as unpriced,
        min(started_at) as min_start,
        max(coalesce(ended_at, started_at)) as max_end
      from ${steps}
      where ${inArray(steps.runId, runIds)}
      group by run_id
    ) as s
    where r.id = s.run_id
  `);
}
