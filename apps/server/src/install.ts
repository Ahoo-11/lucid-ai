// One-line installers served by Lucid itself, so an agent on any machine (a
// VPS, a container) can be connected without cloning this repo and without a
// published package. Public: the plugin is open source, and the only value
// baked in is this server's public address.
//
//   curl -fsSL https://<lucid>/install/hermes.sh | LUCID_API_KEY=<key> sh

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";
import { DEFAULT_UPSTREAMS, upstreams } from "./proxy";

const HERMES_PLUGIN = fileURLToPath(new URL("../../../packages/hermes-plugin/lucid/", import.meta.url));
const HERMES_FILES = new Set(["__init__.py", "plugin.yaml"]);
/** The CLI as one file (npm run build -w @lucid/cli): what Claude Code's hooks run. */
const CLI_BUNDLE = fileURLToPath(new URL("../../../packages/cli/dist/lucid.mjs", import.meta.url));
const INSTALLERS = fileURLToPath(new URL("./installers/", import.meta.url));

/** Where the key goes in a setup's settings; the installer swaps in the one it receives on Approve. */
export const KEY_SLOT = "__LUCID_KEY__";

/**
 * What the one command sets up, from its link (?for=…):
 *   agents   Claude Code and Hermes on this computer (the default)
 *   project  a project's own agent through the proxy (&ai=<provider>): its .env
 *   tracing  a project's own agent that sends OpenTelemetry: its .env
 *   openclaw OpenClaw through the proxy (&ai=<provider>): a settings file OpenClaw merges in
 */
export type ConnectSetup = { for: "agents" } | { for: "project" | "tracing"; env: string[] } | { for: "openclaw"; config: string };

/** The base URL a provider's SDK expects: the upstream plus the path its SDK adds (none where the upstream has it). */
export function proxyBase(endpoint: string, provider: string) {
  const path = provider in DEFAULT_UPSTREAMS && provider !== "anthropic" && provider !== "gemini" ? "/v1" : "";
  return `${endpoint}/p/${KEY_SLOT}/${provider}${path}`;
}

/** The setting a project's agent reads: the OpenAI and Anthropic SDKs read theirs by themselves; other clients are pointed at LUCID_BASE_URL. */
export const baseVariable = (provider: string) => (provider === "openai" ? "OPENAI_BASE_URL" : provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "LUCID_BASE_URL");

/** OpenClaw's names for the providers, where they differ from Lucid's. */
const OPENCLAW_NAMES: Record<string, string> = { gemini: "google" };

/** Overrides OpenClaw's built-in provider address (~/.openclaw/openclaw.json, JSON5); its key and models stay. */
export function openclawConfig(provider: string, base: string) {
  // Lucid records chat completions, not OpenAI's Responses API, so the calls must use the former.
  const api = provider === "anthropic" ? "anthropic-messages" : "openai-completions";
  const extra = provider === "baseten" ? `\n        apiKey: "\${BASETEN_API_KEY}",\n        models: [{ id: "meta-models/muse-spark-open-1026", name: "Muse Spark" }],` : "";
  return `{
  models: {
    mode: "merge",
    providers: {
      ${OPENCLAW_NAMES[provider] ?? provider}: {
        baseUrl: "${base}",
        api: "${api}",
        headers: { "x-lucid-agent": "OpenClaw" },${extra}
      },
    },
  },
}`;
}

