// Claude Code integration: `connect` writes hooks (+ optional OpenTelemetry
// env) into ~/.claude/settings.json; `hook` is what those hooks run; `import`
// uploads existing session transcripts so the dashboard is useful at once.

import { appendFileSync, copyFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LUCID_HOME, postJson, readConfig, readJson, syncProgress, writeConfig, writeJson } from "./config";
import { sessionTranscripts, syncTranscript } from "./transcripts";

type Target = { endpoint: string; apiKey?: string };
type HookEntry = { type: string; command: string; async?: boolean; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookEntry[] };
type Settings = { env?: Record<string, string>; hooks?: Record<string, HookGroup[]>; [key: string]: unknown };

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SubagentStop", "Stop", "SessionEnd"];
const TOOL_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const SYNC_ALL_EVENTS = new Set(["SubagentStop", "Stop", "SessionEnd"]);
const MARKER = "--harness claude-code";

export const defaultSettingsPath = () => join(homedir(), ".claude", "settings.json");

/** The bundled CLI that hooks invoke (hooks must not depend on tsx or the repo's cwd). */
function cliEntry() {
  const self = fileURLToPath(import.meta.url);
  const bundled = self.endsWith(".mjs") ? self : join(dirname(self), "..", "dist", "lucid.mjs");
  if (!existsSync(bundled)) throw new Error("Build the CLI first: npm run build -w @lucid/cli");
  return bundled;
}

const isOurs = (hook: HookEntry) => hook.command.includes(MARKER) && hook.command.includes(" hook ");

function otelEnv(target: Target): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: target.endpoint,
    ...(target.apiKey ? { OTEL_EXPORTER_OTLP_HEADERS: `x-api-key=${target.apiKey}` } : {}),
    // Off by default in Claude Code; without them prompts and tool inputs are redacted.
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
  };
}

/** Pure: returns new settings with our hooks (and env) replaced, everything else kept. */
export function applyConnect(settings: Settings, command: string, env: Record<string, string> | null): Settings {
  const next: Settings = structuredClone(settings);
  const hooks = (next.hooks ??= {});
  for (const event of HOOK_EVENTS) {
    const groups = (hooks[event] ?? [])
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length > 0);
    groups.push({
      ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command, async: true, timeout: 30 }],
    });
    hooks[event] = groups;
  }
  if (env) next.env = { ...next.env, ...env };
  return next;
}

export function applyDisconnect(settings: Settings, envKeys: string[]): Settings {
  const next: Settings = structuredClone(settings);
  for (const [event, groups] of Object.entries(next.hooks ?? {})) {
    const kept = groups
      .map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) next.hooks![event] = kept;
    else delete next.hooks![event];
  }
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  if (next.env) {
    for (const key of envKeys) delete next.env[key];
    if (Object.keys(next.env).length === 0) delete next.env;
  }
  return next;
}

export function connectClaudeCode(target: Target, options: { settingsPath: string; otel: boolean; dryRun: boolean }) {
  const settings = readJson<Settings>(options.settingsPath, {});
  const command = `"${process.execPath}" "${cliEntry()}" hook ${MARKER}`;
  const env = options.otel ? otelEnv(target) : null;
  const next = applyConnect(settings, command, env);
  if (options.dryRun) return { settings: next, written: false };

  if (existsSync(options.settingsPath)) copyFileSync(options.settingsPath, `${options.settingsPath}.lucid-backup`);
  writeJson(options.settingsPath, next);
  writeConfig({ ...readConfig(), endpoint: target.endpoint, apiKey: target.apiKey, claudeCodeEnvKeys: env ? Object.keys(env) : [] });
  return { settings: next, written: true };
}

export function disconnectClaudeCode(settingsPath: string) {
  const next = applyDisconnect(readJson<Settings>(settingsPath, {}), readConfig().claudeCodeEnvKeys ?? []);
  writeJson(settingsPath, next);
}

function logHookError(error: unknown) {
  try {
    appendFileSync(join(LUCID_HOME, "hook.log"), `${new Date().toISOString()} ${(error as Error)?.stack ?? String(error)}\n`);
  } catch {
    // Never let logging break the hook.
  }
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  // Windows PowerShell puts a byte-order mark in front of text it pipes in.
  return Buffer.concat(chunks).toString("utf8").replace(/^﻿/, "");
}

/** Runs inside a Claude Code hook: must be quick, quiet, and never fail the session. */
export async function runClaudeHook(target: Target) {
  try {
    const payload = JSON.parse((await readStdin()) || "{}") as Record<string, unknown>;
    await postJson(target, "/v1/hooks/claude-code", payload, 5_000).catch(logHookError);
    const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : undefined;
    if (!transcriptPath) return;
    const event = String(payload.hook_event_name ?? "");
    const files = sessionTranscripts(transcriptPath);
    for (const file of SYNC_ALL_EVENTS.has(event) ? files : files.slice(0, 1)) {
      await syncTranscript(target, file).catch(logHookError);
    }
  } catch (error) {
    logHookError(error);
  }
}

export async function importClaudeCode(target: Target, options: { days: number; onProgress?: (message: string) => void }) {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return { sessions: 0, lines: 0, failed: 0 };
  const since = Date.now() - options.days * 24 * 60 * 60 * 1000;
  const found: { project: string; name: string; path: string; changed: number }[] = [];
  for (const project of readdirSync(root)) {
    const dir = join(root, project);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const changed = statSync(path).mtimeMs;
      if (changed >= since) found.push({ project, name, path, changed });
    }
  }
  // Newest first, so the sessions people remember show up first.
  found.sort((a, b) => b.changed - a.changed);
  const sync = syncProgress(target, "claude-code", found.length);
  await sync.start();
  let sessions = 0;
  let lines = 0;
  let failed = 0;
  for (const { project, name, path } of found) {
    // One unreadable session must not stop the rest of the import.
    try {
      for (const file of sessionTranscripts(path)) lines += (await syncTranscript(target, file)).sent;
      sessions++;
      options.onProgress?.(`  ${project} / ${name}`);
    } catch (error) {
      failed++;
      options.onProgress?.(`  ✗ ${project} / ${name}: ${(error as Error).message.slice(0, 200)}`);
    }
    await sync.advance();
  }
  await sync.finish();
  return { sessions, lines, failed };
}
