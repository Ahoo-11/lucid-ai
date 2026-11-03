#!/bin/sh
# Connects AI agents to Lucid. By default, the ones on this computer: Claude Code and Hermes Agent.
#   curl -fsSL __LUCID_ENDPOINT__/connect.sh | sh
# Setup links in Lucid add what to connect instead, and Lucid fills in its settings:
#   ?for=project&ai=<provider>   the agent in this folder, through Lucid's proxy: adds to its .env
#   ?for=tracing                 the agent in this folder, by OpenTelemetry: adds to its .env
#   ?for=openclaw&ai=<provider>  OpenClaw: saves settings for it to merge into its config
# It asks you to approve in your browser, then sets things up. No key to copy.
# Run it again any time to reconnect or update.
# Only some agents: ... | LUCID_AGENTS=hermes sh. Don't open a browser: LUCID_NO_BROWSER=1
set -eu
LUCID_ENDPOINT="${LUCID_ENDPOINT:-__LUCID_ENDPOINT__}"
LUCID_FOR="__LUCID_FOR__"
# What to write, from Lucid; the key slot in it becomes the key you approve.
LUCID_ENV='__LUCID_ENV__'
LUCID_OPENCLAW='__LUCID_OPENCLAW__'
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

# One plain string field, or whole number, from a JSON reply.
field() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p'; }
number() { printf '%s' "$1" | sed -n 's/.*"'"$2"'":\([0-9][0-9]*\).*/\1/p'; }

MACHINE=$( (hostname 2>/dev/null || uname -n) | tr -cd 'A-Za-z0-9._ -' | cut -c1-64)
case "$(uname -s 2>/dev/null)" in
  Darwin) OS=macOS ;;
  Linux) OS=Linux ;;
  *) OS=Unix ;;
esac

case "$LUCID_FOR" in
  agents)
    AGENTS="${LUCID_AGENTS:-}"
    if [ -z "$AGENTS" ]; then
      if [ -d "$HOME/.claude" ] || has claude; then AGENTS="claude-code"; fi
      if [ -d "$HERMES_DIR" ] || has hermes; then AGENTS="${AGENTS:+$AGENTS,}hermes"; fi
    fi
    # Claude Code's hooks run Lucid's small Node.js helper. "v22.13.0" -> 22.
    NODE_MAJOR=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
    case ",$AGENTS," in *",claude-code,"*)
      if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
        say "Found Claude Code, but connecting it needs Node.js 18 or newer: https://nodejs.org"
        AGENTS=$(printf '%s' "$AGENTS" | sed 's/claude-code//; s/^,//; s/,$//')
      fi
    esac
    [ -n "$AGENTS" ] || fail "no Claude Code or Hermes Agent found on this computer. For other agents, follow the setup in Lucid."
    WHAT="$(printf '%s' "$AGENTS" | sed 's/claude-code/Claude Code/; s/hermes/Hermes Agent/; s/,/ and /') on $MACHINE"
    LABEL="$MACHINE"
    ;;
  openclaw)
    # OpenClaw may run commands in a sandbox of their own, where its config isn't.
    [ -d "$HOME/.openclaw" ] || has openclaw || fail "no OpenClaw found here. If this terminal runs in a separate sandbox, run it where OpenClaw itself runs."
    AGENTS=openclaw
    WHAT="OpenClaw on $MACHINE"
    LABEL="$MACHINE"
    ;;
  *)
    AGENTS=project
    FOLDER=$(basename "$PWD" | tr -cd 'A-Za-z0-9._ -' | cut -c1-40)
    WHAT="the agent in $FOLDER"
    LABEL="$FOLDER on $MACHINE"
    ;;
esac
wants() { case ",$AGENTS," in *",$1,"*) return 0 ;; esac; return 1; }

say "Lucid: connecting $WHAT..."
AGENTS_JSON=$(printf '%s' "$AGENTS" | sed 's/[^,][^,]*/"&"/g')
START=$(post /api/links/start "{\"machine\":\"$LABEL\",\"os\":\"$OS\",\"agents\":[$AGENTS_JSON]}")
DEVICE=$(field "$START" deviceCode)
if [ -z "$DEVICE" ]; then
  ERROR=$(field "$START" error)
  fail "${ERROR:-couldn't reach $LUCID_ENDPOINT. Check the address and your connection.}"
fi
CODE=$(field "$START" userCode)
URL=$(field "$START" url)

say ""
say "  Approve this in your browser:"
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
    *'"status":"approved"'*) KEY=$(field "$ANSWER" key); HISTORY_DAYS=$(number "$ANSWER" historyDays); break ;;
    *'"status":"denied"'*) fail "the request was declined in Lucid." ;;
    *'"status":"expired"'* | *'"status":"claimed"'*) fail "the code expired. Run this again for a new one." ;;
  esac
