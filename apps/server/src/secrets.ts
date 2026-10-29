import { spawnSync } from "node:child_process";

/**
 * Reads a key the way a freshly opened terminal would see it.
 *
 * On Windows, programs keep the environment they started with: change
 * OPENROUTER_API_KEY in your user settings and every app already running
 * (and whatever it launches) still holds the old value. So on Windows the
 * user-level value from the registry wins over the inherited one.
 */
export function userEnv(name: string): string | undefined {
  if (process.platform === "win32") {
    const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf8", windowsHide: true, timeout: 5_000 });
    const match = result.status === 0 ? new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, "m").exec(result.stdout) : null;
    if (match?.[1]) return match[1];
  }
  return process.env[name] || undefined;
}
