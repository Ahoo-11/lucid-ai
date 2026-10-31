// Progress of uploads of past runs. Senders (the Hermes plugin's backfill,
// `lucid import`) report "done X of Y" as they go and say when they finish, so
// the dashboard can show "Bringing in past runs… 12 of 40" instead of a list
// that looks complete but isn't.

import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { type Db, schema } from "./db";

const { historySyncs } = schema;

/** No word from a sender for this long: it stopped (Hermes closed, network gone). */
export const STALE_MS = 3 * 60_000;
/** A finished sync stays on screen this long, so people see it complete. */
const SHOW_DONE_MS = 2 * 60_000;

export type SyncReport = { id?: unknown; harness?: unknown; total?: unknown; done?: unknown; finished?: unknown };

const count = (value: unknown) => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10_000_000 ? (value as number) : null);

/** Records a sender's progress. Returns an error message for a malformed report. */
export async function reportSync(db: Db, projectId: string, report: SyncReport) {
  const id = typeof report.id === "string" && /^[\w-]{1,64}$/.test(report.id) ? report.id : null;
  const harness = typeof report.harness === "string" && /^[\w-]{1,32}$/.test(report.harness) ? report.harness : null;
  const total = count(report.total);
  const done = count(report.done ?? 0);
  if (!id || !harness || total === null || done === null) return { error: "Send id, harness, total and done" };
  const now = new Date();
  const finishedAt = report.finished === true ? now : null;
  await db
    .insert(historySyncs)
    .values({ projectId, id, harness, total, done: Math.min(done, total), updatedAt: now, finishedAt })
    .onConflictDoUpdate({
      target: [historySyncs.projectId, historySyncs.id],
      set: { total, done: Math.min(done, total), updatedAt: now, finishedAt },
    });
  // Old ones are only history; keep the table small.
  await db.delete(historySyncs).where(and(eq(historySyncs.projectId, projectId), lt(historySyncs.updatedAt, new Date(now.getTime() - 24 * 60 * 60_000))));
  return { ok: true as const };
}

/** What the dashboard shows: uploads still going, and ones that just finished. */
export async function currentSyncs(db: Db, projectId: string) {
  const now = Date.now();
  const rows = await db
    .select()
    .from(historySyncs)
    .where(
      and(
        eq(historySyncs.projectId, projectId),
        or(
          and(isNull(historySyncs.finishedAt), gt(historySyncs.updatedAt, new Date(now - STALE_MS))),
          and(isNotNull(historySyncs.finishedAt), gt(historySyncs.finishedAt, new Date(now - SHOW_DONE_MS))),
        ),
      ),
    )
    .orderBy(desc(historySyncs.startedAt), sql`${historySyncs.id}`);
  return rows.map((row) => ({
    id: row.id,
    harness: row.harness,
    total: row.total,
    done: row.done,
    finished: row.finishedAt !== null,
    startedAt: row.startedAt.toISOString(),
  }));
}
