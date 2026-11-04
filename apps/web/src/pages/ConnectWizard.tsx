// The connect wizard: pick your agent by its logo, pick the AI it calls when
// that matters, then copy one message while Lucid listens for the first run.
// A ready-made agent gets the message itself and connects itself; someone's
// own agent is set up by the coding agent working on its project. Either way
// it runs Lucid's one command and the person clicks Approve, so no key goes
// through a chat. The snippets to do it by hand are under "Do it yourself".

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Braces, Check, ChevronDown, Copy, KeyRound, Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { type ConnectStatus, api } from "../api";
import { BRANDS, type Brand, BrandMark } from "../landing/logos";
import { cx } from "../ui";

/** device: one command plus a click on Approve (connect.sh / connect.ps1). */
type Method = "device" | "proxy" | "otel";
/** Ready-made agents people install and chat with, or an agent someone built (their code is what's connected). */
type Group = "agent" | "own";
export type AgentChoice = {
  id: string;
  name: string;
  brand?: Brand;
  method: Method;
  group?: Group;
  /** Set by an older link that named the AI itself (?agent=openai), so there's no "which AI" step. */
  provider?: string;
  /** Shown but not pickable yet; says why. */
  soon?: string;
};

/** An agent built without a framework: its code calls an AI provider itself. */
const PLAIN_CODE: AgentChoice = { id: "custom", name: "Plain code", method: "proxy", group: "own" };

/** Each agent goes the simplest way that captures it today. */
const AGENT_CHOICES: AgentChoice[] = [
  { id: "claude-code", name: "Claude Code", brand: BRANDS.claudeCode, method: "device", group: "agent" },
  { id: "hermes", name: "Hermes Agent", brand: BRANDS.hermes, method: "device", group: "agent" },
  { id: "openclaw", name: "OpenClaw", brand: BRANDS.openclaw, method: "proxy", group: "agent" },
  // All run on their maker's own computers, which don't let anyone else see the runs yet.
  { id: "grok-bot", name: "Grok Bot", brand: BRANDS.grokbot, method: "proxy", group: "agent", soon: "Grok Bot runs on xAI's computers, which don't share its runs yet." },
  { id: "muse", name: "Muse", brand: BRANDS.muse, method: "proxy", group: "agent", soon: "Muse runs on Meta's computers, which don't share its runs yet." },
  { id: "dots", name: "OpenAI Dots", brand: BRANDS.dots, method: "proxy", group: "agent", soon: "Dots run on OpenAI's computers, which don't share their runs yet." },
  // Built with a framework: it calls the AI underneath, so the proxy, after "which AI".
  { id: "langgraph", name: "LangGraph", brand: BRANDS.langgraph, method: "proxy", group: "own" },
  { id: "langchain", name: "LangChain", brand: BRANDS.langchain, method: "proxy", group: "own" },
  { id: "crewai", name: "CrewAI", brand: BRANDS.crewai, method: "proxy", group: "own" },
  { id: "pydantic-ai", name: "Pydantic AI", brand: BRANDS.pydanticai, method: "proxy", group: "own" },
  // Both call OpenAI's Responses API, which the proxy doesn't record, so they use tracing.
  { id: "openai-agents", name: "OpenAI Agents SDK", brand: BRANDS.openai, method: "otel", group: "own" },
  { id: "vercel-ai", name: "Vercel AI SDK", brand: BRANDS.vercel, method: "otel", group: "own" },
  PLAIN_CODE,
];

const GROUPS: { id: Group; label: string; hint: string }[] = [
  { id: "agent", label: "Ready-made agents", hint: "Agents you install and chat with." },
  { id: "own", label: "Your own agent", hint: "An agent you or your team built. What did you build it with?" },
];

/** Goes through the proxy without knowing which AI yet. */
const asksProvider = (agent: AgentChoice) => agent.method === "proxy" && !agent.provider;
const OTEL_CHOICE: AgentChoice = { id: "otel", name: "OpenTelemetry", brand: BRANDS.otel, method: "otel", group: "own" };

/** What connects today, for the landing page: every agent here that isn't "soon", then OpenTelemetry. */
export const CONNECTS_TODAY: Brand[] = [...AGENT_CHOICES, OTEL_CHOICE].flatMap((agent) => (agent.brand && !agent.soon ? [{ ...agent.brand, name: agent.name }] : []));
/** Someone's own agent, with no name of its own: plain code, or anything sending OpenTelemetry. */
const unnamed = (agent: AgentChoice) => agent.id === "custom" || agent.id === "otel";

/** For /connect?agent=…, including the older method names (proxy, otel) and AI names. */
export function findAgent(id: string | null) {
  if (id === "proxy") return PLAIN_CODE;
  if (id === "otel") return OTEL_CHOICE;
  if (id && id in PROVIDERS) return { ...PLAIN_CODE, provider: id };
  return AGENT_CHOICES.find((agent) => agent.id === id && !agent.soon) ?? null;
}

/** Where agents send, and the key that goes with it. */
type Target = {
  endpoint: string;
  /** Sending from this machine to a local Lucid: no key needed. */
  keyless: boolean;
  key: string;
  /** Lucid listens on this computer only, so other machines cannot reach it. */
  loopback: boolean;
  local: boolean;
};

function toTarget(status: ConnectStatus, key: string | null): Target {
  return {
    endpoint: status.endpoint,
    keyless: status.localMode && !key,
    key: key ?? "<your-lucid-key>",
    loopback: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(status.endpoint),
    local: status.localMode,
  };
}

/** Keys are named after the agent they were made for, so the key list reads like a list of agents. */
const keyName = (agent: AgentChoice) => (unnamed(agent) ? "My agent" : agent.name);

/** Changes whenever anything new arrives. */
const fingerprint = (status: ConnectStatus) =>
  `${status.runs}|${status.sources.reduce((sum, source) => sum + source.events, 0)}|${status.sources.reduce((latest, source) => (source.lastAt && source.lastAt > latest ? source.lastAt : latest), "")}`;

type Step = "agent" | "provider" | "setup" | "done";

