// Where the one-command installer sends people: approve this computer, and
// the installer receives its key (see apps/server/src/links.ts).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, Laptop, Loader2, Server, X } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { BRANDS, type Brand, BrandMark } from "../landing/logos";
import { cx } from "../ui";
import { LogoWell } from "./ConnectWizard";

const AGENTS: Record<string, { name: string; brand: Brand; next: string }> = {
  "claude-code": { name: "Claude Code", brand: BRANDS.claudeCode, next: "Start a new Claude Code session." },
  hermes: { name: "Hermes Agent", brand: BRANDS.hermes, next: "Restart Hermes (the gateway, the desktop app or its container)." },
};

export function LinkPage() {
  const [params, setParams] = useSearchParams();
  const code = params.get("code");
  return (
    <div className="flex justify-center pt-4 sm:pt-12">
      <div className="w-full max-w-md rounded-3xl bg-white p-6 shadow-xl ring-1 shadow-black/5 ring-zinc-200 motion-safe:animate-[rise_.3s_ease-out] sm:p-8 dark:bg-zinc-900 dark:shadow-black/40 dark:ring-white/10">
        {code ? <Approve key={code} code={code} onRetry={() => setParams({}, { replace: true })} /> : <EnterCode onCode={(entered) => setParams({ code: entered }, { replace: true })} />}
      </div>
    </div>
  );
}

function Approve({ code, onRetry }: { code: string; onRetry: () => void }) {
  const queryClient = useQueryClient();
  const link = useQuery({
    queryKey: ["link", code],
    queryFn: () => api.links.get(code),
    retry: false,
    // Once approved, watch for the installer picking up its key.
    refetchInterval: (query) => (query.state.data?.status === "approved" ? 1_500 : false),
  });
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") => api.links.decide(code, decision),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["link", code] }),
  });

  if (link.isPending) return <Loader2 className="mx-auto my-12 size-5 animate-spin text-zinc-400" aria-label="Loading" />;
  if (link.isError) {
    return (
      <Outcome icon={<X className="size-7" />} tone="bad" title="That code didn't work" sub={link.error.message}>
        <SecondaryButton onClick={onRetry}>Type the code instead</SecondaryButton>
      </Outcome>
    );
  }
  const data = link.data;
  if (data.status === "taken") return <Outcome icon={<X className="size-7" />} tone="bad" title="This code was already used" sub="Another account approved it. Run the command again for a new code." />;
  if (data.status === "expired") return <Outcome icon={<X className="size-7" />} tone="bad" title="This code expired" sub="Codes last 10 minutes. Run the command again for a new one." />;
  if (data.status === "denied") return <Outcome icon={<X className="size-7" />} tone="bad" title="Not connected" sub={`You declined ${data.machine}. Nothing was connected.`} />;

  const agents = data.agents.map((id) => AGENTS[id]).filter((agent) => !!agent);
  if (data.status === "approved" || data.status === "claimed") {
    const done = data.status === "claimed";
    return (
      <Outcome
        icon={done ? <Check className="size-8" strokeWidth={2.5} /> : <Loader2 className="size-7 animate-spin" />}
        tone="good"
        title={done ? `${data.machine} is connected` : "Approved"}
        sub={done ? "One last step on that computer:" : "Your terminal is finishing up…"}
      >
        {done && (
          <>
            <ul className="w-full space-y-2 text-left">
              {agents.map((agent) => (
                <li key={agent.name} className="flex items-center gap-3 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-white/5">
                  <LogoWell size="size-9 rounded-lg">
                    <BrandMark brand={agent.brand} className="size-5" />
                  </LogoWell>
                  {agent.next}
                </li>
              ))}
            </ul>
            <Link
              to="/connect"
              className="group mt-2 inline-flex items-center gap-2 rounded-full bg-brand-300 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-[0_10px_40px_-12px_rgba(216,248,74,0.6)] transition hover:bg-brand-200"
            >
              Go to your agents
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </>
        )}
      </Outcome>
    );
  }

  const Machine = data.os === "Linux" || data.os === "Unix" ? Server : Laptop;
  return (
    <div className="text-center">
      <LogoWell size="mx-auto size-16 rounded-2xl">
        <Machine className="size-8" strokeWidth={1.5} />
      </LogoWell>
      <h1 className="mt-6 font-display text-2xl font-bold tracking-tight text-balance">Connect {data.machine}?</h1>
      <p className="mt-2 text-zinc-500 dark:text-zinc-400">It wants to send its agents' runs to your Lucid.</p>

      <ul className="mt-6 space-y-2 text-left">
        {agents.map((agent) => (
          <li key={agent.name} className="flex items-center gap-3 rounded-xl p-3 ring-1 ring-zinc-200 dark:ring-white/10">
            <LogoWell size="size-10 rounded-lg">
              <BrandMark brand={agent.brand} className="size-6" />
            </LogoWell>
            <span className="font-medium">{agent.name}</span>
          </li>
        ))}
      </ul>

      <div className="mt-6 rounded-2xl bg-zinc-50 px-4 py-4 dark:bg-white/5">
        <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Code</div>
        <div className="mt-1 font-mono text-3xl font-semibold tracking-[0.15em]">{data.code}</div>
        <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Check it matches the one in your terminal.</div>
      </div>

      {decide.isError && <p className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{decide.error.message}</p>}

      <div className="mt-6 space-y-2">
        <button
          type="button"
          onClick={() => decide.mutate("approve")}
          disabled={decide.isPending}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand-300 font-semibold text-zinc-950 shadow-[0_10px_40px_-12px_rgba(216,248,74,0.6)] transition hover:bg-brand-200 disabled:opacity-60"
        >
          {decide.isPending && decide.variables === "approve" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" strokeWidth={2.5} />}
          Approve
        </button>
        <SecondaryButton onClick={() => decide.mutate("deny")} disabled={decide.isPending} wide>
          Don't allow
        </SecondaryButton>
      </div>
      <p className="mt-5 text-xs text-zinc-500 dark:text-zinc-400">Only approve a computer you just ran Lucid's command on yourself.</p>
    </div>
  );
}

