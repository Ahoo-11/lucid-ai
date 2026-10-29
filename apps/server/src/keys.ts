import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { type Db, schema } from "./db";

const { apiKeys, projects } = schema;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

function randomToken(length: number) {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Creates a key and returns the plaintext once; only its hash is stored. */
export async function createApiKey(db: Db, projectId: string, name: string) {
  const key = `lucid_live_${randomToken(32)}`;
  const row = { id: randomUUID(), projectId, name, prefix: key.slice(0, 16), hash: hashKey(key) };
  await db.insert(apiKeys).values(row);
  return { ...row, key };
}

export async function verifyApiKey(db: Db, key: string | undefined) {
  if (!key) return null;
  const [row] = await db
    .select({ id: apiKeys.id, projectId: apiKeys.projectId })
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, hashKey(key)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  // Best effort; a lost update only makes "last used" slightly stale.
  void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
  return row;
}

/**
 * Pulls a key from the places exporters put one: OTLP exporters send
 * OTEL_EXPORTER_OTLP_HEADERS verbatim, so accept Authorization: Bearer,
 * x-api-key and x-lucid-key.
 */
export function keyFromHeaders(headers: Headers) {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers.get("x-api-key") ?? headers.get("x-lucid-key") ?? undefined;
}

export const DEFAULT_PROJECT_ID = "default";

/** Local mode has one project; make sure it exists. */
export async function ensureDefaultProject(db: Db) {
  await db.insert(projects).values({ id: DEFAULT_PROJECT_ID, name: "My agents" }).onConflictDoNothing();
  return DEFAULT_PROJECT_ID;
}
