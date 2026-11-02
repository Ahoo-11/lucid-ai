// Shared by every way data comes in (OTLP, hooks, transcripts, the proxy):
// keep the raw payload first, then normalize and write it.

import { type RedactionPolicy, Redactor } from "@lucid/redact";
import type { NormalizedBatch } from "@lucid/schema";
import { eq } from "drizzle-orm";
import type { AppContext } from "./context";
import { schema } from "./db";
import { verifyApiKey } from "./keys";
import { writeBatch } from "./writer";

const { projects, rawEvents } = schema;

/**
 * What every project scrubs unless it chose otherwise: secrets only (keys,
 * tokens, passwords, private keys), so an agent that prints a .env never puts
 * it in Lucid, a diagnosis or an Arena replay. Personal data (emails, phones,
 * IPs, cards) stays readable for debugging; a project's own policy can add
 * it, and `{ categories: [] }` turns redaction off.
 */
export const DEFAULT_REDACTION: RedactionPolicy = { categories: ["private_key", "jwt", "api_key", "secret_assignment"] };

/**
 * Postgres text and jsonb cannot hold NUL characters, and real transcripts
 * contain them (binary tool output). Replace them before anything is stored.
 */
export function stripNul(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\u0000") ? value.replaceAll("\u0000", "�") : value;
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[stripNul(key) as string] = stripNul(item);
    return out;
  }
  return value;
}

/** One line per failure: driver errors carry the full query parameters, which can be megabytes. */
export function describeError(error: unknown) {
  const err = error as { message?: string; cause?: { message?: string; detail?: string } };
  const message = (err?.message ?? String(error)).split("\n")[0]!.slice(0, 300);
  const cause = err?.cause ? ` (${[err.cause.message, err.cause.detail].filter(Boolean).join(": ").slice(0, 300)})` : "";
  return `${message}${cause}`;
}

/** The project a Lucid key belongs to; in local mode no key means the default project. */
export async function projectForKey(ctx: AppContext, key: string | undefined) {
  if (!key && ctx.localMode) return ctx.defaultProjectId;
  const row = await verifyApiKey(ctx.db, key);
  return row?.projectId ?? null;
}

export type Ingest = ReturnType<typeof createIngest>;

export function createIngest(ctx: AppContext) {
  const policyCache = new Map<string, { policy: RedactionPolicy; at: number }>();

  const redactionPolicy = async (projectId: string) => {
    const cached = policyCache.get(projectId);
    if (cached && Date.now() - cached.at < 30_000) return cached.policy;
    const [row] = await ctx.db.select({ redaction: projects.redaction }).from(projects).where(eq(projects.id, projectId));
    const policy = (row?.redaction as RedactionPolicy | null | undefined) ?? DEFAULT_REDACTION;
    policyCache.set(projectId, { policy, at: Date.now() });
    return policy;
  };

  // Before anything is stored: the raw copy, the runs made from it, and all that reads them.
  const store = async (projectId: string, source: string, harness: string | null, payload: unknown) => {
    const clean = stripNul(new Redactor(await redactionPolicy(projectId)).value(payload));
    const [row] = await ctx.db.insert(rawEvents).values({ projectId, source, harness, payload: clean as object }).returning({ id: rawEvents.id });
    return { rawId: row!.id, payload: clean };
  };

  const commit = async (projectId: string, rawId: number, batch: () => NormalizedBatch, harness: string) => {
    try {
      const { runIds } = await writeBatch(ctx.db, projectId, batch(), harness);
      await ctx.db.update(rawEvents).set({ processedAt: new Date() }).where(eq(rawEvents.id, rawId));
      ctx.live.publish({ projectId, runIds });
      return runIds;
    } catch (error) {
      // Keep the raw payload and tell the sender it was accepted: exporters
      // retry on errors, and a retry would fail the same way.
      ctx.log.error(`[ingest] raw event ${rawId} failed to normalize: ${describeError(error)}`);
      await ctx.db.update(rawEvents).set({ error: describeError(error) }).where(eq(rawEvents.id, rawId));
      return [];
    }
  };

  return { store, commit };
}
