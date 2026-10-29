import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, KeyRound, Server, Terminal, TriangleAlert, Waypoints } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { ago, harnessLabel, plural } from "../format";
import { Card, CodeBlock, CopyButton, Section, cx } from "../ui";

const SOURCE_LABELS: Record<string, string> = {
  transcript: "session files",
  hook: "hooks",
  otlp_traces: "OpenTelemetry traces",
  otlp_logs: "OpenTelemetry events",
  proxy: "the LLM proxy",
};

type AgentType = "proxy" | "hermes" | "claude-code" | "otel";

const AGENT_TYPES: { id: AgentType; title: string; blurb: string; icon: typeof Bot; badge?: string }[] = [
  { id: "proxy", title: "Any agent", blurb: "Change one URL. Any framework or app that calls OpenAI, Anthropic, OpenRouter and others.", icon: Waypoints, badge: "Works everywhere" },
  { id: "hermes", title: "Hermes Agent", blurb: "A plugin for the CLI, gateway and desktop app, on this computer or a server.", icon: Bot },
  { id: "claude-code", title: "Claude Code", blurb: "Hooks plus session files: prompts, tool calls, sub-agents and cost.", icon: Terminal },
  { id: "otel", title: "OpenTelemetry", blurb: "Frameworks with tracing built in: OpenAI Agents, LangGraph, Pydantic AI, Vercel AI…", icon: Activity },
];

/** What the page needs from the server and the key in hand, shared by every panel. */
type Target = {
  endpoint: string;
  /** Sending from this machine to a local Lucid: no key needed. */
  keyless: boolean;
  key: string;
  hasKey: boolean;
  /** Lucid listens on this computer only, so other machines cannot reach it. */
  loopback: boolean;
};

export function Connect() {
  const status = useQuery({
    queryKey: ["connect"],
    queryFn: api.connect,
    // Poll until the first data arrives, so the light turns green on its own.
    refetchInterval: (query) => ((query.state.data?.runs ?? 0) > 0 ? 15_000 : 2_000),
  });
  const [params, setParams] = useSearchParams();
  const [newKey, setNewKey] = useState<string | null>(null);
  const local = status.data?.localMode ?? true;
  const endpoint = status.data?.endpoint ?? "http://127.0.0.1:4318";
  const target: Target = {
    endpoint,
    keyless: local && !newKey,
    key: newKey ?? "<your-lucid-key>",
    hasKey: !!newKey,
    loopback: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(endpoint),
  };
  const type = (AGENT_TYPES.find((t) => t.id === params.get("agent"))?.id ?? "proxy") as AgentType;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Connect an agent</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Pick how your agent runs. Every path ends up in the same Runs view.</p>
      </div>

      <LiveStatus data={status.data} />
      <KeyBar local={local} newKey={newKey} onCreated={setNewKey} />

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" role="tablist" aria-label="Agent type">
        {AGENT_TYPES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === type}
            onClick={() => setParams({ agent: t.id }, { replace: true })}
            className={cx(
              "rounded-xl border p-3 text-left transition-colors",
              t.id === type
                ? "border-violet-400 bg-violet-50 ring-1 ring-violet-400 dark:border-violet-500 dark:bg-violet-500/10 dark:ring-violet-500"
                : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700",
            )}
          >
            <div className="flex items-center gap-2 font-semibold">
              <t.icon className="size-4 shrink-0" />
              {t.title}
            </div>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t.blurb}</p>
            {t.badge && <span className="mt-2 inline-block rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">{t.badge}</span>}
          </button>
        ))}
      </div>

      {type === "proxy" && <ProxyPanel target={target} providers={status.data?.providers ?? Object.keys(PROVIDERS)} />}
      {type === "hermes" && <HermesPanel target={target} />}
      {type === "claude-code" && <ClaudeCodePanel target={target} />}
      {type === "otel" && <OtelPanel target={target} />}

      <Keys local={local} />
    </div>
  );
}

