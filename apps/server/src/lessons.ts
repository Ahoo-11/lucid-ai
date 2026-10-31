// Lessons: instructions the owner approved for one kind of agent, usually the
// one Muse Spark proposed with a diagnosis ("When running as a cron job, never
// use execute_code"). The agent's Lucid plugin fetches the active ones and adds
// them to every turn, so a fix takes effect without editing anything on the
// agent's machine, and turning it off takes it back out.
//
// Only text instructions, never settings or permissions, and only what the
// owner approved word for word: diagnoses are written from error text the
// agent saw, which someone else may have written.

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { type Db, schema } from "./db";
import { LESSON_MAX } from "./explain";

const { lessons, runs } = schema;

/** Agents whose Lucid plugin applies lessons today. Others get a lesson to copy by hand. */
export const LESSON_HARNESSES = new Set(["hermes"]);
/** A turn carries at most this many lessons, newest first, so prompts stay small. */
const MAX_ACTIVE = 10;

export type Lesson = {
  id: string;
  text: string;
  harness: string;
  status: "active" | "off";
  createdAt: string;
  /** When the agent first picked it up; null while waiting (an older plugin, or the agent isn't running). */
  deliveredAt: string | null;
};

/** One or two plain sentences: control characters out, length capped. */
export function cleanLesson(text: unknown) {
  if (typeof text !== "string") return null;
  const value = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, LESSON_MAX) : null;
}

const shape = (row: typeof lessons.$inferSelect): Lesson => ({
  id: row.id,
  text: row.text,
  harness: row.harness,
  status: row.status === "active" ? "active" : "off",
  createdAt: row.createdAt.toISOString(),
  deliveredAt: row.deliveredAt?.toISOString() ?? null,
});

/** Starts a lesson for a problem, replacing (turning off) the problem's previous one. */
export async function applyLesson(db: Db, projectId: string, input: { issueId: string; harness: string; text: string }) {
  const now = new Date();
  await db
    .update(lessons)
    .set({ status: "off", turnedOffAt: now })
    .where(and(eq(lessons.projectId, projectId), eq(lessons.issueId, input.issueId), eq(lessons.status, "active")));
  const [row] = await db
    .insert(lessons)
    .values({ id: randomUUID(), projectId, harness: input.harness, issueId: input.issueId, text: input.text })
    .returning();
  return shape(row!);
}

export async function setLessonStatus(db: Db, projectId: string, id: string, status: "active" | "off") {
  const [row] = await db
    .update(lessons)
    // Back on means picked up again from the next fetch, so its results count from then.
    .set(status === "off" ? { status, turnedOffAt: new Date() } : { status, turnedOffAt: null, deliveredAt: null })
    .where(and(eq(lessons.projectId, projectId), eq(lessons.id, id)))
    .returning();
  return row ? shape(row) : null;
}

/** What an agent's plugin adds to its turns. Marks them delivered: from now on they're in effect. */
export async function deliverLessons(db: Db, projectId: string, harness: string) {
  const rows = await db
    .select({ id: lessons.id, text: lessons.text, deliveredAt: lessons.deliveredAt })
    .from(lessons)
    .where(and(eq(lessons.projectId, projectId), eq(lessons.harness, harness), eq(lessons.status, "active")))
    .orderBy(desc(lessons.createdAt))
    .limit(MAX_ACTIVE);
  const fresh = rows.filter((row) => !row.deliveredAt).map((row) => row.id);
  if (fresh.length) {
    await db
      .update(lessons)
      .set({ deliveredAt: new Date() })
      .where(and(inArray(lessons.id, fresh), isNull(lessons.deliveredAt)));
  }
  return rows.map(({ id, text }) => ({ id, text }));
}

/** The latest lesson for each of these problems, on or off. */
export async function lessonsForIssues(db: Db, projectId: string, issueIds: string[]) {
  if (!issueIds.length) return new Map<string, Lesson>();
  const rows = await db
    .select()
    .from(lessons)
    .where(and(eq(lessons.projectId, projectId), inArray(lessons.issueId, issueIds)))
    .orderBy(asc(lessons.createdAt));
  // Ascending, so the newest one for a problem ends up in the map.
  return new Map(rows.map((row) => [row.issueId!, shape(row)]));
}

/** How many runs that agent has had since a moment: the "in 31 runs since" of a fix. */
export async function runsSince(db: Db, projectId: string, harness: string, since: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.harness, harness), gt(runs.startedAt, since)));
  return row?.n ?? 0;
}