export function ConnectWizard({
  open,
  onClose,
  initialAgent,
  newKey,
  onKey,
}: {
  open: boolean;
  onClose: () => void;
  initialAgent: AgentChoice | null;
  /** A key made earlier on this page, reused rather than making another. */
  newKey: string | null;
  onKey: (key: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  // The page behind stays put while the dialog scrolls.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Connect an agent"
      onClose={onClose}
      // A click on the dialog itself, not its content, is a click on the backdrop.
      onClick={(event) => event.target === event.currentTarget && ref.current?.close()}
      // Anchored near the top, so a taller step grows downward instead of jumping.
      className="mx-auto mt-[max(0.75rem,8dvh)] max-h-[calc(100dvh-max(0.75rem,8dvh)-0.75rem)] w-[calc(100%-1.5rem)] max-w-2xl overflow-hidden rounded-3xl bg-white p-0 text-zinc-900 shadow-2xl shadow-zinc-900/10 ring-1 ring-black/5 backdrop:bg-zinc-900/40 backdrop:backdrop-blur-sm open:motion-safe:animate-[rise_.25s_ease-out] dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10 dark:backdrop:bg-zinc-950/70"
    >
      {open && <Wizard initialAgent={initialAgent} newKey={newKey} onKey={onKey} close={() => ref.current?.close()} />}
    </dialog>
  );
}

function Wizard({ initialAgent, newKey, onKey, close }: { initialAgent: AgentChoice | null; newKey: string | null; onKey: (key: string) => void; close: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [agent, setAgent] = useState(initialAgent);
  const [provider, setProvider] = useState<string | null>(initialAgent?.provider ?? null);
  const [step, setStep] = useState<Step>(initialAgent ? (asksProvider(initialAgent) ? "provider" : "setup") : "agent");
  const status = useQuery({ queryKey: ["connect"], queryFn: api.connect, refetchInterval: step === "setup" ? 2_000 : false });

  // What had arrived when the setup was shown, so only something new counts.
  const baseline = useRef<string | null>(null);
  const now = status.data ? fingerprint(status.data) : null;
  if (step === "agent" || step === "provider" || baseline.current === null) baseline.current = now;
  const arrived = step === "setup" && now !== null && baseline.current !== null && now !== baseline.current;
  useEffect(() => {
    if (arrived) setStep("done");
  }, [arrived]);

  // The message's command gets its key when you approve. Doing it by hand needs
  // one in the snippets on hosted Lucid: made when that section is opened.
  const createKey = useMutation({
    mutationFn: (name: string) => api.createKey(name),
    onSuccess: (created) => {
      onKey(created.key);
      void queryClient.invalidateQueries({ queryKey: ["keys"] });
    },
  });
  const ensureKey = () => {
    if (agent && status.data && !status.data.localMode && !newKey && createKey.isIdle) createKey.mutate(keyName(agent));
  };

  const flow: Step[] = agent && !asksProvider(agent) ? ["agent", "setup"] : ["agent", "provider", "setup"];
  const position = step === "done" ? flow.length : flow.indexOf(step);
  const back = step === "provider" || step === "setup" ? () => setStep(flow[flow.indexOf(step) - 1] ?? "agent") : null;

  const pickAgent = (picked: AgentChoice) => {
    setAgent(picked);
    setProvider(picked.provider ?? null);
    setStep(asksProvider(picked) ? "provider" : "setup");
  };
  const restart = () => {
    setAgent(null);
    setProvider(null);
    setStep("agent");
  };

  return (
    <div className="flex max-h-[inherit] flex-col">
      <div className="flex items-center gap-3 px-5 pt-5 sm:px-8 sm:pt-6">
        <button
          type="button"
          onClick={back ?? undefined}
          aria-label="Back"
          className={cx("-ml-1.5 rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white", !back && "invisible")}
        >
          <ArrowLeft className="size-5" />
        </button>
        <div className="flex flex-1 gap-1.5" aria-hidden>
          {flow.map((name, index) => (
            <span key={name} className={cx("h-1 flex-1 rounded-full transition-colors duration-300", index <= position ? "bg-brand-500 dark:bg-brand-300" : "bg-zinc-200 dark:bg-white/10")} />
          ))}
        </div>
        <button type="button" onClick={close} aria-label="Close" className="-mr-1.5 rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-white">
          <X className="size-5" />
        </button>
      </div>

      <div key={step} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 pb-7 motion-safe:animate-[rise_.3s_ease-out] sm:px-8 sm:pb-8">
        {step === "agent" && <AgentStep onPick={pickAgent} />}
        {step === "provider" && agent && (
          <ProviderStep
            agent={agent}
            providers={status.data?.providers ?? Object.keys(PROVIDERS)}
            onPick={(picked) => {
              setProvider(picked);
              setStep("setup");
            }}
          />
        )}
        {step === "setup" && agent && (
          <SetupStep
            agent={agent}
            provider={provider ?? "openai"}
            status={status.data}
            newKey={newKey}
            keyState={createKey}
            onManual={ensureKey}
            onRetryKey={() => createKey.mutate(keyName(agent))}
            onUseOtel={() => setAgent({ ...agent, method: "otel" })}
          />
        )}
        {step === "done" && agent && (
          <Done
            agent={agent}
            own={agent.group === "own"}
            first={(status.data?.runs ?? 0) > 0 && baseline.current?.startsWith("0|") === true}
            onSee={() => {
              close();
              navigate("/runs");
            }}
            onAnother={restart}
          />
        )}
      </div>

      {step === "setup" && (
        <div className="flex items-center gap-3 border-t border-zinc-200 bg-zinc-50 px-5 py-3.5 sm:px-8 dark:border-white/10 dark:bg-white/[0.03]">
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-amber-400" />
          </span>
          <p className="min-w-0 flex-1 text-sm text-zinc-600 dark:text-zinc-300">Waiting for your agent… this changes as soon as it runs.</p>
          <button type="button" onClick={close} className="shrink-0 text-sm font-medium text-zinc-500 transition hover:text-zinc-900 dark:hover:text-white">
            Finish later
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps

function Heading({ title, sub }: { title: string; sub?: ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-[1.75rem]">{title}</h2>
      {sub && <p className="mt-1.5 text-zinc-500 dark:text-zinc-400">{sub}</p>}
    </div>
  );
}

/** A logo on a small tile, light or dark with the theme; one-color logos take the text color. */
export function LogoWell({ children, size = "size-12 rounded-xl", className }: { children: ReactNode; size?: string; className?: string }) {
  return (
    <span className={cx("flex shrink-0 items-center justify-center bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-800 dark:text-white dark:ring-white/10", size, className)}>
      {children}
    </span>
  );
}

function AgentMark({ agent, className = "size-7" }: { agent: AgentChoice; className?: string }) {
  return agent.brand ? <BrandMark brand={agent.brand} className={className} /> : <Braces className={cx("text-zinc-500 dark:text-zinc-400", className)} strokeWidth={1.75} />;
}

/** `soon`: shown greyed with a "Coming soon" tag, and says why on hover. */
function Tile({ label, onClick, small, soon, children }: { label: string; onClick: () => void; small?: boolean; soon?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={soon ? undefined : onClick}
      aria-disabled={soon ? true : undefined}
      title={soon}
      className={cx(
        "group flex flex-col items-center justify-center rounded-2xl text-center ring-1 ring-zinc-200 transition focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:outline-none dark:ring-white/10 dark:focus-visible:ring-brand-300",
        soon ? "cursor-default" : "hover:-translate-y-0.5 hover:bg-zinc-50 hover:ring-zinc-300 dark:hover:bg-white/[0.04] dark:hover:ring-white/25",
        small ? "gap-2 px-1.5 py-3" : "gap-3 px-2 py-4 sm:py-5",
      )}
    >
      <LogoWell size={small ? "size-10 rounded-lg" : "size-12 rounded-xl"} className={cx("transition", soon ? "opacity-50 grayscale" : "group-hover:shadow-md")}>
        {children}
      </LogoWell>
      <span className={cx("leading-tight font-medium", small ? "text-xs" : "text-sm", soon && "text-zinc-400 dark:text-zinc-500")}>{label}</span>
      {soon && <span className="-mt-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium whitespace-nowrap text-zinc-500 dark:bg-white/10 dark:text-zinc-400">Coming soon</span>}
    </button>
  );
}

function AgentStep({ onPick }: { onPick: (agent: AgentChoice) => void }) {
  const [group, setGroup] = useState<Group>("agent");
  return (
    <>
      <Heading title="Which agent do you want to watch?" sub="Pick one. You can connect more later." />
      <div className="mt-6">
        <Segmented label="Kind of agent" value={group} onChange={setGroup} options={GROUPS.map(({ id, label }) => ({ id, label }))} />
      </div>
      <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">{GROUPS.find((g) => g.id === group)?.hint}</p>
      <div key={group} className="mt-3 grid auto-rows-fr grid-cols-3 gap-2 motion-safe:animate-[rise_.25s_ease-out] sm:gap-3">
        {AGENT_CHOICES.filter((agent) => agent.group === group).map((agent) => (
          <Tile key={agent.id} label={agent.name} soon={agent.soon} onClick={() => onPick(agent)}>
            <AgentMark agent={agent} />
          </Tile>
        ))}
      </div>
      <p className="mt-5 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Already send OpenTelemetry?{" "}
        <button type="button" onClick={() => onPick(OTEL_CHOICE)} className="font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-900 dark:text-white dark:decoration-zinc-600 dark:hover:decoration-white">
          Use that
        </button>
      </p>
    </>
  );
}

function ProviderStep({ agent, providers, onPick }: { agent: AgentChoice; providers: string[]; onPick: (provider: string) => void }) {
  return (
    <>
      <Heading
        title={agent.id === "custom" ? "Which AI does your agent call?" : agent.group === "agent" ? `Which AI does ${agent.name} use?` : `Which AI does your ${agent.name} agent call?`}
        sub="The company whose API key it has."
      />
      <div className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-5">
        {[...providers].sort((a, b) => providerRank(a) - providerRank(b)).map((id) => {
          const known = PROVIDERS[id];
          return (
            <Tile key={id} small label={known?.label ?? id} onClick={() => onPick(id)}>
              {known ? <BrandMark brand={known.brand} className="size-6" /> : <span className="font-display text-lg font-bold uppercase">{id[0]}</span>}
            </Tile>
          );
        })}
      </div>
    </>
  );
}

type KeyState = { isPending: boolean; isError: boolean; error: Error | null };

function SetupStep({
  agent,
  provider,
  status,
  newKey,
  keyState,
  onManual,
  onRetryKey,
  onUseOtel,
}: {
  agent: AgentChoice;
  provider: string;
  status: ConnectStatus | undefined;
  newKey: string | null;
  keyState: KeyState;
  /** "Do it yourself" was opened: its snippets need a key. */
  onManual: () => void;
  onRetryKey: () => void;
  onUseOtel: () => void;
}) {
  if (!status) return <Loader2 className="mx-auto my-16 size-5 animate-spin text-zinc-400" aria-label="Loading" />;
  const target = toTarget(status, newKey);
  const via = asksProvider(agent) || agent.provider ? PROVIDERS[provider] : undefined;
  const own = agent.group === "own";
  const title = own ? (unnamed(agent) ? "Connect your agent" : `Connect your ${agent.name} agent`) : `Connect ${agent.name}`;
  // What "Do it yourself" shows first: the key it put in the snippets, unless this Lucid needs none.
  const keyNote = !target.keyless && <KeyNote created={!!newKey} state={keyState} onRetry={onRetryKey} />;
  return (
    <>
      <div className="flex items-center gap-4">
        <div className="relative">
          <LogoWell size="size-14 rounded-2xl">
            <AgentMark agent={agent} className="size-8" />
          </LogoWell>
          {via && (
            <LogoWell size="size-7 rounded-lg" className="absolute -right-2 -bottom-2">
              <BrandMark brand={via.brand} className="size-4" />
            </LogoWell>
          )}
        </div>
        <Heading title={title} sub={own ? "Your coding agent sets it up. You click Approve." : "Send it one message, then click Approve. No keys to copy."} />
      </div>

      {agent.method === "device" && <DeviceSetup target={target} agent={agent} />}
      {agent.id === "openclaw" && <OpenClawSetup target={target} provider={provider} keyNote={keyNote} onManual={onManual} />}
      {own && <OwnAgentSetup target={target} agent={agent} provider={provider} keyNote={keyNote} onManual={onManual} onUseOtel={onUseOtel} />}
    </>
  );
}

function KeyNote({ created, state, onRetry }: { created: boolean; state: KeyState; onRetry: () => void }) {
  if (state.isError) {
    return (
      <Callout tone="warn">
        Couldn't make your Lucid key: {state.error?.message}.{" "}
        <button type="button" onClick={onRetry} className="font-semibold underline">
          Try again
        </button>
      </Callout>
    );
  }
  return (
    <p className="mt-6 flex items-center gap-2.5 rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm text-brand-900 ring-1 ring-brand-200 dark:bg-brand-300/10 dark:text-brand-100 dark:ring-brand-300/20">
      {created ? <KeyRound className="size-4 shrink-0" /> : <Loader2 className="size-4 shrink-0 animate-spin" />}
      {created ? "We made you a Lucid key and put it in the code below. It's shown only once." : "Making your Lucid key…"}
    </p>
  );
}

function Callout({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  return (
    <p
      className={cx(
        "mt-6 flex gap-2.5 rounded-xl px-3.5 py-2.5 text-sm",
        tone === "warn" ? "bg-amber-50 text-amber-900 ring-1 ring-amber-200 dark:bg-amber-400/10 dark:text-amber-200 dark:ring-amber-400/20" : "bg-zinc-50 text-zinc-600 dark:bg-white/5 dark:text-zinc-300",
      )}
    >
      {tone === "warn" && <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

function Done({ agent, own, first, onSee, onAnother }: { agent: AgentChoice; own: boolean; first: boolean; onSee: () => void; onAnother: () => void }) {
  return (
    <div className="flex flex-col items-center py-6 text-center sm:py-10">
      <div className="relative">
        <span className="relative flex size-20 items-center justify-center rounded-full bg-brand-300 text-zinc-950 ring-8 ring-brand-300/25 motion-safe:animate-[rise_.4s_ease-out]">
          <Check className="size-10" strokeWidth={2.5} />
        </span>
        <LogoWell size="size-9 rounded-xl" className="absolute -right-3 -bottom-2">
          <AgentMark agent={agent} className="size-5" />
        </LogoWell>
      </div>
      <h2 className="mt-8 font-display text-3xl font-bold tracking-tight">You're connected</h2>
      <p className="mt-2 max-w-sm text-zinc-500 dark:text-zinc-400">
        {first ? "Your first run just arrived. From now on, every run shows up in Lucid on its own." : "New data just arrived. Every run from now on shows up in Lucid on its own."}
      </p>
      {own && (
        <p className="mt-4 max-w-sm rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:bg-white/5 dark:text-zinc-300">
          Runs on a server too? Add the Lucid settings from the project's <Mono>.env</Mono> to the server's environment settings, then redeploy.
        </p>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={onSee}
          className="group inline-flex items-center gap-2 rounded-full bg-brand-300 px-5 py-2.5 text-sm font-semibold text-zinc-950 ring-1 ring-black/5 ring-inset transition hover:bg-brand-200"
        >
          See your runs
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </button>
        <button type="button" onClick={onAnother} className="rounded-full px-5 py-2.5 text-sm font-semibold ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:ring-white/15 dark:hover:bg-white/5">
          Connect another
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setup building blocks

function Instructions({ children }: { children: ReactNode }) {
  return <ol className="mt-7 space-y-6">{children}</ol>;
}

function Instruction({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="space-y-3">
      <div className="flex items-center gap-3.5 font-semibold">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-bold text-white dark:bg-brand-300 dark:text-zinc-950">{n}</span>
        {title}
      </div>
      {/* Indented under the title on wider screens; full width on phones, where code needs the room. */}
      {children && <div className="space-y-3 sm:pl-[2.625rem]">{children}</div>}
    </li>
  );
}

/** A terminal-style block with one big copy button. Dark in both themes. */
function Snippet({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl bg-zinc-950 ring-1 ring-zinc-900 dark:ring-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 py-1.5 pr-1.5 pl-3.5">
        <span className="truncate text-xs text-zinc-400">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition",
            copied ? "bg-emerald-400 text-zinc-950" : "bg-brand-300 text-zinc-950 hover:bg-brand-200",
          )}
        >
          {copied ? <Check className="size-3.5" /> : null}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Wrapped, not scrolled sideways: the key at the end of a long line has to be seen to be trusted. */}
      <pre className="p-3.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-100 [overflow-wrap:anywhere]">{code}</pre>
    </div>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (id: T) => void }) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-1 rounded-2xl bg-zinc-100 p-1 dark:bg-white/5" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={option.id === value}
          onClick={() => onChange(option.id)}
          className={cx(
            "rounded-xl px-3 py-1.5 text-sm font-medium transition",
            option.id === value ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white" : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Fine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-zinc-500 dark:text-zinc-400">{children}</p>;
}

const Mono = ({ children }: { children: ReactNode }) => <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-white/10">{children}</code>;

/** A section folded away; `onOpen` runs when someone unfolds it. */
function More({ title, onOpen, children }: { title: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <details className="group mt-6 rounded-xl ring-1 ring-zinc-200 dark:ring-white/10" onToggle={(event) => event.currentTarget.open && onOpen?.()}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-4 transition group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-zinc-200 px-4 py-4 dark:border-white/10">{children}</div>
    </details>
  );
}

/** Only when an agent on another machine has to reach a Lucid that listens on this one. */
const LoopbackWarning = ({ target }: { target: Target }) =>
  target.loopback ? (
    <Callout tone="warn">
      This Lucid listens on this computer only ({target.endpoint}), so a server or container elsewhere can't reach it. Use hosted Lucid for those, or run this one with <Mono>HOST=0.0.0.0</Mono> behind HTTPS and set{" "}
      <Mono>LUCID_PUBLIC_URL</Mono>.
    </Callout>
  ) : null;

const lines = (...parts: (string | false)[]) =>
  parts
    .filter(Boolean)
    .map((line) => (line as string).trim())
    .join("\n");

/** A message to paste into an agent, so it does the setup. `inStep`: inside an Instruction, which spaces it already. */
function AskAgent({ title, sub, prompt, note, inStep }: { title: string; sub: string; prompt: string; note?: string; inStep?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx(!inStep && "mt-6", "rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-white/[0.03] dark:ring-white/10")}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-300 text-zinc-950">
          <Sparkles className="size-5" />
        </span>
        <div className="min-w-0 flex-1 basis-48">
          <div className="font-semibold">{title}</div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">{sub}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(prompt).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
          className={cx(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition",
            copied ? "bg-emerald-500 text-white" : "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
          )}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy message"}
        </button>
      </div>
      <details className="group mt-3">
        <summary className="cursor-pointer list-none text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show the message</span>
          <span className="hidden group-open:inline">Hide the message</span>
        </summary>
        <pre className="mt-2 rounded-xl bg-white p-3 font-sans text-xs leading-relaxed whitespace-pre-wrap text-zinc-600 ring-1 ring-zinc-200 [overflow-wrap:anywhere] dark:bg-zinc-950 dark:text-zinc-300 dark:ring-white/10">{prompt}</pre>
      </details>
      {note && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lucid's one command, then Approve: Claude Code and Hermes by default, or
// what a setup link asks for (?for=project, tracing or openclaw; see connect.sh)

type Os = "mac" | "windows" | "linux";

function detectOs(): Os {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = (nav.userAgentData?.platform || nav.platform || nav.userAgent).toLowerCase();
  return platform.includes("win") ? "windows" : platform.includes("mac") ? "mac" : "linux";
}

/** `setup`: the link's query, when it sets up something other than Claude Code and Hermes. Quoted then, for the "&". */
const connectCommand = (target: Target, os: Os, setup = "") => {
  const url = (file: string) => (setup ? `"${target.endpoint}/${file}?${setup}"` : `${target.endpoint}/${file}`);
  return os === "windows" ? `irm ${url("connect.ps1")} | iex` : `curl -fsSL ${url("connect.sh")} | sh`;
};

/** The command for both kinds of computer, as a message gives it. */
const bothCommands = (target: Target, setup = "") =>
  `macOS or Linux: ${connectCommand(target, "mac", setup)}\n   Windows (PowerShell): ${connectCommand(target, "windows", setup)}`;

function devicePrompt(target: Target) {
  return `Connect yourself to Lucid, an observability tool, so I can see your runs.

1. Run this in a terminal on this computer:
   ${bothCommands(target)}
   It waits up to 10 minutes for my approval, so run it in the background if your terminal tool has a time limit.
2. It prints a link and a code. Show me both right away so I can click Approve.
3. When it finishes, tell me what it connected and that I need to restart you.`;
}

/** For a Hermes on a server: sent from wherever the owner chats with it, it runs the command where Hermes lives. */
function cloudPrompt(target: Target) {
  return `Connect yourself to Lucid, an observability tool, so I can see your runs.

1. Run this with your terminal tool:
   ${connectCommand(target, "linux")}
   It waits up to 10 minutes for my approval, so run it in the background and keep reading its output.
   If your terminal runs in a separate sandbox rather than where you yourself run, stop and tell me instead.
2. As soon as it prints a link and a code, send me both so I can tap Approve.
3. When it says it's done, tell me what it connected and that I should send /restart.`;
}

type Where = "here" | "cloud";

function DeviceSetup({ target, agent }: { target: Target; agent: AgentChoice }) {
  const [where, setWhere] = useState<Where>("here");
  const hermes = agent.id === "hermes";
  return (
    <>
      {hermes && (
        <div className="mt-7 space-y-3">
          <p className="font-semibold">Where does Hermes run?</p>
          <Segmented
            label="Where Hermes runs"
            value={where}
            onChange={setWhere}
            options={[
              { id: "here", label: "This computer" },
              { id: "cloud", label: "Server or cloud" },
            ]}
          />
        </div>
      )}
      {hermes && where === "cloud" ? <CloudHermesSetup target={target} /> : <LocalSetup target={target} hermes={hermes} />}
    </>
  );
}

/** No terminal: the owner asks Hermes in chat, and Hermes runs the command on its own server. */
function CloudHermesSetup({ target }: { target: Target }) {
  return (
    <>
      <Instructions>
        <Instruction n={1} title="Send this message to Hermes">
          <Fine>In Telegram, Discord, Slack or its web dashboard: wherever you chat with it. Hermes runs one command on its own server.</Fine>
          <AskAgent title="Message for Hermes" sub="Copy it, then paste it into your chat with Hermes." prompt={cloudPrompt(target)} inStep />
        </Instruction>
        <Instruction n={2} title="Tap Approve on the link Hermes sends back">
          <Fine>It opens here on any device where you're signed in. Check that the code matches the one in Hermes' reply.</Fine>
        </Instruction>
        <Instruction n={3} title="Send /restart to Hermes">
          <Fine>Every chat shows up here from then on. Want older ones too? Choose that when you approve.</Fine>
        </Instruction>
      </Instructions>
      <More title="Rather use the server's terminal?">
        <Fine>Run this where Hermes runs, open the link it prints, then restart Hermes.</Fine>
        <Snippet label="Terminal" code={connectCommand(target, "linux")} />
        <Fine>Hermes in Docker: run it inside the container instead. Replace the name with your container's.</Fine>
        <Snippet label="Docker host" code={`docker exec -it hermes sh -c "${connectCommand(target, "linux")}"\ndocker restart hermes`} />
      </More>
      <WhatChanges />
      <LoopbackWarning target={target} />
    </>
  );
}

function LocalSetup({ target, hermes }: { target: Target; hermes: boolean }) {
  const [os, setOs] = useState<Os>(detectOs);
  const short = hermes ? "Hermes" : "Claude Code";
  return (
    <>
      <Instructions>
        <Instruction n={1} title={`Send this message to ${short}`}>
          <Fine>{hermes ? "In a chat with Hermes on this computer." : "In any Claude Code session on this computer."} It runs one command and shows you a link.</Fine>
          <AskAgent title={`Message for ${short}`} sub={`Copy it, then paste it into ${short}.`} prompt={devicePrompt(target)} inStep />
        </Instruction>
        <Instruction n={2} title="Click Approve on the link it shows you">
          <Fine>Check that the code on the page matches the one in its reply.</Fine>
        </Instruction>
        <Instruction n={3} title={hermes ? "Restart Hermes" : "Start a new Claude Code session"}>
          <Fine>{hermes ? "Every chat shows up here from then on." : "Every session shows up here as it happens."} Want older ones too? Choose that when you approve.</Fine>
        </Instruction>
      </Instructions>
      <More title="Rather run the command yourself?">
        <Fine>If {short} won't run it, this does the same. Then click Approve on the page it opens.</Fine>
        <Segmented
          label="Computer"
          value={os}
          onChange={setOs}
          options={[
            { id: "mac", label: "Mac" },
            { id: "windows", label: "Windows" },
            { id: "linux", label: hermes ? "Linux" : "Linux or a server" },
          ]}
        />
        <Snippet label={os === "windows" ? "PowerShell" : "Terminal"} code={connectCommand(target, os)} />
        {os === "linux" && <Fine>On a server, open the link it prints on any device where you're signed in.</Fine>}
      </More>
      <WhatChanges />
      {os === "linux" && <LoopbackWarning target={target} />}
    </>
  );
}

const WhatChanges = () => (
  <More title="What this changes">
    <Fine>
      The command looks for Claude Code and Hermes Agent on that computer and connects each one it finds, after you approve. Claude Code gets hooks in <Mono>~/.claude/settings.json</Mono> (a backup is kept) and a small
      helper in <Mono>~/.lucid</Mono>; it needs Node.js 18 or newer. Hermes gets the Lucid plugin in its <Mono>plugins</Mono> folder and three <Mono>LUCID_</Mono> settings in its <Mono>.env</Mono>. Run it again any time to
      update.
    </Fine>
  </More>
);

// ---------------------------------------------------------------------------
// Any agent, through the LLM proxy

/** `base`: what goes after the provider to make the base URL its own SDK expects. */
const PROVIDERS: Record<string, { label: string; brand: Brand; base: string; keyVar: string; model: string; anthropic?: boolean; /** Whose API key it is, when not the label's. */ company?: string }> = {
  // Meta's Muse Spark first: on Meta's own Model API, then served by Baseten.
  meta: { label: "Muse Spark", company: "Meta", brand: BRANDS.meta, base: "/v1", keyVar: "META_API_KEY", model: "muse-spark-1.3" },
  baseten: { label: "Muse Spark (Baseten)", company: "Baseten", brand: BRANDS.meta, base: "/v1", keyVar: "BASETEN_API_KEY", model: "meta-models/muse-spark-open-1026" },
  openai: { label: "OpenAI", brand: BRANDS.openai, base: "/v1", keyVar: "OPENAI_API_KEY", model: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", brand: BRANDS.anthropic, base: "", keyVar: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5", anthropic: true },
  openrouter: { label: "OpenRouter", brand: BRANDS.openrouter, base: "/v1", keyVar: "OPENROUTER_API_KEY", model: "openai/gpt-4o-mini" },
  gemini: { label: "Gemini", brand: BRANDS.gemini, base: "", keyVar: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
  groq: { label: "Groq", brand: BRANDS.groq, base: "/v1", keyVar: "GROQ_API_KEY", model: "llama-3.3-70b-versatile" },
  deepseek: { label: "DeepSeek", brand: BRANDS.deepseek, base: "/v1", keyVar: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  mistral: { label: "Mistral", brand: BRANDS.mistral, base: "/v1", keyVar: "MISTRAL_API_KEY", model: "mistral-small-latest" },
  xai: { label: "xAI", brand: BRANDS.xai, base: "/v1", keyVar: "XAI_API_KEY", model: "grok-3-mini" },
  together: { label: "Together", brand: BRANDS.together, base: "/v1", keyVar: "TOGETHER_API_KEY", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  fireworks: { label: "Fireworks", brand: BRANDS.fireworks, base: "/v1", keyVar: "FIREWORKS_API_KEY", model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
};

/** In the order above, Muse Spark first; providers a server added go last. */
const providerRank = (id: string) => {
  const at = Object.keys(PROVIDERS).indexOf(id);
  return at === -1 ? Number.MAX_SAFE_INTEGER : at;
};

type Lang = "env" | "python" | "typescript" | "curl";

function proxyBase(target: Target, provider: string) {
  const prefix = target.keyless ? `${target.endpoint}/proxy` : `${target.endpoint}/p/${target.key}`;
  return `${prefix}/${provider}${PROVIDERS[provider]?.base ?? ""}`;
}

function proxySnippet(lang: Lang, provider: string, base: string) {
  const p = PROVIDERS[provider] ?? { label: provider, base: "", keyVar: "API_KEY", model: "<model>" };
  if ("anthropic" in p && p.anthropic) {
    if (lang === "env") return `ANTHROPIC_BASE_URL=${base}`;
    if (lang === "python") return `from anthropic import Anthropic\n\nclient = Anthropic(base_url="${base}")  # still reads ${p.keyVar}`;
    if (lang === "typescript") return `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({ baseURL: "${base}" }); // still reads ${p.keyVar}`;
    return `curl ${base}/v1/messages \\\n  -H "x-api-key: $${p.keyVar}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "content-type: application/json" \\\n  -d '{"model": "${p.model}", "max_tokens": 256, "messages": [{"role": "user", "content": "Hello"}]}'`;
  }
  if (lang === "env") return provider === "openai" ? `OPENAI_BASE_URL=${base}` : `OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=<your ${"company" in p && p.company ? p.company : p.label} key>`;
  if (lang === "python") return `import os\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}",\n    api_key=os.environ["${p.keyVar}"],  # your ${"company" in p && p.company ? p.company : p.label} key, as before\n)`;
  if (lang === "typescript") return `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${base}",\n  apiKey: process.env.${p.keyVar}, // your ${"company" in p && p.company ? p.company : p.label} key, as before\n});`;
  return `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $${p.keyVar}" \\\n  -H "content-type: application/json" \\\n  -d '{"model": "${p.model}", "messages": [{"role": "user", "content": "Hello"}]}'`;
}

const LANG_TITLES: Record<Lang, string> = {
  env: "Add this to your agent's .env file",
  python: "Point your client at Lucid",
  typescript: "Point your client at Lucid",
  curl: "Or try it right now in a terminal",
};

const LABEL_HEADERS: { name: string; what: string }[] = [
  { name: "x-lucid-agent", what: "The agent's name, shown on every run." },
  { name: "x-lucid-session", what: "Groups calls into one conversation." },
  { name: "x-lucid-run", what: "Groups calls into one task." },
  { name: "x-lucid-user", what: "Your end user's id, to find their runs later." },
];

/** The setting the command adds to a project's .env (install.ts baseVariable): the OpenAI and Anthropic SDKs read theirs by themselves. */
const baseVariable = (provider: string) => (provider === "openai" ? "OPENAI_BASE_URL" : provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "LUCID_BASE_URL");

const indented = (text: string) => text.replace(/^/gm, "   ");

/**
 * For the coding agent working on someone's own agent: run the command in its
 * project, get it approved, then make the code use the settings it adds. On a
 * server too, where it can; otherwise it says what to add where.
 */
function projectPrompt(target: Target, agent: AgentChoice, provider: string) {
  const tracing = agent.method === "otel";
  const p = PROVIDERS[provider];
  const label = p?.label ?? provider;
  const company = p?.company ?? label;
  const variable = baseVariable(provider);
  const sdk = provider === "openai" ? "OpenAI" : provider === "anthropic" ? "Anthropic" : null;
  const use = tracing
    ? `It then adds OpenTelemetry settings (OTEL_EXPORTER_OTLP_...) to this project's .env, with my Lucid key in them. Make sure the app loads .env when it starts, and turn on tracing:\n${indented(OTEL_CODE[agent.id]?.code ?? "Send OpenTelemetry traces with an OTLP exporter, which reads those settings.")}`
    : `It then adds ${variable} to this project's .env: Lucid's address for ${label}, with my Lucid key in it. Make sure every ${label} client in the project${unnamed(agent) ? "" : `, including the ones ${agent.name} makes,`} uses it as its base URL. ${
        sdk ? `The ${sdk} SDK reads ${variable} by itself, so only code that sets base_url or baseURL by hand needs changing.` : "Pass it as the client's base_url (Python) or baseURL (TypeScript)."
      } Keep the ${company} API key exactly as it is.`;
  return `Connect this project's AI agent to Lucid, an observability tool, so I can see its runs.

1. In this project's folder, run:
   ${bothCommands(target, tracing ? "for=tracing" : `for=project&ai=${provider}`)}
   It waits up to 10 minutes for my approval, so run it in the background if your terminal tool has a time limit.
2. It prints a link and a code. Show me both right away so I can click Approve.
3. ${use} Change nothing else, and don't show me the values.
4. If the agent also runs on a server (Vercel, Render, Railway, Fly or a VPS), add the same settings to its environment there, with the host's command-line tool if it's installed and signed in, then redeploy. Otherwise, tell me exactly which settings to add where.
5. Tell me what you changed and how to run the agent once.`;
}

/** Someone's own agent: their coding agent sets it up from one message. The snippets are under "Do it yourself". */
function OwnAgentSetup({
  target,
  agent,
  provider,
  keyNote,
  onManual,
  onUseOtel,
}: {
  target: Target;
  agent: AgentChoice;
  provider: string;
  keyNote: ReactNode;
  onManual: () => void;
  onUseOtel: () => void;
}) {
  const tracing = agent.method === "otel";
  const p = PROVIDERS[provider];
  const company = p?.company ?? p?.label ?? provider;
  return (
    <>
      <Instructions>
        <Instruction n={1} title="Send this message to your coding agent">
          <Fine>Claude Code, Cursor, Codex or another, opened in your agent's project. It runs one command there and points the code at Lucid.</Fine>
          <AskAgent title="Message for your coding agent" sub="Copy it, then paste it into your coding agent." prompt={projectPrompt(target, agent, provider)} inStep />
        </Instruction>
        <Instruction n={2} title="Click Approve on the link it shows you">
          <Fine>
            {tracing
              ? "Lucid's settings go into the project's .env, with your Lucid key in them. Keep .env out of git."
              : `Your ${company} key stays in your project: Lucid passes it on to ${company} and never stores it.`}
          </Fine>
        </Instruction>
        <Instruction n={3} title="Run your agent once">
          <Fine>It shows up here as soon as it runs. Runs on a server too? Your coding agent adds the same settings there, or tells you where to add them.</Fine>
        </Instruction>
      </Instructions>
      {agent.id === "langgraph" && !tracing && (
        <Callout>
          Want each step of the graph, not just the model calls?{" "}
          <button type="button" onClick={onUseOtel} className="font-semibold text-zinc-900 underline underline-offset-2 dark:text-white">
            Use OpenTelemetry instead
          </button>
        </Callout>
      )}
      <More title="Rather set it up yourself?" onOpen={onManual}>
        {keyNote}
        {tracing ? <OtelManual target={target} agent={agent} /> : <ProxyManual target={target} provider={provider} />}
      </More>
      <LoopbackNote target={target} />
    </>
  );
}

function ProxyManual({ target, provider }: { target: Target; provider: string }) {
  const [lang, setLang] = useState<Lang>("env");
  const base = proxyBase(target, provider);
  const p = PROVIDERS[provider];
  const label = p?.label ?? provider;
  const client = p?.anthropic ? "Anthropic" : "OpenAI";
  return (
    <>
      <Instructions>
        <Instruction n={1} title={LANG_TITLES[lang]}>
          <Segmented
            label="How your agent is set up"
            value={lang}
            onChange={setLang}
            options={[
              { id: "env", label: ".env file" },
              { id: "python", label: "Python" },
              { id: "typescript", label: "TypeScript" },
              { id: "curl", label: "Test with curl" },
            ]}
          />
          <Snippet label={lang === "env" ? ".env" : lang === "curl" ? "Terminal" : lang === "python" ? "Python" : "TypeScript"} code={proxySnippet(lang, provider, base)} />
          {!p && <Fine>A provider added on this server: add the path your client normally puts after the provider's address.</Fine>}
        </Instruction>
        <Instruction n={2} title={lang === "curl" ? "Watch it arrive below" : "Restart your agent and run it once"}>
          <Fine>
            Your {p?.company ?? label} key stays where it is. Lucid passes it on to {p?.company ?? label} and never stores it.
          </Fine>
        </Instruction>
      </Instructions>
      <div className="space-y-3 pt-4">
        <p className="text-sm font-semibold">Name and group your runs (optional)</p>
        <ul className="space-y-1.5 text-sm">
          {LABEL_HEADERS.map((header) => (
            <li key={header.name} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <code className="w-32 shrink-0 font-mono text-xs leading-5 text-brand-700 dark:text-brand-300">{header.name}</code>
              <span className="text-zinc-600 dark:text-zinc-400">{header.what}</span>
            </li>
          ))}
        </ul>
        <Snippet label="Python" code={`client = ${client}(\n    base_url="${base}",\n    default_headers={"x-lucid-agent": "support-bot", "x-lucid-user": user_id},\n)`} />
        <Fine>Lucid records chat and messages calls, streaming included. Other calls pass through unrecorded.</Fine>
      </div>
    </>
  );
}

const LoopbackNote = ({ target }: { target: Target }) =>
  target.loopback ? <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">Works for agents on this computer. Agents on other machines can't reach {target.endpoint}.</p> : null;

// ---------------------------------------------------------------------------
// OpenClaw: the proxy too, but set up by OpenClaw itself from a chat message

/** OpenClaw's names for the providers, where they differ from Lucid's. */
const OPENCLAW_PROVIDERS: Record<string, string> = { gemini: "google" };

/** Overrides the built-in provider's address in ~/.openclaw/openclaw.json; its key and models stay. The command writes the same (install.ts). */
function openclawConfig(provider: string, base: string) {
  const p = PROVIDERS[provider];
  // Lucid records chat completions, not OpenAI's Responses API, so the calls must use the former.
  const api = p?.anthropic ? "anthropic-messages" : "openai-completions";
  const extra = provider === "baseten" ? `\n        apiKey: "\${${p!.keyVar}}",\n        models: [{ id: "${p!.model}", name: "${p!.label}" }],` : "";
  return `{
  models: {
    mode: "merge",
    providers: {
      ${OPENCLAW_PROVIDERS[provider] ?? provider}: {
        baseUrl: "${base}",
        api: "${api}",
        headers: { "x-lucid-agent": "OpenClaw" },${extra}
      },
    },
  },
}`;
}

/** OpenClaw runs the command where it runs, gets it approved, then merges the settings file the command saves. */
function openclawPrompt(target: Target, provider: string) {
  const p = PROVIDERS[provider];
  const label = p?.label ?? provider;
  const company = p?.company ?? label;
  return `Connect yourself to Lucid, an observability tool, so I can see your runs.

1. Run this with your terminal tool:
   ${bothCommands(target, `for=openclaw&ai=${provider}`)}
   It waits up to 10 minutes for my approval, so run it in the background and keep reading its output.
   If your terminal runs in a separate sandbox rather than where you yourself run, stop and tell me instead.
2. As soon as it prints a link and a code, send me both so I can approve.
3. When it's done, it has saved Lucid's settings for your ${label} provider in ~/.lucid/openclaw.json5. Merge them into your config (~/.openclaw/openclaw.json). If you call ${label} under a different provider name, put the same settings on that one. Keep my ${company} API key, my models and everything else exactly as they are, and don't send me the settings: they hold my Lucid key.
4. Tell me what you changed, then restart your gateway (openclaw gateway restart) so it takes effect.`;
}

function OpenClawSetup({ target, provider, keyNote, onManual }: { target: Target; provider: string; keyNote: ReactNode; onManual: () => void }) {
  const p = PROVIDERS[provider];
  const company = p?.company ?? p?.label ?? provider;
  return (
    <>
      <Instructions>
        <Instruction n={1} title="Send this message to OpenClaw">
          <Fine>In WhatsApp, Telegram, Discord or wherever you chat with it. It runs one command and changes its own settings.</Fine>
          <AskAgent title="Message for OpenClaw" sub="Copy it, then paste it into your chat with OpenClaw." prompt={openclawPrompt(target, provider)} inStep />
        </Instruction>
        <Instruction n={2} title="Approve on the link it sends back">
          <Fine>Check that the code on the page matches the one in its message.</Fine>
        </Instruction>
        <Instruction n={3} title="Chat with it once more">
          <Fine>
            Every chat shows up here from then on. Your {company} key stays with OpenClaw: Lucid passes it on to {company} and never stores it.
          </Fine>
        </Instruction>
      </Instructions>
      <More title="Rather edit the settings yourself?" onOpen={onManual}>
        {keyNote}
        <Fine>
          Merge this into <Mono>~/.openclaw/openclaw.json</Mono>, then run <Mono>openclaw gateway restart</Mono>.
        </Fine>
        <Snippet label="openclaw.json" code={openclawConfig(provider, proxyBase(target, provider))} />
      </More>
      <LoopbackNote target={target} />
    </>
  );
}

// ---------------------------------------------------------------------------
// OpenTelemetry

const OTEL_CODE: Record<string, { label: string; code: string }> = {
  "openai-agents": {
    label: "Python",
    code: `# pip install openinference-instrumentation-openai-agents opentelemetry-sdk opentelemetry-exporter-otlp
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))  # reads the settings above
trace.set_tracer_provider(provider)
OpenAIAgentsInstrumentor().instrument()`,
  },
  langgraph: {
    label: ".env (add these too)",
    code: `# pip install "langsmith[otel]"
LANGSMITH_TRACING=true
LANGSMITH_OTEL_ENABLED=true
LANGSMITH_OTEL_ONLY=true`,
  },
  "vercel-ai": {
    label: "TypeScript",
    code: `// Register an OTLP exporter once (e.g. @vercel/otel in Next.js), then:
const result = await generateText({
  model,
  prompt,
  experimental_telemetry: { isEnabled: true },
});`,
  },
};

function OtelManual({ target, agent }: { target: Target; agent: AgentChoice }) {
  const extra = OTEL_CODE[agent.id];
  const env = lines(
    `OTEL_EXPORTER_OTLP_ENDPOINT=${target.endpoint}`,
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    !target.keyless && `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=${target.key}`,
    "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true",
    "OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental",
  );
  return (
    <>
      <Instructions>
        <Instruction n={1} title="Add these to your agent's .env file">
          <Snippet label=".env" code={env} />
        </Instruction>
        {extra && (
          <Instruction n={2} title="Turn on tracing in your code">
            <Snippet label={extra.label} code={extra.code} />
          </Instruction>
        )}
        <Instruction n={extra ? 3 : 2} title="Restart your agent and run it once">
          <Fine>Model calls, tools and handoffs show up here, with prompts and replies included.</Fine>
        </Instruction>
      </Instructions>
    </>
  );
}