function LiveStatus({ data }: { data: Awaited<ReturnType<typeof api.connect>> | undefined }) {
  const receiving = (data?.runs ?? 0) > 0;
  const last = data?.sources.reduce<string | null>((latest, source) => (!latest || (source.lastAt && source.lastAt > latest) ? source.lastAt : latest), null);
  return (
    <Card className={cx("flex items-center gap-4 p-5", receiving && "border-emerald-200 dark:border-emerald-500/30")}>
      <span className="relative flex size-3">
        {!receiving && <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60" />}
        <span className={cx("relative inline-flex size-3 rounded-full", receiving ? "bg-emerald-500" : "bg-amber-400")} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{receiving ? `Receiving data · ${plural(data!.runs, "run")} so far` : "Waiting for your first run…"}</div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          {receiving ? (
            <>
              Last event {ago(last)} via{" "}
              {data!.sources.map((s) => `${s.harness && s.harness !== s.source ? `${harnessLabel(s.harness)} ` : ""}${SOURCE_LABELS[s.source] ?? s.source}`).join(", ")}.{" "}
              <Link to="/runs" className="text-violet-600 underline dark:text-violet-400">
                See runs
              </Link>
            </>
          ) : (
            "Follow one of the setups below; this turns green as soon as anything arrives."
          )}
        </div>
      </div>
    </Card>
  );
}

/** The key the snippets use. Shown up top because every remote setup needs it first. */
function KeyBar({ local, newKey, onCreated }: { local: boolean; newKey: string | null; onCreated: (key: string) => void }) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.createKey("Created on the Connect page"),
    onSuccess: (created) => {
      onCreated(created.key);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  if (newKey) {
    return (
      <Card className="flex items-center gap-3 border-emerald-200 p-4 dark:border-emerald-500/30">
        <KeyRound className="size-4 shrink-0 text-emerald-600" />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-emerald-700 dark:text-emerald-400">Your new key, already filled into the setups below. Copy it now: it won't be shown again.</div>
          <code className="block truncate font-mono text-sm">{newKey}</code>
        </div>
        <CopyButton text={newKey} />
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4">
      <KeyRound className="size-4 shrink-0 text-zinc-400" />
      <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-300">
        {local ? "Agents on this computer need no key. Agents on other machines do." : "Your agents need a Lucid key. Create one and it fills into every setup below."}
      </p>
      <button
        type="button"
        onClick={() => create.mutate()}
        disabled={create.isPending}
        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-zinc-900"
      >
        Create a key
      </button>
    </Card>
  );
}

function Panel({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
      </div>
      {children}
    </Card>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{n}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="text-sm font-medium">{title}</div>
        {children}
      </div>
    </div>
  );
}

function Pills<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          className={cx(
            "rounded-md px-2.5 py-1 text-xs font-medium",
            option.id === value ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <p
      className={cx(
        "flex gap-2 rounded-lg px-3 py-2 text-xs",
        tone === "warn" ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300" : "bg-zinc-50 text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-400",
      )}
    >
      {tone === "warn" && <TriangleAlert className="mt-px size-3.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

/** `remote`: the setup is for another machine, so a local-only Lucid cannot work at all. */
const LoopbackWarning = ({ target, remote }: { target: Target; remote?: boolean }) =>
  target.loopback ? (
    <Note tone={remote ? "warn" : "info"}>
      This Lucid listens on this computer only ({target.endpoint}){remote ? ", so a server or container elsewhere can't reach it" : ": fine for agents running here, unreachable for agents on other machines"}. For those, use a hosted
      Lucid, or run this one with <code className="font-mono">HOST=0.0.0.0</code> behind HTTPS and set <code className="font-mono">LUCID_PUBLIC_URL</code>.
    </Note>
  ) : null;

// ---------------------------------------------------------------------------
// Any agent: the LLM proxy

/** `base`: what goes after /proxy/<provider> to make the base URL the provider's own SDK expects. */
const PROVIDERS: Record<string, { label: string; base: string; keyVar: string; model: string; anthropic?: boolean }> = {
  openai: { label: "OpenAI", base: "/v1", keyVar: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", base: "", keyVar: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5", anthropic: true },
  openrouter: { label: "OpenRouter", base: "/v1", keyVar: "OPENROUTER_API_KEY", model: "openai/gpt-4o-mini" },
  gemini: { label: "Gemini", base: "", keyVar: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
  groq: { label: "Groq", base: "/v1", keyVar: "GROQ_API_KEY", model: "llama-3.3-70b-versatile" },
  deepseek: { label: "DeepSeek", base: "/v1", keyVar: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  mistral: { label: "Mistral", base: "/v1", keyVar: "MISTRAL_API_KEY", model: "mistral-small-latest" },
  xai: { label: "xAI", base: "/v1", keyVar: "XAI_API_KEY", model: "grok-3-mini" },
  together: { label: "Together", base: "/v1", keyVar: "TOGETHER_API_KEY", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  fireworks: { label: "Fireworks", base: "/v1", keyVar: "FIREWORKS_API_KEY", model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
};

type Lang = "python" | "typescript" | "env" | "curl";

function proxyBase(target: Target, provider: string) {
  const prefix = target.keyless ? `${target.endpoint}/proxy` : `${target.endpoint}/p/${target.key}`;
  return `${prefix}/${provider}${PROVIDERS[provider]?.base ?? ""}`;
}

function proxySnippet(lang: Lang, provider: string, base: string) {
  const p = PROVIDERS[provider] ?? { label: provider, base: "", keyVar: "API_KEY", model: "<model>" };
  if (p.anthropic) {
    if (lang === "python") return `from anthropic import Anthropic\n\nclient = Anthropic(base_url="${base}")  # still reads ${p.keyVar}`;
    if (lang === "typescript") return `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({ baseURL: "${base}" }); // still reads ${p.keyVar}`;
    if (lang === "env") return `# Anthropic SDKs, Claude Agent SDK, LangChain and most frameworks read this:\nANTHROPIC_BASE_URL=${base}`;
    return `curl ${base}/v1/messages \\\n  -H "x-api-key: $${p.keyVar}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model": "${p.model}", "max_tokens": 256, "messages": [{"role": "user", "content": "Hello"}]}'`;
  }
  if (lang === "python") return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}",\n    api_key=os.environ["${p.keyVar}"],  # your ${p.label} key, as before\n)`;
  if (lang === "typescript") return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}",\n  apiKey: process.env.${p.keyVar}, // your ${p.label} key, as before\n});`;
  if (lang === "env") {
    const key = provider === "openai" ? "" : `\nOPENAI_API_KEY=$${p.keyVar}`;
    return `# OpenAI SDKs, OpenAI Agents SDK, LangChain, CrewAI and most frameworks read this:\nOPENAI_BASE_URL=${base}${key}`;
  }
  return `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $${p.keyVar}" \\\n  -H "content-type: application/json" \\\n  -d '{"model": "${p.model}", "messages": [{"role": "user", "content": "Hello"}]}'`;
}

const LABEL_HEADERS: { name: string; what: string }[] = [
  { name: "x-lucid-agent", what: "Name of the agent, shown on every run (default: proxy)." },
  { name: "x-lucid-session", what: "Groups calls into one conversation. Without it, Lucid groups by system prompt and first message." },
  { name: "x-lucid-run", what: "Groups calls into one task. Without it, each new user message starts a run." },
  { name: "x-lucid-user", what: "Your end user's id, to find their runs later." },
];

function ProxyPanel({ target, providers }: { target: Target; providers: string[] }) {
  const [provider, setProvider] = useState(providers.includes("openai") ? "openai" : (providers[0] ?? "openai"));
  const [lang, setLang] = useState<Lang>("python");
  const base = proxyBase(target, provider);
  const p = PROVIDERS[provider];
  const headerSnippet = p?.anthropic
    ? `client = Anthropic(\n    base_url="${base}",\n    default_headers={"x-lucid-agent": "support-bot", "x-lucid-user": user_id},\n)`
    : `client = OpenAI(\n    base_url="${base}",\n    default_headers={"x-lucid-agent": "support-bot", "x-lucid-user": user_id},\n)`;
  return (
    <Panel
      title="Any agent: change one URL"
      description="Point your agent's model base URL at Lucid. Requests go on to the provider untouched and the reply streams straight back; Lucid records the prompt, tools, decision, tokens and cost after the reply is done."
    >
      <Step n={1} title="Pick the provider your agent calls">
        <Pills label="Provider" value={provider} onChange={setProvider} options={providers.map((id) => ({ id, label: PROVIDERS[id]?.label ?? id }))} />
      </Step>
      <Step n={2} title="Use this as the base URL">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950">
          <code className="min-w-0 flex-1 break-all font-mono text-sm">{base}</code>
          <CopyButton text={base} />
        </div>
        {!p && <Note>A provider added on this server: append the path your client normally adds after the provider's host.</Note>}
        <Pills
          label="Language"
          value={lang}
          onChange={setLang}
          options={[
            { id: "python", label: "Python" },
            { id: "typescript", label: "TypeScript" },
            { id: "env", label: "Environment variable" },
            { id: "curl", label: "curl" },
          ]}
        />
        <CodeBlock title={lang === "env" ? ".env" : lang} code={proxySnippet(lang, provider, base)} />
      </Step>
      <Step n={3} title="Optional: name and group your runs">
        <ul className="space-y-1 text-sm">
          {LABEL_HEADERS.map((h) => (
            <li key={h.name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <code className="w-36 shrink-0 font-mono text-xs leading-5 text-violet-700 dark:text-violet-300">{h.name}</code>
              <span className="text-zinc-600 dark:text-zinc-400">{h.what}</span>
            </li>
          ))}
        </ul>
        <CodeBlock title="python" code={headerSnippet} />
      </Step>
      <Note>
        Your {p?.label ?? provider} key goes to the provider as before; Lucid passes it through and never stores it. {target.keyless ? "" : "The Lucid key in the URL tells Lucid which project the run belongs to. "}
        Captured: chat completions and messages calls, streaming included. Other endpoints pass through unrecorded.
      </Note>
      <LoopbackWarning target={target} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Hermes

type HermesWhere = "server" | "docker" | "here";

function HermesPanel({ target }: { target: Target }) {
  // Until picked, follow the server address (which loads after the first render).
  const [picked, setWhere] = useState<HermesWhere | null>(null);
  const where = picked ?? (target.loopback ? "here" : "server");
  const env = [!target.keyless && `LUCID_API_KEY=${target.key}`, "LUCID_BACKFILL_DAYS=30"].filter(Boolean).join(" ");
  const install = `curl -fsSL ${target.endpoint}/install/hermes.sh | ${env} sh`;
  const flags = cliFlags(target);
  const code =
    where === "server"
      ? install
      : where === "docker"
        ? `docker exec <hermes-container> sh -c '${install}'\ndocker restart <hermes-container>`
        : `npm run lucid -- connect hermes ${flags}\nnpm run lucid -- import hermes --days 30 ${flags}`.replace(/ +\n/g, "\n").trim();
  return (
    <Panel
      title="Hermes Agent"
      description="A small plugin listens to Hermes' observer hooks: every turn, model call, tool call, sub-agent and approval, from the CLI, the gateway and the desktop app."
    >
      <Pills
        label="Where Hermes runs"
        value={where}
        onChange={setWhere}
        options={[
          { id: "server", label: "On a server" },
          { id: "docker", label: "In Docker" },
          { id: "here", label: "On this computer" },
        ]}
      />
      <CodeBlock title={where === "here" ? "In the Lucid folder" : where === "docker" ? "On the Docker host" : "On the server, as the user that runs Hermes"} code={code} />
      {where === "here" ? (
        <p className="text-xs text-zinc-500">
          The first command copies the plugin into Hermes' <code className="font-mono">plugins/lucid</code> folder and runs <code className="font-mono">hermes plugins enable lucid</code>. The second loads your past sessions from
          Hermes' <code className="font-mono">state.db</code> without changing it. Restart a running gateway or desktop app so it loads.
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            Installs the plugin into Hermes' <code className="font-mono">plugins/lucid</code> folder, adds the <code className="font-mono">LUCID_*</code> settings to Hermes' <code className="font-mono">.env</code> and
            enables it. Restart Hermes so it loads. Run it again any time to update. No access to this machine is needed from Lucid's side: Hermes sends, Lucid only receives.
          </p>
          <Note>
            If Lucid is unreachable, events wait on disk next to Hermes' data (up to 50 MB) and are sent once it's back. <code className="font-mono">LUCID_BACKFILL_DAYS=30</code> uploads the last 30 days of conversations
            once; leave it out to start fresh.
          </Note>
          {!target.hasKey && !target.keyless && <Note tone="warn">Create a key above first; it replaces &lt;your-lucid-key&gt; in the command.</Note>}
          <LoopbackWarning target={target} remote />
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Claude Code

function cliFlags(target: Target) {
  // The CLI already defaults to this machine's server, so only other endpoints need the flag.
  const isLocalDefault = /^http:\/\/(localhost|127\.0\.0\.1):4318$/.test(target.endpoint);
  return [!isLocalDefault && `--endpoint ${target.endpoint}`, !target.keyless && `--key ${target.key}`].filter(Boolean).join(" ");
}

function ClaudeCodePanel({ target }: { target: Target }) {
  const flags = cliFlags(target);
  return (
    <Panel title="Claude Code" description="Adds hooks to Claude Code so every session shows up live, with prompts, decisions, tool calls, sub-agents and cost.">
      <CodeBlock title="In the Lucid folder" code={`npm run lucid -- connect claude-code ${flags}\nnpm run lucid -- import claude-code --days 7 ${flags}`.replace(/ +\n/g, "\n").trim()} />
      <p className="text-xs text-zinc-500">
        The first command edits <code className="font-mono">~/.claude/settings.json</code> (a backup is kept) and is undone by <code className="font-mono">disconnect claude-code</code>. The second loads your last 7 days of
        sessions so there is something to look at right away.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// OpenTelemetry

function OtelPanel({ target }: { target: Target }) {
  return (
    <Panel
      title="Frameworks with OpenTelemetry"
      description="OpenAI Agents SDK, LangGraph, CrewAI, Pydantic AI, Vercel AI SDK, Google ADK, Mastra, Strands, and anything instrumented with OpenInference or OpenLLMetry. Adds agent and handoff structure on top of the model calls."
    >
      <CodeBlock
        title=".env"
        code={[
          `OTEL_EXPORTER_OTLP_ENDPOINT=${target.endpoint}`,
          "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
          ...(target.keyless ? [] : [`OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${target.key}`]),
          "# Most libraries leave prompts and replies out unless you opt in:",
          "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
          "OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental",
        ].join("\n")}
      />
      <FrameworkSnippets />
      <Note>No tracing set up yet? The "Any agent" URL change captures the same model calls with no new packages.</Note>
      <LoopbackWarning target={target} />
    </Panel>
  );
}

const FRAMEWORKS: { name: string; title: string; code: string }[] = [
  {
    name: "OpenAI Agents SDK",
    title: "Python",
    code: `# pip install openinference-instrumentation-openai-agents opentelemetry-sdk opentelemetry-exporter-otlp
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # uses the OTEL_* variables
trace.set_tracer_provider(provider)
OpenAIAgentsInstrumentor().instrument()`,
  },
  {
    name: "LangGraph",
    title: ".env (with the variables above)",
    code: `# pip install "langsmith[otel]"
LANGSMITH_TRACING=true
LANGSMITH_OTEL_ENABLED=true
LANGSMITH_OTEL_ONLY=true   # send to Lucid only`,
  },
  {
    name: "Vercel AI SDK",
    title: "TypeScript",
    code: `// Register an OTLP exporter once (e.g. @vercel/otel in Next.js), then:
const result = await generateText({
  model,
  prompt,
  experimental_telemetry: { isEnabled: true },
});`,
  },
  {
    name: "Pydantic AI",
    title: "Python",
    code: `from pydantic_ai import Agent

# Configure an OTLP TracerProvider as in the OpenAI Agents example, then:
Agent.instrument_all()`,
  },
];

function FrameworkSnippets() {
  const [active, setActive] = useState(FRAMEWORKS[0]!.name);
  const framework = FRAMEWORKS.find((f) => f.name === active) ?? FRAMEWORKS[0]!;
  return (
    <div className="space-y-2">
      <Pills label="Framework" value={active} onChange={setActive} options={FRAMEWORKS.map((f) => ({ id: f.name, label: f.name }))} />
      <CodeBlock title={framework.title} code={framework.code} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keys

function Keys({ local }: { local: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const revoke = useMutation({ mutationFn: api.revokeKey, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["keys"] }) });
  if (!keys.data?.keys.length) return null;
  return (
    <Card className="p-5">
      <Section title="Lucid keys" hint={local ? "Only needed by agents on other machines." : "Every sender uses one. Revoke a key to cut it off."}>
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {keys.data.keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2">
              <Server className="size-3.5 shrink-0 text-zinc-400" />
              <code className="font-mono text-xs">{k.prefix}…</code>
              <span className="flex-1 truncate text-zinc-500">{k.name}</span>
              <span className="text-xs text-zinc-400">{k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : "never used"}</span>
              <button type="button" onClick={() => revoke.mutate(k.id)} className="text-xs text-rose-600 hover:underline">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </Card>
  );
}
