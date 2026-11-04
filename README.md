# Lucid

Open-source monitoring for AI agents. See every run your agent makes, catch the failures that look like success, and send the fix to the agent in one click.

License: [MIT](LICENSE)

- **Every run, captured.** Prompts, model calls, tool calls, sub-agents, tokens and cost, from Hermes Agent, Claude Code, OpenClaw, any app that calls an AI API, and anything that speaks OpenTelemetry.
- **Read a run like a story.** What the agent was asked, what it decided at each step, and what each step cost.
- **An Inbox of problems, not logs.** Failures are grouped by their cause across runs. An AI model (Meta's Muse Spark by default) explains each one in plain words, rates how much it matters, and writes a fix. Lucid also catches problems no step reports: loops, cost spikes, and answers that don't match what happened.
- **One click sends the fix.** The fix goes to the agent (Hermes Agent today) and applies from its next turn. Lucid then watches whether the problem stops. For other agents, Lucid gives you the fix to paste.
- **Arena.** Replay a real decision with other models or a changed prompt, and compare the answers blind.

## Quick start

This runs Lucid on your computer. There's no sign-up or sign-in, and no database to set up: Lucid keeps its data in `.lucid/` with an embedded Postgres.

You need:

- [Node.js](https://nodejs.org) 22.12 or newer (check with `node -v`) and Git.
- An API key for the AI model Lucid uses. Any one of these works:
  - **Meta's Model API** (Muse Spark): a key from [dev.meta.ai/api-keys](https://dev.meta.ai/api-keys).
  - **OpenRouter**: a key from [openrouter.ai/keys](https://openrouter.ai/keys). Lucid uses Muse Spark there too.
  - **Baseten** (Muse Spark): a key from Baseten.

**1. Get the code and install it.**

```bash
git clone https://github.com/Ahoo-11/lucid-ai.git
cd lucid-ai
npm install
```

**2. Add your AI key.** Copy the example settings:

```bash
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead. Then open `.env` and set your key on one line, for example:

```
META_API_KEY=your-key-here
```

Use `OPENROUTER_API_KEY=` or `BASETEN_API_KEY=` instead if that's the key you have.

**3. Start Lucid.**

```bash
npm start
```

The first start builds the dashboard, which takes a few seconds. When you see `Lucid is listening on http://127.0.0.1:4318`, open **http://127.0.0.1:4318**. The terminal also prints which AI it found, for example `AI: Meta, muse-spark-1.3`.

**4. Connect your agent.** Open **Connect** in the dashboard, or see [Connect your own agent](#connect-your-own-agent) below. Its runs show up in **Sessions** as they happen. Then:

1. **Inbox.** When something keeps going wrong across runs, the AI explains it within a minute or so: what happened, why it matters, and the fix.
2. **Apply fix.** Open a problem and click **Apply fix to Hermes**. The fix is sent at once and applies from the agent's next turn. **Test first** is optional: it replays past runs with the fix and tells you how it did.
3. **Sessions.** Open a run and expand **Workings** to see every step.
4. **Usage.** See cost and tokens by day.
5. **Arena.** In a run, click one of the agent's decisions, then **Try this decision with another model or prompt**.

## Connect your own agent

Your agent has to be able to reach Lucid. The commands below work when the agent runs on the same computer as Lucid.

The easiest way is **Connect** in the dashboard. Pick your agent, and Lucid gives you one command to run (or a message to paste to your agent) plus a page where you click **Approve**. You don't copy any keys.

You can also run the commands yourself:

| Agent | How |
|---|---|
| **Claude Code, Hermes Agent** (found on this computer) | macOS/Linux: `curl -fsSL http://127.0.0.1:4318/connect.sh \| sh`. Windows PowerShell: `irm http://127.0.0.1:4318/connect.ps1 \| iex`. It finds your agents, opens an Approve page, and connects them. Then start a new Claude Code session, or restart Hermes. |
| **Claude Code** (from this folder) | `npm run lucid -- connect claude-code` adds Lucid's hooks to `~/.claude/settings.json` (it backs the file up first). `npm run lucid -- import claude-code --days 7` brings in recent sessions. Undo with `npm run lucid -- disconnect claude-code`. |
| **Hermes Agent** (from this folder) | `npm run lucid -- connect hermes` installs Lucid's plugin, then restart Hermes. `npm run lucid -- import hermes --days 30` brings in past conversations. |
| **Any app that calls an AI API** (LangChain, LangGraph, CrewAI, Pydantic AI, your own code) | Change its base URL to go through Lucid: `http://127.0.0.1:4318/proxy/<provider>/…`. For example `OPENAI_BASE_URL=http://127.0.0.1:4318/proxy/openai/v1`, or for Meta's Model API `http://127.0.0.1:4318/proxy/meta/v1`. Your provider key passes through and is never stored. Providers: `meta`, `openai`, `anthropic`, `openrouter`, `gemini`, `groq`, `deepseek`, `mistral`, `xai`, `together`, `fireworks`, `baseten`. |
| **OpenTelemetry** (OpenAI Agents SDK, Vercel AI SDK, and others) | Set `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`. Lucid reads the OTel GenAI, OpenInference, OpenLLMetry and Vercel AI SDK conventions. |

## The AI model

Lucid needs a model for its own work: explaining problems, grouping them, rating them, writing and testing fixes, and the Arena. Set one key in `.env`. If more than one is set, the first in this table wins.

| Setting | What it uses |
|---|---|
| `META_API_KEY` (or `MODEL_API_KEY`, the name Meta's docs use) | Meta's Model API at `https://api.meta.ai/v1`, model `muse-spark-1.3`. `META_API_BASE` changes the address. |
| `BASETEN_API_KEY` | Muse Spark on Baseten. |
| `OPENROUTER_API_KEY` | OpenRouter: `meta/muse-spark-1.3` for Lucid's own work, and any model in the Arena. |
| `LUCID_REPLAY_API_KEY` with `LUCID_REPLAY_BASE_URL` and `LUCID_AI_MODEL` | Any other OpenAI-compatible API. |
| `LUCID_AI_MODEL` | Optional: another model for Lucid's own work. |

Without a key, Lucid still captures and shows every run, but the Inbox can't explain or fix anything.

## Run it for a team

Run `docker compose up -d` in `selfhost/`, after putting `POSTGRES_PASSWORD=…` in `selfhost/.env`. You can also run the root `Dockerfile` with an external Postgres. When Lucid listens on any address other than localhost, it switches to hosted mode: people sign in, each account gets its own project, and agents need a key.

| Variable | |
|---|---|
| `DATABASE_URL` | Postgres. Required when hosted (the embedded database is for one machine). |
| `LUCID_PUBLIC_URL` | Optional. The public address used in setup commands; by default it comes from the reverse proxy's `X-Forwarded-Proto` / `X-Forwarded-Host`. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Sign-in through Clerk. Without them, sign-in is built-in email and password. |
| `LUCID_SIGNUPS=closed` | Only existing accounts can sign in. |
| `LUCID_AUTH=on` | Hosted mode on localhost too, for testing. |

## Development

```bash
npm run dev          # the server, plus the dashboard with hot reload at http://localhost:5173
npm test             # unit and integration tests (in-memory Postgres)
npm run typecheck
python -I packages/hermes-plugin/test_lucid_plugin.py
```

After changing a parser, replay the stored events without sending anything again: `POST /api/reprocess {"harness": "hermes"}` (add `"rebuild": true` to rebuild that agent's runs).

```
apps/server             API: ingest (OTLP, hooks, transcripts), LLM proxy, installers, Inbox, Arena, live updates
apps/web                Dashboard: Inbox, Sessions, Usage, Connect, Arena
packages/schema         The data model (Session → Run → Step) and database tables
packages/normalize      One mapper per source: Claude Code, Hermes, OpenTelemetry, proxy
packages/hermes-plugin  The Hermes Agent plugin (Python standard library only)
packages/cli            The `lucid` CLI: connect, hook forwarder, import
packages/pricing        Model prices (live OpenRouter catalog), cache tokens included
packages/redact         Secret scrubbing before anything is stored
```

## License

MIT. See [LICENSE](LICENSE). Everything in this repository, the Inbox and the Arena included, is under the MIT license.
