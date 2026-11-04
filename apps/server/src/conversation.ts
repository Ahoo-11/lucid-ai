// A run's chat as Lucid recorded it, for rebuilding what its model calls were
// sent when the requests themselves weren't captured (Hermes cuts big ones to
// a preview, and its history keeps none). Used by the run's context view and
// by fix tests (see rebuildMessages in contextBreakdown.ts).

import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { TurnStep } from "./contextBreakdown";
import { type Db, schema } from "./db";

const { blobs, runs, steps } = schema;

/** Earlier runs of a session read to rebuild a call's chat: agents compact long chats, so older turns weren't in the prompt anyway. */
export const REBUILD_TURNS = 20;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The last REBUILD_TURNS runs of the run's session before it, then the run
 * itself, each with its steps in order and their full inputs and outputs.
 */
export async function conversationOf(
  db: Db,
  projectId: string,
  run: { id: string; input: string | null; sessionId: string | null; startedAt: Date | null },
): Promise<{ input: string | null; steps: TurnStep[] }[]> {
  const earlier =
    run.sessionId && run.startedAt
      ? await db
          .select({ id: runs.id, input: runs.input })
          .from(runs)
          .where(and(eq(runs.projectId, projectId), eq(runs.sessionId, run.sessionId), lt(runs.startedAt, run.startedAt)))
          .orderBy(desc(runs.startedAt))
          .limit(REBUILD_TURNS)
      : [];
  const turns = [...earlier.reverse(), run];
  const rows = await db
    .select({
      runId: steps.runId,
      externalId: steps.externalId,
      parentExternalId: steps.parentExternalId,
      kind: steps.kind,
      toolName: steps.toolName,
      toolCallId: steps.toolCallId,
      inputHash: steps.inputHash,
      outputHash: steps.outputHash,
    })
    .from(steps)
    .where(inArray(steps.runId, turns.map((turn) => turn.id)))
    .orderBy(sql`${steps.startedAt} asc nulls last`, asc(steps.seq), asc(steps.createdAt));
  // Replies and tool results, and a sub-agent's task: stored whole, as text or JSON.
  const keys = [...new Set(rows.flatMap((row) => [row.outputHash, row.kind === "agent" ? row.inputHash : null]).filter((key): key is string => !!key))];
  const content = new Map<string, unknown>();
  for (let i = 0; i < keys.length; i += 200) {
    const found = await db
      .select({ hash: blobs.hash, content: blobs.content })
      .from(blobs)
      .where(and(eq(blobs.projectId, projectId), inArray(blobs.hash, keys.slice(i, i + 200))));
    for (const blob of found) content.set(blob.hash, parseJson(blob.content) ?? blob.content);
  }
  const of = (key: string | null) => (key ? content.get(key) : undefined);
  return turns.map((turn) => ({
    input: turn.input,
    steps: rows
      .filter((row) => row.runId === turn.id)
      .map((row) => ({ stepId: row.externalId, parentId: row.parentExternalId, kind: row.kind, toolName: row.toolName, toolCallId: row.toolCallId, input: of(row.inputHash), output: of(row.outputHash) })),
  }));
}
