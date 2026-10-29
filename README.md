# Lucid (working name)

See why your AI agents do what they do, and prove which model and prompt work best.

Lucid captures every run from popular agent harnesses (every prompt, model call, tool call and sub-agent), shows each run as a readable story, groups failures by cause with a suggested fix, and (next) replays real decisions against other models and prompts for blind comparison.

## Run it locally

```bash
npm install
npm run build -w @lucid/web
npm run build -w @lucid/cli
npm run start -w @lucid/server
```

Open http://127.0.0.1:4318. The server keeps its data in `.lucid/` (embedded Postgres; set `DATABASE_URL` to use a real Postgres instead).

For UI work, run `npm run dev`. It starts the server and the Vite dev server (http://localhost:5173) together.

## Connect an agent

| Agent | How |
|---|---|
| Any agent (LLM proxy) | Change the model base URL to `https://<lucid>/p/<lucid key>/<provider>/…` (e.g. `…/p/<key>/openai/v1`, `…/p/<key>/anthropic`), or `/proxy/<provider>/…` with an `x-lucid-key` header. Requests go to the provider unchanged with the agent's own provider key, which Lucid never stores; the exchange is recorded after the reply finishes. Covers OpenAI-style chat completions and Anthropic messages, streaming included, for OpenAI, Anthropic, OpenRouter, Gemini, Groq, DeepSeek, Mistral, xAI, Together and Fireworks. Optional headers `x-lucid-agent`, `x-lucid-session`, `x-lucid-run`, `x-lucid-user` name and group runs. Self-hosters add upstreams with `LUCID_PROXY_UPSTREAMS='{"vllm":"http://…"}'`. |
| Hermes Agent, anywhere | `curl -fsSL https://<lucid>/install/hermes.sh \| LUCID_API_KEY=<key> sh` on the machine (or `docker exec` into the container) that runs Hermes. Lucid serves the plugin itself; the script puts it in Hermes' `plugins/lucid`, writes `LUCID_ENDPOINT` / `LUCID_API_KEY` to Hermes' `.env` and enables it. Add `LUCID_BACKFILL_DAYS=30` to upload past conversations once. While Lucid is unreachable, events wait in `<hermes home>/lucid-spool` (max 50 MB) and are resent later. |
| Hermes Agent, this computer | `npm run lucid -- connect hermes` does the same from this repo; `npm run lucid -- import hermes --days 30` reads past sessions from Hermes' `state.db` (read-only). Undo with `disconnect hermes`. |
| Claude Code | `npm run lucid -- connect claude-code` adds hooks to `~/.claude/settings.json` (backed up; undo with `disconnect`). `npm run lucid -- import claude-code --days 7` loads recent sessions. |
| Anything with OpenTelemetry | Point `OTEL_EXPORTER_OTLP_ENDPOINT` at Lucid (plus `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<key>` when hosted). Accepts OTLP/HTTP protobuf or JSON in the OTel GenAI, OpenInference, OpenLLMetry and Vercel AI SDK conventions, plus Claude Code's own events. |

The Connect page in the dashboard has these with your address and key filled in.

## Host it

`docker compose up -d` (see `docker-compose.yml`; set `POSTGRES_PASSWORD`) or deploy the `Dockerfile` with `deploy.yaml`. Binding to anything other than localhost turns on hosted mode: email sign-in, one project per account, keys required for ingest.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres. Required when hosted (the embedded database is for one machine). |
| `LUCID_PUBLIC_URL` | Optional. The public address shown in setup snippets and the Hermes installer; by default it comes from the reverse proxy's `X-Forwarded-Proto` / `X-Forwarded-Host`. |
| `LUCID_SIGNUPS=closed` | Only existing accounts can sign in. |
| `LUCID_AUTH=on` | Hosted mode even on localhost (for testing). |
| `OPENROUTER_API_KEY` | Arena replays and the AI judge. |

## Arena: find the best model and prompt, blind

Open a run, click a model decision, then **Try this decision with another model or prompt**. Lucid takes the exact request the agent sent (messages and full tool schemas) to each model you pick, optionally with a changed system prompt. Tools are offered but never run, so you compare the next step each one would take. You vote on unlabeled answers (keys `1` / `2` / `3`). An AI judge can vote too; it never sees model names and votes twice with the order swapped. Then reveal which was which to get a recommendation.

Replays use your own key: set `OPENROUTER_API_KEY` (one key reaches every model), or `LUCID_REPLAY_API_KEY` plus `LUCID_REPLAY_BASE_URL` for any OpenAI-compatible API. On Windows the server reads the user-level variable, so a changed key works without restarting whatever launched it. Replayable today: Hermes and OpenTelemetry sources that record message content. Claude Code decisions can't be replayed yet.

## Layout

```
apps/server         Hono API: OTLP + hook + transcript ingest, LLM proxy, installers, auth, dashboard API, live updates
apps/web            React dashboard: Inbox, Runs, Run, Arena, Connect
packages/schema     Normalized model (Session → Run → Step) and Drizzle tables
packages/normalize  One mapper per source: Claude Code, Hermes, OTLP traces/logs, proxy exchanges
packages/hermes-plugin  Hermes Agent plugin (stdlib Python): hooks, offline spool, history backfill
packages/pricing    Model prices (live OpenRouter catalog) incl. cache tokens
packages/redact     Secret/PII scrubbing with consistent placeholders
packages/cli        `lucid` CLI: connect, hook forwarder, import
```

## Tests

```bash
npm test            # unit + integration (in-memory Postgres)
npm run typecheck
python -I packages/hermes-plugin/test_lucid_plugin.py
```

After a parser change, replay stored events without re-sending anything: `POST /api/reprocess {"harness": "hermes"}` (add `"rebuild": true` to drop and rebuild that harness's runs; not available for Claude Code transcripts).