done
[ -n "$KEY" ] || fail "no approval after 10 minutes. Run this again for a new code."
# Past runs come in only if the person asked for them on the Approve page.
HISTORY_DAYS="${HISTORY_DAYS:-0}"
say "Approved."
say ""

# Lucid's settings with the key in its slot. Keys are letters, digits and underscores.
filled() { printf '%s\n' "$1" | sed "s|__LUCID_KEY__|$KEY|g"; }

if wants project; then
  # The folder this runs in is the agent's project. Its other settings stay as they are.
  ENV_FILE="$PWD/.env"
  touch "$ENV_FILE"
  NAMES=$(printf '%s\n' "$LUCID_ENV" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p')
  PATTERN=$(printf '%s' "$NAMES" | tr '\n' '|')
  grep -v -E "^($PATTERN)=" "$ENV_FILE" > "$ENV_FILE.lucid" || true
  filled "$LUCID_ENV" >> "$ENV_FILE.lucid"
  cat "$ENV_FILE.lucid" > "$ENV_FILE"
  rm -f "$ENV_FILE.lucid"
  say "- Added to $ENV_FILE, with your Lucid key in them:"
  printf '%s\n' "$NAMES" | sed 's/^/    /'
  if has git && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git check-ignore -q .env 2>/dev/null; then
    say "  .env isn't in .gitignore. Add it there, so your Lucid key isn't committed."
  fi
  say "  The agent's code has to use them; then run the agent once. Where it also runs on a server,"
  say "  add the same settings to that server's environment settings."
fi

if wants openclaw; then
  mkdir -p "$HOME/.lucid"
  SETTINGS="$HOME/.lucid/openclaw.json5"
  filled "$LUCID_OPENCLAW" > "$SETTINGS"
  chmod 600 "$SETTINGS" 2>/dev/null || true
  say "- OpenClaw: Lucid's settings are in $SETTINGS, with your Lucid key in them."
  say "  Merge them into ~/.openclaw/openclaw.json, keeping your own key and models, then run: openclaw gateway restart"
fi

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
  unset_env() {
    grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.lucid" || true
    cat "$ENV_FILE.lucid" > "$ENV_FILE"
    rm -f "$ENV_FILE.lucid"
  }
  set_env() {
    unset_env "$1"
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  }
  set_env LUCID_ENDPOINT "$LUCID_ENDPOINT"
  set_env LUCID_API_KEY "$KEY"
  # The plugin uploads past chats once, after the restart, then remembers it did.
  if [ "$HISTORY_DAYS" -gt 0 ]; then set_env LUCID_BACKFILL_DAYS "$HISTORY_DAYS"; else unset_env LUCID_BACKFILL_DAYS; fi
  if has hermes && hermes plugins enable lucid </dev/null >/dev/null 2>&1; then
    say "- Hermes Agent: connected. Restart Hermes (the gateway, the desktop app or its container) so it loads."
  else
    say "- Hermes Agent: plugin installed. Run \"hermes plugins enable lucid\", then restart Hermes."
  fi
  if [ "$HISTORY_DAYS" -gt 0 ]; then say "  After the restart it brings in your last $HISTORY_DAYS days of chats. Lucid shows the progress."; fi
fi

if wants claude-code; then
  LUCID_DIR="$HOME/.lucid"
  mkdir -p "$LUCID_DIR"
  fetch "$LUCID_ENDPOINT/install/lucid.mjs" "$LUCID_DIR/lucid.mjs.part"
  mv "$LUCID_DIR/lucid.mjs.part" "$LUCID_DIR/lucid.mjs"
  node "$LUCID_DIR/lucid.mjs" connect claude-code --endpoint "$LUCID_ENDPOINT" --key "$KEY" </dev/null >/dev/null || fail "couldn't update Claude Code's settings."
  say "- Claude Code: connected. Start a new Claude Code session and it shows up in Lucid."
  if [ "$HISTORY_DAYS" -gt 0 ]; then
    # In the background, so this command is done now; Lucid shows the progress.
    if has nohup; then
      nohup node "$LUCID_DIR/lucid.mjs" import claude-code --days "$HISTORY_DAYS" --endpoint "$LUCID_ENDPOINT" --key "$KEY" </dev/null >"$LUCID_DIR/import.log" 2>&1 &
    else
      node "$LUCID_DIR/lucid.mjs" import claude-code --days "$HISTORY_DAYS" --endpoint "$LUCID_ENDPOINT" --key "$KEY" </dev/null >"$LUCID_DIR/import.log" 2>&1 &
    fi
    say "  Bringing in your last $HISTORY_DAYS days of sessions in the background. Lucid shows the progress."
  fi
fi

say ""
say "Done. See your runs at $LUCID_ENDPOINT"
