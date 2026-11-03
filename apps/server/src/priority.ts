// How much each Inbox entry matters, so the owner fixes the right one first.
// The model reads the open recurring problems side by side (what went wrong,
// how often, how lately) and rates each high, medium or low with a reason;
// side by side, so "high" stays for the few that matter most. It rates again
// when a problem has no rating yet, and once a day so ones that stopped sink:
// at most every RATE_EVERY_MS and RATINGS_PER_DAY, only with auto-diagnose on.
// Until then, and for one-offs, a rule estimates it from how often it
// happened this week.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppContext } from "./context";
import { schema } from "./db";
import { prettyTool } from "./insights";

const { issuePriorities } = schema;

export type Level = "high" | "medium" | "low";

/** An entry's importance: rated by a model (its id in `by`), or estimated by the rule (`by` null). */
export type Importance = { level: Level; reason: string; by: string | null; at: string | null };

/** Model passes an account gets in any 24 hours, and the least time between two. */
export const RATINGS_PER_DAY = 12;
const RATE_EVERY_MS = 10 * 60_000;
/** Ratings older than this are redone: how lately something happened changes what matters. */
const STALE_MS = 24 * 3_600_000;
const RATE_MAX = 80;
const DAY = 24 * 3_600_000;

const LEVELS = new Set<Level>(["high", "medium", "low"]);

/** One entry as the model reads it. */
export type RateItem = {
  id: string;
  harness: string;
  title: string;
  /** What it means for the owner: the diagnosis's summary, or the rule's why. */
  summary: string;
  toolName: string | null;
  runs: number;
  /** Runs it happened in over the last 7 days. */
  week: number;
  lastSeen: Date | null;
  /** How many ways the same cause showed up. */
  problems: number;
  runId: string | null;
};

/** Without the model: often this week is high, a few times medium, else low. */
export function estimate({ week, lastSeen }: { week: number; lastSeen: Date | null }): Importance {
  const quietDays = lastSeen ? (Date.now() - lastSeen.getTime()) / DAY : Infinity;
  if (week >= 5) return { level: "high", reason: `Happened in ${week} runs this week.`, by: null, at: null };
  if (week >= 2) return { level: "medium", reason: `Happened in ${week} runs this week.`, by: null, at: null };
  return { level: "low", reason: quietDays > 14 ? "Not seen in over two weeks." : week ? "Happened once this week." : "Not seen this week.", by: null, at: null };
}

const RATE = `You help the owner of AI agents decide what to fix first. Lucid lists their agents' open problems below, one per line: what went wrong, what it means, how often and how lately. Rate how important each is to fix now.

- high: it stops the agent doing its job (runs fail or end with nothing done, wrong results go out) or wastes real money, and it is still happening. Keep high for the few that matter most.
- medium: it wastes runs or time, or the agent gets there in the end; or a serious one that hasn't happened for a while.
- low: harmless or expected (a safety rule doing its job, a person saying no), rare, or not seen for weeks.
- why: at most 12 plain words for the owner on what it costs them.

Rate every line. Reply with JSON only: {"ratings": [{"n": 1, "priority": "high", "why": "..."}]}`;

