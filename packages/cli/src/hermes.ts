// Hermes Agent integration: `connect` installs the Lucid observer plugin into
// Hermes' plugin folder and enables it; `import` reads past sessions from
// Hermes' state.db (read-only) and uploads them.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { postJson, readConfig, syncProgress, writeConfig } from "./config";

type Target = { endpoint: string; apiKey?: string };
type Row = Record<string, unknown>;

const PLUGIN_NAME = "lucid";

/** Same resolution as Hermes' get_hermes_home(): HERMES_HOME, then the platform default. */
export function hermesHome() {
  const fromEnv = process.env.HERMES_HOME?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(local, "hermes");
  }
  return join(homedir(), ".hermes");
}

/** The plugin ships next to the bundled CLI (dist/hermes-plugin) or lives in the repo. */
function pluginSource() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "hermes-plugin"), join(here, "..", "..", "hermes-plugin", PLUGIN_NAME)];
  const found = candidates.find((dir) => existsSync(join(dir, "plugin.yaml")));
  if (!found) throw new Error("The Lucid Hermes plugin files are missing; rebuild the CLI (npm run build -w @lucid/cli).");
  return found;
}

export type HermesRunner = (args: string[]) => { ok: boolean; output: string };

const runHermes: HermesRunner = (args) => {
  const result = spawnSync("hermes", args, { encoding: "utf8", timeout: 120_000, windowsHide: true });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() || String(result.error ?? "") };
};

export function connectHermes(target: Target, options: { home?: string; run?: HermesRunner } = {}) {
  const home = options.home ?? hermesHome();
  if (!existsSync(home)) throw new Error(`Hermes isn't set up at ${home}. Run hermes once, or set HERMES_HOME.`);
  const dest = join(home, "plugins", PLUGIN_NAME);
  rmSync(dest, { recursive: true, force: true });
  cpSync(pluginSource(), dest, { recursive: true, filter: (src) => !src.includes("__pycache__") });
  // The plugin reads endpoint and key from ~/.lucid/config.json.
  writeConfig({ ...readConfig(), endpoint: target.endpoint, apiKey: target.apiKey });
  const enabled = (options.run ?? runHermes)(["plugins", "enable", PLUGIN_NAME]);
  return { pluginDir: dest, enabled: enabled.ok, output: enabled.output };
}

export function disconnectHermes(options: { home?: string; run?: HermesRunner } = {}) {
  (options.run ?? runHermes)(["plugins", "disable", PLUGIN_NAME]);
  rmSync(join(options.home ?? hermesHome(), "plugins", PLUGIN_NAME), { recursive: true, force: true });
}

async function openReadOnly(path: string) {
  // node:sqlite is built in (Node 22.13+) but still prints an experimental warning.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path, { readOnly: true });
  } finally {
    process.emitWarning = emit;
  }
}

const SESSION_COLUMNS = [
  "id", "source", "model", "system_prompt_hash", "parent_session_id", "started_at", "ended_at", "end_reason", "title",
  "cwd", "git_branch", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "estimated_cost_usd",
  "actual_cost_usd", "billing_provider",
];
const MESSAGE_COLUMNS = [
  "id", "session_id", "role", "content", "tool_call_id", "tool_calls", "tool_name", "timestamp", "finish_reason",
  "reasoning", "reasoning_content", "display_kind",
];

export async function importHermes(target: Target, options: { days: number; home?: string; onProgress?: (line: string) => void }) {
  const dbPath = join(options.home ?? hermesHome(), "state.db");
  if (!existsSync(dbPath)) return { sessions: 0, runs: 0, skipped: 0, failed: 0 };
  const db = await openReadOnly(dbPath);
  try {
    const available = new Set((db.prepare("pragma table_info(sessions)").all() as Row[]).map((row) => String(row.name)));
    const availableMessages = new Set((db.prepare("pragma table_info(messages)").all() as Row[]).map((row) => String(row.name)));
    // Older Hermes versions lack some columns; select only what exists.
    const sessionCols = SESSION_COLUMNS.filter((c) => available.has(c));
    const messageCols = MESSAGE_COLUMNS.filter((c) => availableMessages.has(c));
    const since = Date.now() / 1000 - options.days * 86_400;
    const all = db.prepare(`select ${sessionCols.join(", ")} from sessions order by started_at`).all() as Row[];
    const byId = new Map(all.map((s) => [String(s.id), s]));
    const rootOf = (session: Row): Row => {
      const parent = session.parent_session_id ? byId.get(String(session.parent_session_id)) : undefined;
      return parent && parent !== session ? rootOf(parent) : session;
    };
    const groups = new Map<string, Row[]>();
    for (const session of all) {
      const root = rootOf(session);
      const lastActive = Number(root.ended_at ?? root.started_at ?? 0);
      if (lastActive < since) continue;
      const id = String(root.id);
      groups.set(id, [...(groups.get(id) ?? []), session]);
    }

    const messagesFor = db.prepare(`select ${messageCols.join(", ")} from messages where session_id = ? order by timestamp, id`);
    const sync = syncProgress(target, "hermes", groups.size);
    await sync.start();
    let imported = 0;
    let runs = 0;
    let skipped = 0;
    let failed = 0;
    // Newest first, so the conversations people remember show up first.
    for (const [rootId, sessions] of [...groups].reverse()) {
      const messages = sessions.flatMap((s) => messagesFor.all(String(s.id)) as Row[]);
      const title = String(byId.get(rootId)?.title ?? rootId);
      try {
        const result = await postJson(target, "/v1/imports/hermes", { sessions, messages }, 60_000);
        if (result.status >= 300) throw new Error(`HTTP ${result.status}: ${JSON.stringify(result.json).slice(0, 200)}`);
        if (Number(result.json.imported) > 0) {
          imported++;
          runs += Number(result.json.runs ?? 0);
          options.onProgress?.(`  ${title} (${messages.length} messages)`);
        } else {
          skipped++;
          options.onProgress?.(`  ${title}: already captured live, skipped`);
        }
      } catch (error) {
        failed++;
        options.onProgress?.(`  ✗ ${title}: ${(error as Error).message}`);
      }
      await sync.advance();
    }
    await sync.finish();
    return { sessions: imported, runs, skipped, failed };
  } finally {
    db.close();
  }
}

/** True when Hermes has the plugin folder in place (used by `lucid status`). */
export function hermesConnected(home = hermesHome()) {
  const dir = join(home, "plugins", PLUGIN_NAME);
  return existsSync(dir) && readdirSync(dir).includes("plugin.yaml");
}
