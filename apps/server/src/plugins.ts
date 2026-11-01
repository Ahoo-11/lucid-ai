// Lucid plugins installed in agents, with an app-style Update. Each plugin
// reports its version with every upload (in its User-Agent); when the owner
// presses Update, the next check-in (GET /v1/lessons) offers the new files,
// the plugin replaces its own two files, and says so (x-lucid-plugin-staged).
// The agent runs the new version after its next restart: the owner chooses
// when, since a restart cuts off whatever the agent is doing.
//
// The plugin only ever downloads its own files, from the Lucid it reports to,
// and only after the owner asked. It never runs commands.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { type Db, schema } from "./db";

const { agentPlugins, apiKeys } = schema;

const HERMES_PLUGIN_YAML = fileURLToPath(new URL("../../../packages/hermes-plugin/lucid/plugin.yaml", import.meta.url));
/** The files the Hermes plugin is made of, which an update replaces. */
export const HERMES_PLUGIN_FILES = ["__init__.py", "plugin.yaml"];
/** The first version that can update itself; older ones need one update by hand. */
export const SELF_UPDATE_SINCE = "0.5.0";

/** "lucid-hermes-plugin/0.4" → "0.4". */
export function pluginVersion(userAgent: string | undefined) {
  return /lucid-hermes-plugin\/(\d+(?:\.\d+){1,2})\b/.exec(userAgent ?? "")?.[1] ?? null;
}

/** Compares "0.4" and "0.4.0" as equal, "0.10" above "0.9". */
export function compareVersions(a: string, b: string) {
  const parts = (v: string) => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** The version this server hands out (from the plugin it serves). */
export function latestHermesPlugin() {
  return /^version:\s*"?([^"\s]+)/m.exec(readFileSync(HERMES_PLUGIN_YAML, "utf8"))?.[1] ?? "0.0.0";
}

export type PluginState = "current" | "outdated" | "manual" | "updating" | "restart";

export function pluginState(row: { version: string; updateRequestedAt: Date | null; stagedVersion: string | null }, latest: string): PluginState {
  if (compareVersions(row.version, latest) >= 0) return "current";
  if (row.stagedVersion) return "restart";
  if (compareVersions(row.version, SELF_UPDATE_SINCE) < 0) return "manual";
  return row.updateRequestedAt ? "updating" : "outdated";
}

/**
 * Records what a plugin reported. Called on every upload, so an unchanged
 * report is skipped for a minute rather than written each time.
 */
export function pluginTracker(db: Db) {
  const recent = new Map<string, { version: string; staged: string | null; at: number }>();
  return async function note(input: { projectId: string; keyId: string; harness: string; userAgent: string | undefined; staged?: string | undefined }) {
    const version = pluginVersion(input.userAgent);
    if (!version) return;
    const staged = input.staged && /^\d+(?:\.\d+){1,2}$/.test(input.staged) ? input.staged : null;
    const cacheKey = `${input.projectId}\u0000${input.keyId}\u0000${input.harness}`;
    const last = recent.get(cacheKey);
    if (last && last.version === version && last.staged === staged && Date.now() - last.at < 60_000) return;
    recent.set(cacheKey, { version, staged, at: Date.now() });
    if (recent.size > 10_000) recent.clear();

    const [row] = await db
      .select()
      .from(agentPlugins)
      .where(and(eq(agentPlugins.projectId, input.projectId), eq(agentPlugins.keyId, input.keyId), eq(agentPlugins.harness, input.harness)))
      .limit(1);
    if (!row) {
      await db.insert(agentPlugins).values({ id: randomUUID(), projectId: input.projectId, keyId: input.keyId, harness: input.harness, version }).onConflictDoNothing();
      return;
    }
    // Running the version it downloaded (or newer): the update is done.
    const done = row.stagedVersion ? compareVersions(version, row.stagedVersion) >= 0 : false;
    await db
      .update(agentPlugins)
      .set({
        version,
        lastSeenAt: new Date(),
        stagedVersion: done ? null : (staged ?? row.stagedVersion),
        updateRequestedAt: done ? null : row.updateRequestedAt,
      })
      .where(eq(agentPlugins.id, row.id));
  };
}

/** What to send a plugin checking in: the new version's files, if the owner pressed Update. */
export async function updateOffer(db: Db, input: { projectId: string; keyId: string; harness: string; userAgent: string | undefined }, latest = latestHermesPlugin()) {
  const version = pluginVersion(input.userAgent);
  if (!version || compareVersions(version, SELF_UPDATE_SINCE) < 0) return null;
  const [row] = await db
    .select()
    .from(agentPlugins)
    .where(and(eq(agentPlugins.projectId, input.projectId), eq(agentPlugins.keyId, input.keyId), eq(agentPlugins.harness, input.harness)))
    .limit(1);
  if (!row?.updateRequestedAt || compareVersions(version, latest) >= 0) return null;
  // Paths, not URLs: the plugin fetches them from the Lucid it's configured for, nowhere else.
  return { version: latest, files: Object.fromEntries(HERMES_PLUGIN_FILES.map((name) => [name, `/install/hermes/lucid/${name}`])) };
}

/** Every plugin in the project, with its machine (the key's name) and what to do about it. */
export async function listPlugins(db: Db, projectId: string, latest = latestHermesPlugin()) {
  const rows = await db
    .select({ plugin: agentPlugins, keyName: apiKeys.name })
    .from(agentPlugins)
    .leftJoin(apiKeys, eq(apiKeys.id, agentPlugins.keyId))
    .where(eq(agentPlugins.projectId, projectId))
    .orderBy(desc(agentPlugins.lastSeenAt));
  return rows.map(({ plugin, keyName }) => ({
    id: plugin.id,
    harness: plugin.harness,
    // Keys made by the installer are named "Ahoo-PC (Claude Code, Hermes Agent)".
    machine: keyName?.replace(/\s*\([^)]*\)\s*$/, "") || (plugin.keyId === "local" ? "This computer" : "A computer"),
    version: plugin.version,
    latest,
    stagedVersion: plugin.stagedVersion,
    state: pluginState(plugin, latest),
    lastSeenAt: plugin.lastSeenAt.toISOString(),
  }));
}

export async function requestUpdate(db: Db, projectId: string, id: string) {
  const [row] = await db
    .update(agentPlugins)
    .set({ updateRequestedAt: new Date() })
    .where(and(eq(agentPlugins.projectId, projectId), eq(agentPlugins.id, id)))
    .returning();
  return row ?? null;
}
