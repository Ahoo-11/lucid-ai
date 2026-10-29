import { readFileSync } from "node:fs";

export type Query = (text: string) => Promise<{ rows: Record<string, unknown>[] }>;

const JOURNAL = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as { entries: { tag: string; when: number }[] };

export const migrationCount = JOURNAL.entries.length;

/** Tags of this commit's migrations the database does not have yet. Read-only. */
export async function missingMigrations(query: Query) {
  // Drizzle records each applied migration with the journal entry's `when` as created_at.
  const { rows } = await query("select to_regclass('drizzle.__drizzle_migrations') is not null as present");
  if (!rows[0]?.present) return JOURNAL.entries.map((e) => e.tag);
  const applied = new Set((await query("select created_at from drizzle.__drizzle_migrations")).rows.map((row) => Number(row.created_at)));
  return JOURNAL.entries.filter((e) => !applied.has(e.when)).map((e) => e.tag);
}
