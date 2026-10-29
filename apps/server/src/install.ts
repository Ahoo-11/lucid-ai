// One-line installers served by Lucid itself, so an agent on any machine (a
// VPS, a container) can be connected without cloning this repo and without a
// published package. Public: the plugin is open source, and the only value
// baked in is this server's public address.
//
//   curl -fsSL https://<lucid>/install/hermes.sh | LUCID_API_KEY=<key> sh

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";

const HERMES_PLUGIN = fileURLToPath(new URL("../../../packages/hermes-plugin/lucid/", import.meta.url));
const HERMES_FILES = new Set(["__init__.py", "plugin.yaml"]);

/** The address agents should send to: LUCID_PUBLIC_URL behind a reverse proxy, else what the browser used. */
export const publicEndpoint = (c: Context) => (process.env.LUCID_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/+$/, "");

// The endpoint is pasted into a shell script, so only plain URLs pass.
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/;

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
if command -v hermes >/dev/null 2>&1 && hermes plugins enable lucid >/dev/null 2>&1; then
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

  return app;
}