function Outcome({ icon, tone, title, sub, children }: { icon: ReactNode; tone: "good" | "bad"; title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <span
        className={cx(
          "flex size-16 items-center justify-center rounded-full",
          tone === "good" ? "bg-brand-300 text-zinc-950 shadow-[0_10px_40px_-8px_rgba(216,248,74,0.7)]" : "bg-zinc-100 text-zinc-500 dark:bg-white/10 dark:text-zinc-300",
        )}
      >
        {icon}
      </span>
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight text-balance">{title}</h1>
        <p className="mt-2 text-zinc-500 dark:text-zinc-400">{sub}</p>
      </div>
      {children}
    </div>
  );
}

function SecondaryButton({ onClick, disabled, wide, children }: { onClick: () => void; disabled?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx("h-11 rounded-full px-5 text-sm font-semibold ring-1 ring-zinc-200 transition hover:bg-zinc-50 disabled:opacity-60 dark:ring-white/15 dark:hover:bg-white/5", wide && "w-full")}
    >
      {children}
    </button>
  );
}

/** For a link printed on a server: type the code shown there. */
function EnterCode({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  const plain = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (plain.length === 8) onCode(`${plain.slice(0, 4)}-${plain.slice(4)}`);
  };
  return (
    <form onSubmit={onSubmit} className="text-center">
      <LogoWell size="mx-auto size-16 rounded-2xl">
        <Laptop className="size-8" strokeWidth={1.5} />
      </LogoWell>
      <h1 className="mt-6 font-display text-2xl font-bold tracking-tight">Connect a computer</h1>
      <p className="mt-2 text-zinc-500 dark:text-zinc-400">Type the code Lucid's command printed in your terminal.</p>
      <input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="XXXX-XXXX"
        aria-label="Code"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        className="mt-6 h-14 w-full rounded-2xl bg-zinc-50 text-center font-mono text-2xl tracking-[0.15em] uppercase ring-1 ring-zinc-200 outline-none placeholder:text-zinc-300 focus:ring-2 focus:ring-brand-500 dark:bg-white/5 dark:ring-white/10 dark:placeholder:text-zinc-600 dark:focus:ring-brand-300"
      />
      <button
        type="submit"
        disabled={plain.length !== 8}
        className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-brand-300 font-semibold text-zinc-950 transition hover:bg-brand-200 disabled:opacity-50"
      >
        Continue
        <ArrowRight className="size-4" />
      </button>
    </form>
  );
}
