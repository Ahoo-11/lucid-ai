import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { count } from "drizzle-orm";
import { createApp } from "./app";
import { clerkAuth } from "./clerk";
import { openDb, schema } from "./db";
import { openAICompatibleClient } from "./ee/arena/llm";
import { createApiKey, ensureDefaultProject } from "./keys";
import { LiveHub } from "./live";
import { startCatalogRefresh } from "./pricing";
import { userEnv } from "./secrets";
import { rollupRuns } from "./writer";

// 4318 is the standard OTLP/HTTP port, so exporters' default endpoint
// (http://localhost:4318) reaches this server with no path configuration.
const port = Number(process.env.PORT ?? 4318);
const host = process.env.HOST ?? "127.0.0.1";
// Defaults to <repo>/.lucid whatever folder npm runs this from, so the CLI
// (run from the repo root) finds the key the server writes there.
const dataDir = resolve(process.env.LUCID_DATA_DIR ?? fileURLToPath(new URL("../../../.lucid", import.meta.url)));
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
// On a public address Lucid is hosted: people sign in, each account gets its
// own project, and every sender needs a key. LUCID_AUTH=on forces it locally.
const localMode = loopback && process.env.LUCID_AUTH !== "on";
const signups = process.env.LUCID_SIGNUPS !== "closed";

mkdirSync(dataDir, { recursive: true });
const { db } = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATABASE_URL ? undefined : join(dataDir, "db") });
const projectId = await ensureDefaultProject(db);

// First local start: create an ingest key and leave it where the local CLI finds it.
const [{ keys } = { keys: 0 }] = await db.select({ keys: count() }).from(schema.apiKeys);
if (localMode && keys === 0) {
  const created = await createApiKey(db, projectId, "Local key");
  writeFileSync(join(dataDir, "api-key"), created.key);
  console.info(`Created an ingest key (saved to ${join(dataDir, "api-key")})`);
}

// Hosted sign-in: Clerk when both keys are set, else built-in email + password.
const clerkSecret = userEnv("CLERK_SECRET_KEY");
const clerkPublishable = userEnv("CLERK_PUBLISHABLE_KEY");
const clerk = !localMode && clerkSecret && clerkPublishable ? clerkAuth({ secretKey: clerkSecret, publishableKey: clerkPublishable }) : undefined;
if (!localMode && !clerk && (clerkSecret || clerkPublishable)) console.warn("Clerk: set both CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY; using email + password sign-in.");

const live = new LiveHub();
// Arena replays and the judge use your own key (OpenRouter by default: one key, every model).
const replayKey = process.env.LUCID_REPLAY_API_KEY || userEnv("OPENROUTER_API_KEY");
const chat = replayKey ? openAICompatibleClient({ apiKey: replayKey, baseUrl: process.env.LUCID_REPLAY_BASE_URL }) : undefined;
if (!chat) console.info("Arena: no OPENROUTER_API_KEY (or LUCID_REPLAY_API_KEY) set, so replays are off.");
const ctx = { db, live, localMode, signups, defaultProjectId: projectId, log: console, chat, clerk };
console.info(
  localMode
    ? "Mode: local (no sign-in, this machine only)"
    : `Mode: hosted (${clerk ? "Clerk" : "email + password"} sign-in, sign-ups ${signups ? "open" : "closed"})`,
);

if (process.env.LUCID_OFFLINE !== "1") {
  startCatalogRefresh(db, async (runIds) => {
    await rollupRuns(db, runIds);
    live.publish({ projectId, runIds });
  });
}

serve({ fetch: createApp(ctx).fetch, port, hostname: host }, (info) => {
  console.info(`Lucid is listening on http://${host}:${info.port}  (OTLP: http://${host}:${info.port}/v1/traces)`);
});