/** The setup a link asks for, or an error to show. Providers are the proxy's (proxy.ts upstreams). */
export function connectSetup(query: { for?: string; ai?: string }, endpoint: string, providers: string[]): ConnectSetup | { error: string } {
  const mode = query.for ?? "agents";
  if (mode === "agents") return { for: "agents" };
  if (mode === "tracing") {
    return {
      for: "tracing",
      env: [
        `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
        "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
        `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${KEY_SLOT}`,
        "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
        "OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental",
      ],
    };
  }
  if (mode !== "project" && mode !== "openclaw") return { error: `unknown setup ${mode}` };
  const ai = query.ai ?? "";
  // Pasted into the script: only a known provider's plain name.
  if (!/^[a-z0-9-]{1,40}$/.test(ai) || !providers.includes(ai)) return { error: `unknown AI provider ${ai}` };
  const base = proxyBase(endpoint, ai);
  return mode === "project" ? { for: "project", env: [`${baseVariable(ai)}=${base}`] } : { for: "openclaw", config: openclawConfig(ai, base) };
}

/**
 * The one-command installers (connect.sh, connect.ps1) with this server's
 * address and the setup filled in. They ask the person to approve the
 * computer in the browser (see links.ts), then set it up: by default the
 * Claude Code and Hermes they find, else what the link asked for.
 */
export function connectScript(file: "connect.sh" | "connect.ps1", endpoint: string, setup: ConnectSetup = { for: "agents" }) {
  // A Windows checkout may have turned the line endings into CRLF, which sh can't run.
  // Replaced by functions: settings text with a "$" in it goes in as written.
  return readFileSync(`${INSTALLERS}${file}`, "utf8")
    .replace(/\r\n/g, "\n")
    .replaceAll("__LUCID_ENDPOINT__", () => endpoint)
    .replaceAll("__LUCID_FOR__", () => setup.for)
    .replaceAll("__LUCID_ENV__", () => ("env" in setup ? setup.env.join("\n") : ""))
    .replaceAll("__LUCID_OPENCLAW__", () => ("config" in setup ? setup.config : ""));
}

/**
 * The address agents should send to: LUCID_PUBLIC_URL when set, else what the
 * browser used. Behind a TLS-terminating proxy (Traefik, Caddy, nginx) the
 * request arrives as plain http, so the proxy's forwarded headers win.
 */
export function publicEndpoint(c: Context) {
  if (process.env.LUCID_PUBLIC_URL) return process.env.LUCID_PUBLIC_URL.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const first = (name: string) => c.req.header(name)?.split(",")[0]?.trim();
  const proto = first("x-forwarded-proto");
  const scheme = proto === "https" || proto === "http" ? proto : url.protocol.slice(0, -1);
  return `${scheme}://${first("x-forwarded-host") || url.host}`;
}

// The endpoint is pasted into a shell script, so only plain URLs pass.
export const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;

export function hermesInstallScript(endpoint: string, version: string) {
  return `#!/bin/sh
# Lucid plugin ${version} for Hermes Agent. Re-run to update.
#   curl -fsSL ${endpoint}/install/hermes.sh | LUCID_API_KEY=<key> sh
# Optional: LUCID_BACKFILL_DAYS=30 also uploads the last 30 days of history once.
set -eu
LUCID_ENDPOINT="\${LUCID_ENDPOINT:-${endpoint}}"
HERMES_DIR="\${HERMES_HOME:-$HOME/.hermes}"
DEST="$HERMES_DIR/plugins/lucid"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "$1" "$2"
  fi
}

mkdir -p "$DEST"
for f in __init__.py plugin.yaml; do
  fetch "$LUCID_ENDPOINT/install/hermes/lucid/$f" "$DEST/$f.part"
  mv "$DEST/$f.part" "$DEST/$f"
done

# Settings go in Hermes' own .env, which it loads before plugins. Rewritten in
# place (not replaced) so a bind-mounted .env keeps working.
ENV_FILE="$HERMES_DIR/.env"
touch "$ENV_FILE"
set_env() {
  grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.lucid" || true
  printf '%s=%s\\n' "$1" "$2" >> "$ENV_FILE.lucid"
  cat "$ENV_FILE.lucid" > "$ENV_FILE"
  rm -f "$ENV_FILE.lucid"
}
set_env LUCID_ENDPOINT "$LUCID_ENDPOINT"
if [ -n "\${LUCID_API_KEY:-}" ]; then set_env LUCID_API_KEY "$LUCID_API_KEY"; fi
if [ -n "\${LUCID_BACKFILL_DAYS:-}" ]; then set_env LUCID_BACKFILL_DAYS "$LUCID_BACKFILL_DAYS"; fi

echo "Installed the Lucid plugin ${version} in $DEST"
# </dev/null: under "curl | sh" the rest of this script is on stdin, and hermes would read it.
if command -v hermes >/dev/null 2>&1 && hermes plugins enable lucid </dev/null >/dev/null 2>&1; then
  echo "Enabled it in Hermes."
else
  echo "Now run: hermes plugins enable lucid"
fi
echo "Restart Hermes (gateway, desktop app or container) so it loads. New turns go to $LUCID_ENDPOINT."
`;
}

export function installRoutes() {
  const app = new Hono();

  app.get("/install/hermes.sh", (c) => {
    const endpoint = publicEndpoint(c);
    if (!SAFE_URL.test(endpoint)) return c.text(`echo "Lucid: set LUCID_PUBLIC_URL on the server to a plain https URL" >&2; exit 1\n`, 500);
    const version = /^version:\s*"?([^"\s]+)/m.exec(readFileSync(`${HERMES_PLUGIN}plugin.yaml`, "utf8"))?.[1] ?? "";
    return c.text(hermesInstallScript(endpoint, version), 200, { "content-type": "text/x-shellscript; charset=utf-8" });
  });

  app.get("/install/hermes/lucid/:file", (c) => {
    const file = c.req.param("file");
    if (!HERMES_FILES.has(file)) return c.text("Not found", 404);
    return c.text(readFileSync(`${HERMES_PLUGIN}${file}`, "utf8"), 200, { "content-type": "text/plain; charset=utf-8" });
  });

  for (const file of ["connect.sh", "connect.ps1"] as const) {
    app.get(`/${file}`, (c) => {
      const endpoint = publicEndpoint(c);
      const failed = (message: string, status: 400 | 500) =>
        c.text(file === "connect.sh" ? `echo "Lucid: ${message}" >&2; exit 1\n` : `Write-Host "Lucid: ${message}" -ForegroundColor Red\n`, status);
      if (!SAFE_URL.test(endpoint)) return failed("set LUCID_PUBLIC_URL on the server to a plain https URL", 500);
      const setup = connectSetup({ for: c.req.query("for"), ai: c.req.query("ai") }, endpoint, Object.keys(upstreams()));
      // The error names what was asked for, which only passes the checks as plain words.
      if ("error" in setup) return failed(`${setup.error.replace(/[^\w .-]/g, "")}. Copy the command from Lucid again.`, 400);
      return c.text(connectScript(file, endpoint, setup), 200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" });
    });
  }

  app.get("/install/lucid.mjs", (c) => {
    if (!existsSync(CLI_BUNDLE)) return c.text("This Lucid server has no CLI build (npm run build -w @lucid/cli).", 404);
    return c.body(readFileSync(CLI_BUNDLE, "utf8"), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
  });

  return app;
}