const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function json(text: string | undefined) {
  const match = text ? /\{[\s\S]*\}/.exec(text)?.[0] : undefined;
  if (!match) return null;
  try {
    return JSON.parse(match) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const lately = (at: Date | null) => {
  if (!at) return "unknown";
  const hours = (Date.now() - at.getTime()) / 3_600_000;
  return hours < 24 ? `${Math.max(1, Math.round(hours))} h ago` : `${Math.round(hours / 24)} days ago`;
};

export function createRater(ctx: AppContext) {
  const model = ctx.ai?.model ?? null;
  const enabled = !!ctx.chat && !!model;
  const running = new Set<string>();
  const started = new Map<string, number[]>();

  async function rate(projectId: string, items: RateItem[]) {
    const lines = items.map((item, i) => {
      const where = item.toolName ? ` | tool ${prettyTool(item.toolName)}` : "";
      const ways = item.problems > 1 ? ` | showed up ${item.problems} ways` : "";
      return `#${i + 1} [${item.harness}] ${item.title} | ${clip(item.summary, 220)} | ${item.runs} runs, ${item.week} in the last 7 days, last ${lately(item.lastSeen)}${where}${ways}`;
    });
    const result = await ctx.chat!({
      model: model!,
      json: true,
      reasoningEffort: "low",
      maxTokens: 8_000,
      temperature: 0,
      messages: [
        { role: "system", content: RATE },
        { role: "user", content: lines.join("\n") },
      ],
    });
    const ratings = json(result.text)?.ratings;
    const rows = new Map<string, typeof issuePriorities.$inferInsert>();
    for (const rating of Array.isArray(ratings) ? ratings : []) {
      const { n, priority, why } = (rating ?? {}) as { n?: unknown; priority?: unknown; why?: unknown };
      const item = typeof n === "number" ? items[n - 1] : undefined;
      if (!item || !LEVELS.has(priority as Level)) continue;
      rows.set(item.id, { projectId, issueId: item.id, priority: priority as Level, reason: clip(typeof why === "string" ? why : "", 140), model: model!, ratedAt: new Date() });
    }
    if (rows.size) {
      await ctx.db
        .insert(issuePriorities)
        .values([...rows.values()])
        .onConflictDoUpdate({
          target: [issuePriorities.projectId, issuePriorities.issueId],
          set: { priority: sql`excluded.priority`, reason: sql`excluded.reason`, model: sql`excluded.model`, ratedAt: sql`excluded.rated_at` },
        });
    }
    ctx.log.info(`[inbox] rated ${rows.size} of ${items.length} problems (${result.inputTokens ?? "?"} in, ${result.outputTokens ?? "?"} out)`);
  }

  return {
    enabled,

    /** The saved ratings of these entries. */
    async ratings(projectId: string, ids: string[]) {
      if (!ids.length) return new Map<string, Importance>();
      const rows = await ctx.db
        .select()
        .from(issuePriorities)
        .where(and(eq(issuePriorities.projectId, projectId), inArray(issuePriorities.issueId, ids)));
      return new Map(rows.map((row) => [row.issueId, { level: row.priority as Level, reason: row.reason, by: row.model, at: row.ratedAt.toISOString() } satisfies Importance]));
    },

    /** Whether a pass is rating this account's problems now. */
    busy: (projectId: string) => running.has(projectId),

    /**
     * Starts a pass in the background when an entry has no rating or the
     * ratings are a day old, within the spacing and the daily cap. True when one started.
     */
    maybe(projectId: string, items: RateItem[], ratings: Map<string, Importance>) {
      if (!enabled || running.has(projectId) || !items.length) return false;
      const stale = (item: RateItem) => {
        const at = ratings.get(item.id)?.at;
        return !at || Date.now() - Date.parse(at) > STALE_MS;
      };
      if (!items.some(stale)) return false;
      const now = Date.now();
      const times = (started.get(projectId) ?? []).filter((at) => now - at < DAY);
      if (times.length >= RATINGS_PER_DAY || now - (times.at(-1) ?? 0) < RATE_EVERY_MS) return false;
      started.set(projectId, [...times, now]);
      running.add(projectId);
      const picked = [...items].sort((a, b) => b.week - a.week || b.runs - a.runs).slice(0, RATE_MAX);
      void rate(projectId, picked)
        .catch((error) => ctx.log.warn(`[inbox] rating with ${model} failed: ${(error as Error).message.slice(0, 300)}`))
        .finally(() => {
          running.delete(projectId);
          // Open dashboards refetch, so the Inbox shows the ratings by itself.
          ctx.live.publish({ projectId, runIds: picked.flatMap((item) => (item.runId ? [item.runId] : [])).slice(0, 20) });
        });
      return true;
    },
  };
}
