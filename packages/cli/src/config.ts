import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LUCID_HOME = process.env.LUCID_HOME ?? join(homedir(), ".lucid");
const CONFIG_FILE = join(LUCID_HOME, "config.json");
export const DEFAULT_ENDPOINT = "http://127.0.0.1:4318";

export type CliConfig = {
  endpoint?: string;
  apiKey?: string;
  /** Env keys `connect` added to Claude Code's settings, so `disconnect` removes only those. */
  claudeCodeEnvKeys?: string[];
};

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export const readConfig = () => readJson<CliConfig>(CONFIG_FILE, {});
export const writeConfig = (config: CliConfig) => writeJson(CONFIG_FILE, config);

/**
 * Flags win, then env, then ~/.lucid/config.json, then a server running in
 * this folder (its first start writes .lucid/api-key).
 */
export function resolveTarget(flags: { endpoint?: string; key?: string }) {
  const config = readConfig();
  const endpoint = (flags.endpoint ?? process.env.LUCID_ENDPOINT ?? config.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const localKeyFile = join(process.cwd(), ".lucid", "api-key");
  const apiKey =
    flags.key ??
    process.env.LUCID_API_KEY ??
    config.apiKey ??
    (existsSync(localKeyFile) ? readFileSync(localKeyFile, "utf8").trim() : undefined);
  return { endpoint, apiKey };
}

export async function postJson(target: { endpoint: string; apiKey?: string }, path: string, body: unknown, timeoutMs = 15_000) {
  const response = await fetch(`${target.endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(target.apiKey ? { "x-api-key": target.apiKey } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
}
