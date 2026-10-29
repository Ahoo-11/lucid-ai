#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveTarget } from "./config";
import { connectClaudeCode, defaultSettingsPath, disconnectClaudeCode, importClaudeCode, runClaudeHook } from "./claudeCode";
import { connectHermes, disconnectHermes, hermesConnected, importHermes } from "./hermes";

const HELP = `lucid — see why your agents do what they do

Usage
  lucid connect claude-code [--endpoint URL] [--key KEY] [--no-otel] [--settings PATH] [--dry-run]
      Adds hooks to Claude Code so every session shows up live.
  lucid connect hermes [--endpoint URL] [--key KEY]
      Installs and enables the Lucid plugin in Hermes Agent.
  lucid import claude-code|hermes [--days 7]
      Uploads your recent sessions.
  lucid disconnect claude-code|hermes [--settings PATH]
      Removes everything connect added.
  lucid status
      Checks that the server is reachable.

Endpoint and key default to LUCID_ENDPOINT / LUCID_API_KEY, then ~/.lucid/config.json,
then a local server on http://127.0.0.1:4318.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: "string" },
      key: { type: "string" },
      settings: { type: "string" },
      harness: { type: "string" },
      days: { type: "string" },
      "dry-run": { type: "boolean" },
      "no-otel": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, harness = values.harness] = positionals;
  const target = resolveTarget({ endpoint: values.endpoint, key: values.key });

  if (!command || values.help) return console.log(HELP);

  if (command === "hook") {
    if (harness !== "claude-code") return;
    return runClaudeHook(target);
  }

  if (harness && harness !== "claude-code" && harness !== "hermes" && command !== "status") {
    console.error(`${harness} is not supported by the CLI yet. Point its OpenTelemetry exporter at ${target.endpoint} instead.`);
    process.exitCode = 1;
    return;
  }

  if (harness === "hermes") {
    if (command === "connect") {
      const result = connectHermes(target);
      console.log(`Installed the Lucid plugin → ${result.pluginDir}`);
      if (result.enabled) {
        console.log(`Enabled it in Hermes. New turns are sent to ${target.endpoint}.`);
        console.log("  Restart the Hermes gateway or desktop app if one is running. Run `lucid import hermes` to load past sessions.");
      } else {
        console.log(`Could not enable it automatically:\n  ${result.output}\nRun: hermes plugins enable lucid`);
        process.exitCode = 1;
      }
      return;
    }
    if (command === "disconnect") {
      disconnectHermes();
      return console.log("Disabled and removed the Lucid plugin from Hermes.");
    }
    if (command === "import") {
      const days = Number(values.days ?? 7);
      console.log(`Importing Hermes sessions from the last ${days} days → ${target.endpoint}`);
      const result = await importHermes(target, { days, onProgress: (line) => console.log(line) });
      console.log(`Done: ${result.sessions} sessions (${result.runs} runs), ${result.skipped} already captured live${result.failed ? `, ${result.failed} failed` : ""}.`);
      if (result.failed) process.exitCode = 1;
      return;
    }
  }

  if (command === "connect") {
    const settingsPath = values.settings ?? defaultSettingsPath();
    const result = connectClaudeCode(target, { settingsPath, otel: !values["no-otel"], dryRun: !!values["dry-run"] });
    if (!result.written) return console.log(JSON.stringify(result.settings, null, 2));
    console.log(`Connected Claude Code → ${target.endpoint}`);
    console.log(`  Updated ${settingsPath} (backup: ${settingsPath}.lucid-backup)`);
    console.log("  New sessions appear live. Run `lucid import claude-code` to load recent ones.");
    return;
  }

  if (command === "disconnect") {
    disconnectClaudeCode(values.settings ?? defaultSettingsPath());
    return console.log("Disconnected Claude Code.");
  }

  if (command === "import") {
    const days = Number(values.days ?? 7);
    console.log(`Importing Claude Code sessions from the last ${days} days → ${target.endpoint}`);
    const result = await importClaudeCode(target, { days, onProgress: (line) => console.log(line) });
    console.log(`Done: ${result.sessions} sessions, ${result.lines} new lines${result.failed ? `, ${result.failed} failed (see above)` : ""}.`);
    if (result.failed) process.exitCode = 1;
    return;
  }

  if (command === "status") {
    try {
      const response = await fetch(`${target.endpoint}/healthz`, { signal: AbortSignal.timeout(3_000) });
      console.log(response.ok ? `Server OK at ${target.endpoint}` : `Server answered ${response.status} at ${target.endpoint}`);
    } catch {
      console.log(`No server at ${target.endpoint}. Start one with: npm run dev`);
      process.exitCode = 1;
    }
    console.log(target.apiKey ? `Key: ${target.apiKey.slice(0, 16)}…` : "Key: none (fine for a local server)");
    console.log(`Hermes plugin: ${hermesConnected() ? "installed" : "not installed"}`);
    return;
  }

  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}

await main();
