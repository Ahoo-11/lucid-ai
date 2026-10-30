import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowRight, KeyRound, Plus, Waypoints } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type ConnectStatus, api } from "../api";
import { ago, harnessLabel, plural } from "../format";
import { BRANDS, type Brand, BrandMark } from "../landing/logos";
import { Card, cx } from "../ui";
import { ConnectWizard, LogoWell, findAgent } from "./ConnectWizard";

const SOURCE_LABELS: Record<string, string> = {
  transcript: "session files",
  hook: "hooks",
  otlp_traces: "OpenTelemetry traces",
  otlp_logs: "OpenTelemetry events",
  proxy: "the LLM proxy",
};

const HARNESS_BRANDS: Record<string, Brand> = {
  "claude-code": BRANDS.claudeCode,
  hermes: BRANDS.hermes,
  langchain: BRANDS.langchain,
  langgraph: BRANDS.langgraph,
  crewai: BRANDS.crewai,
  "pydantic-ai": BRANDS.pydanticai,
  "openai-agents": BRANDS.openai,
  "vercel-ai": BRANDS.vercel,
  otel: BRANDS.otel,
};

/** Shown once per browser session, so closing the wizard isn't undone by the next visit. */
const AUTO_OPENED = "lucid.connect.autoOpened";

export function Connect() {
  const status = useQuery({
    queryKey: ["connect"],
    queryFn: api.connect,
    // Poll until the first data arrives, so the list fills in on its own.
    refetchInterval: (query) => ((query.state.data?.runs ?? 0) > 0 ? 15_000 : 2_000),
  });
  const [params, setParams] = useSearchParams();
  const linked = findAgent(params.get("agent"));
  const [open, setOpen] = useState(!!linked);
  const [newKey, setNewKey] = useState<string | null>(null);
  const empty = status.data?.sources.length === 0;

  // Nothing connected yet: the wizard is the whole job, so it opens by itself.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!empty || autoOpened.current) return;
    autoOpened.current = true;
    try {
      if (sessionStorage.getItem(AUTO_OPENED)) return;
      sessionStorage.setItem(AUTO_OPENED, "1");
    } catch {
      // Storage blocked: open it anyway.
    }
    setOpen(true);
  }, [empty]);

  const close = () => {
    setOpen(false);
    if (params.has("agent")) setParams({}, { replace: true });
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Your agents</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Everything they send shows up in Runs.</p>
        </div>
        {!empty && (
          <PrimaryButton onClick={() => setOpen(true)}>
            <Plus className="size-4" />
            Connect an agent
          </PrimaryButton>
        )}
      </div>

      {status.data && (empty ? <FirstAgent onStart={() => setOpen(true)} /> : <Connected data={status.data} />)}
      <Keys local={status.data?.localMode ?? true} />

      <ConnectWizard open={open} onClose={close} initialAgent={linked} newKey={newKey} onKey={setNewKey} />
    </div>
  );
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full bg-brand-300 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-[0_10px_30px_-12px_rgba(166,205,9,0.8)] transition hover:bg-brand-200"
    >
      {children}
    </button>
  );
}

const STACK = [BRANDS.claudeCode, BRANDS.hermes, BRANDS.langgraph, BRANDS.crewai, BRANDS.openai, BRANDS.vercel];

function FirstAgent({ onStart }: { onStart: () => void }) {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      <div className="flex -space-x-2.5">
        {STACK.map((brand, index) => (
          // The padding is the card's color, cutting each logo out of the one behind it.
          <span key={brand.name} className={cx("rounded-[18px] bg-white p-1 dark:bg-zinc-900", index % 2 ? "translate-y-1.5" : "-translate-y-1")}>
            <LogoWell size="size-12 rounded-[14px]">
              <BrandMark brand={brand} className="size-6" />
            </LogoWell>
          </span>
        ))}
      </div>
      <h2 className="mt-8 font-display text-2xl font-bold tracking-tight">Connect your first agent</h2>
      <p className="mt-2 max-w-sm text-zinc-500 dark:text-zinc-400">It takes about a minute. After that, every run shows up here on its own.</p>
      <div className="mt-7">
        <PrimaryButton onClick={onStart}>
          Get started
          <ArrowRight className="size-4" />
        </PrimaryButton>
      </div>
    </Card>
  );
}

type Row = { id: string; name: string; brand?: Brand; proxy: boolean; via: string[]; events: number; lastAt: string | null };

/** One row per agent, however many ways it sends. */
function rows(sources: ConnectStatus["sources"]): Row[] {
  const byAgent = new Map<string, Row>();
  for (const source of sources) {
    const id = source.harness ?? source.source;
    const row = byAgent.get(id) ?? {
      id,
      name: source.harness ? harnessLabel(source.harness) : source.source === "proxy" ? "Through the LLM proxy" : (SOURCE_LABELS[source.source] ?? source.source),
      brand: source.harness ? HARNESS_BRANDS[source.harness] : undefined,
      proxy: source.source === "proxy",
      via: [],
      events: 0,
      lastAt: null,
    };
    const via = SOURCE_LABELS[source.source] ?? source.source;
    if (!row.via.includes(via)) row.via.push(via);
    row.events += source.events;
    if (source.lastAt && (!row.lastAt || source.lastAt > row.lastAt)) row.lastAt = source.lastAt;
    byAgent.set(id, row);
  }
  return [...byAgent.values()].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

const RECENT_MS = 15 * 60_000;

function Connected({ data }: { data: ConnectStatus }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {rows(data.sources).map((row) => {
          const recent = !!row.lastAt && Date.now() - new Date(row.lastAt).getTime() < RECENT_MS;
          const Icon = row.proxy ? Waypoints : Activity;
          return (
            <li key={row.id} className="flex items-center gap-4 px-5 py-4">
              <LogoWell size="size-11 rounded-xl">{row.brand ? <BrandMark brand={row.brand} className="size-6" /> : <Icon className="size-5 text-zinc-500" />}</LogoWell>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{row.name}</div>
                <div className="truncate text-sm text-zinc-500 dark:text-zinc-400">
                  {plural(row.events, "event")} via {row.via.join(" and ")}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400" title={row.lastAt ?? undefined}>
                <span className={cx("size-2 rounded-full", recent ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600")} />
                {ago(row.lastAt)}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3 text-sm dark:border-zinc-800 dark:bg-white/[0.02]">
        <span className="text-zinc-500 dark:text-zinc-400">{plural(data.runs, "run")} so far</span>
        <Link to="/runs" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline dark:text-brand-300">
          See runs
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </Card>
  );
}

function Keys({ local }: { local: boolean }) {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: api.keys });
  const revoke = useMutation({ mutationFn: api.revokeKey, onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["keys"] }) });
  if (!keys.data?.keys.length) return null;
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold">Lucid keys</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{local ? "Only agents on other machines need one." : "Each agent sends with one. Revoke a key to cut that agent off."}</p>
      </div>
      <Card>
        <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
          {keys.data.keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 px-4 py-2.5">
              <KeyRound className="size-3.5 shrink-0 text-zinc-400" />
              <span className="min-w-0 flex-1 truncate font-medium">{key.name}</span>
              <code className="hidden font-mono text-xs text-zinc-500 sm:inline">{key.prefix}…</code>
              <span className="w-24 text-right text-xs text-zinc-400">{key.lastUsedAt ? `used ${ago(key.lastUsedAt)}` : "never used"}</span>
              <button type="button" onClick={() => revoke.mutate(key.id)} className="text-xs text-rose-600 hover:underline dark:text-rose-400">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
