#!/bin/sh
# Connects the AI agents on this computer to Lucid: Claude Code and Hermes Agent.
#   curl -fsSL __LUCID_ENDPOINT__/connect.sh | sh
# It asks you to approve this computer in your browser, then sets each agent
# up. No key to copy. Run it again any time to reconnect or update.
# Only some agents: ... | LUCID_AGENTS=hermes sh. Don't open a browser: LUCID_NO_BROWSER=1
set -eu
LUCID_ENDPOINT="${LUCID_ENDPOINT:-__LUCID_ENDPOINT__}"
HERMES_DIR="${HERMES_HOME:-$HOME/.hermes}"

say() { printf '%s\n' "$*"; }
fail() { printf '\nLucid: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  if has curl; then curl -fsSL "$1" -o "$2"
  elif has wget; then wget -qO "$2" "$1"
  else fail "this needs curl or wget."
  fi
}

# POSTs JSON and prints the reply; prints nothing when Lucid can't be reached.
post() {
  if has curl; then curl -sS -X POST -H 'content-type: application/json' --data "$2" "$LUCID_ENDPOINT$1" 2>/dev/null || true
  else wget -qO- --header='content-type: application/json' --post-data="$2" "$LUCID_ENDPOINT$1" 2>/dev/null || true
  fi
}

# One plain string field from a JSON reply.
field() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p'; }

AGENTS="${LUCID_AGENTS:-}"
if [ -z "$AGENTS" ]; then
  if [ -d "$HOME/.claude" ] || has claude; then AGENTS="claude-code"; fi
  if [ -d "$HERMES_DIR" ] || has hermes; then AGENTS="${AGENTS:+$AGENTS,}hermes"; fi
fi
wants() { case ",$AGENTS," in *",$1,"*) return 0 ;; esac; return 1; }

# Claude Code's hooks run Lucid's small Node.js helper. "v22.13.0" -> 22.
NODE_MAJOR=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
if wants claude-code && [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  say "Found Claude Code, but connecting it needs Node.js 18 or newer: https://nodejs.org"
  AGENTS=$(printf '%s' "$AGENTS" | sed 's/claude-code//; s/^,//; s/,$//')
fi
[ -n "$AGENTS" ] || fail "no Claude Code or Hermes Agent found on this computer. For other agents, follow the setup in Lucid."

NAMES=$(printf '%s' "$AGENTS" | sed 's/claude-code/Claude Code/; s/hermes/Hermes Agent/; s/,/ and /')
MACHINE=$( (hostname 2>/dev/null || uname -n) | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
case "$(uname -s 2>/dev/null)" in
  Darwin) OS=macOS ;;
  Linux) OS=Linux ;;
  *) OS=Unix ;;
esac

say "Lucid: connecting $NAMES on $MACHINE..."
AGENTS_JSON=$(printf '%s' "$AGENTS" | sed 's/[^,][^,]*/"&"/g')
START=$(post /api/links/start "{\"machine\":\"$MACHINE\",\"os\":\"$OS\",\"agents\":[$AGENTS_JSON]}")
DEVICE=$(field "$START" deviceCode)
if [ -z "$DEVICE" ]; then
  ERROR=$(field "$START" error)
  fail "${ERROR:-couldn't reach $LUCID_ENDPOINT. Check the address and your connection.}"
fi
CODE=$(field "$START" userCode)
URL=$(field "$START" url)

say ""
say "  Approve this computer in your browser:"
say "    $URL"
say ""
say "  Check that the page shows the code $CODE."
say ""
if [ -n "${LUCID_NO_BROWSER:-}" ]; then :
elif [ "$OS" = macOS ] && has open; then open "$URL" </dev/null >/dev/null 2>&1 || true
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && has xdg-open; then xdg-open "$URL" </dev/null >/dev/null 2>&1 || true
fi
say "Waiting for your approval (up to 10 minutes)..."

KEY=""
tries=0
while [ "$tries" -lt 320 ]; do
  sleep 2
  tries=$((tries + 1))
  ANSWER=$(post /api/links/poll "{\"deviceCode\":\"$DEVICE\"}")
  case "$ANSWER" in
    *'"status":"approved"'*) KEY=$(field "$ANSWER" key); break ;;
    *'"status":"denied"'*) fail "the request was declined in Lucid." ;;
    *'"status":"expired"'* | *'"status":"claimed"'*) fail "the code expired. Run this again for a new one." ;;
  esac
done
[ -n "$KEY" ] || fail "no approval after 10 minutes. Run this again for a new code."
say "Approved."
say ""

if wants hermes; then
  DEST="$HERMES_DIR/plugins/lucid"
  mkdir -p "$DEST"
  for f in __init__.py plugin.yaml; do
    fetch "$LUCID_ENDPOINT/install/hermes/lucid/$f" "$DEST/$f.part"
    mv "$DEST/$f.part" "$DEST/$f"
  done
  # Settings go in Hermes' own .env, which it loads before plugins. Rewritten
  # in place (not replaced) so a bind-mounted .env keeps working.
  ENV_FILE="$HERMES_DIR/.env"
  touch "$ENV_FILE"
  set_env() {
    grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.lucid" || true
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE.lucid"
    cat "$ENV_FILE.lucid" > "$ENV_FILE"
    rm -f "$ENV_FILE.lucid"
  }
  set_env LUCID_ENDPOINT "$LUCID_ENDPOINT"
  set_env LUCID_API_KEY "$KEY"
  # The plugin uploads the last 30 days once, then remembers it did.
  set_env LUCID_BACKFILL_DAYS 30
  if has hermes && hermes plugins enable lucid </dev/null >/dev/null 2>&1; then
    say "- Hermes Agent: connected. Restart Hermes (the gateway, the desktop app or its container) so it loads."
  else
    say "- Hermes Agent: plugin installed. Run \"hermes plugins enable lucid\", then restart Hermes."
  fi
fi

if wants claude-code; then
  LUCID_DIR="$HOME/.lucid"
  mkdir -p "$LUCID_DIR"
  fetch "$LUCID_ENDPOINT/install/lucid.mjs" "$LUCID_DIR/lucid.mjs.part"
  mv "$LUCID_DIR/lucid.mjs.part" "$LUCID_DIR/lucid.mjs"
  node "$LUCID_DIR/lucid.mjs" connect claude-code --endpoint "$LUCID_ENDPOINT" --key "$KEY" </dev/null >/dev/null || fail "couldn't update Claude Code's settings."
  say "- Claude Code: connected. Start a new Claude Code session and it shows up in Lucid."
  say "  Uploading your last 7 days of sessions..."
  node "$LUCID_DIR/lucid.mjs" import claude-code --days 7 --endpoint "$LUCID_ENDPOINT" --key "$KEY" </dev/null 2>&1 | tail -n 1 | sed 's/^/  /' || true
fi

say ""
say "Done. See your runs at $LUCID_ENDPOINT"
