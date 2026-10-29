import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Loader2, Scale, ScanSearch, Waypoints } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../api";
import { Card, cx } from "../ui";

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={cx("relative flex items-center justify-center rounded-full bg-violet-600 shadow-lg shadow-violet-600/30", size === "lg" ? "size-10" : "size-7")}>
      <span className={cx("rounded-full bg-white", size === "lg" ? "size-4" : "size-3")} />
    </span>
  );
}

const FEATURES = [
  { icon: Waypoints, title: "Connect any agent in a minute", text: "Claude Code, Hermes, LangGraph, or any app: change one URL." },
  { icon: ScanSearch, title: "See why it did what it did", text: "Every prompt, decision and tool call, told as a story. Failures grouped, with a fix." },
  { icon: Scale, title: "Prove the best model, blind", text: "Replay real decisions with other models and prompts. Judge without labels." },
];

/** A sample run, drawn the way Lucid shows them: outcome first, steps after. */
function SampleRun() {
  const steps = [
    { label: "Read 4 files", ok: true },
    { label: "Ran tests · 1 failed", ok: false },
    { label: "Edited auth.ts", ok: true },
    { label: "Tests passed", ok: true },
  ];
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white">Fix the failing login test</div>
          <div className="text-xs text-zinc-400">Claude Code · 3m 10s · $0.41</div>
        </div>
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">Succeeded</span>
      </div>
      <ol className="mt-3 space-y-1.5">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-xs text-zinc-300">
            {step.ok ? <CircleCheck className="size-3.5 text-emerald-400" /> : <CircleX className="size-3.5 text-amber-400" />}
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The frame around every signed-out screen: brand panel left, the task right. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-white/5 bg-zinc-950 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <div aria-hidden className="pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-violet-600/30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 right-0 size-[26rem] rounded-full bg-fuchsia-500/10 blur-3xl" />
        <div className="relative flex items-center gap-2.5 text-lg font-semibold">
          <Logo />
          Lucid
        </div>
        <div className="relative max-w-md space-y-8">
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold leading-tight tracking-tight">See why your agents do what they do.</h1>
            <p className="text-zinc-400">Observability for AI agents that reads like a story, and a blind arena to prove which model and prompt work best.</p>
          </div>
          <ul className="space-y-4">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                  <f.icon className="size-4 text-violet-300" />
                </span>
                <div>
                  <div className="text-sm font-medium">{f.title}</div>
                  <div className="text-sm text-zinc-400">{f.text}</div>
                </div>
              </li>
            ))}
          </ul>
          <SampleRun />
        </div>
        <p className="relative text-xs text-zinc-500">Your provider keys stay yours: Lucid passes them through and never stores them.</p>
      </aside>
      <main className="flex flex-col items-center justify-center gap-8 px-4 py-10">
        <div className="flex items-center gap-2.5 text-lg font-semibold lg:hidden">
          <Logo />
          Lucid
        </div>
        {children}
      </main>
    </div>
  );
}

/** Shown while the app works out who you are. */
export function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <Loader2 className="size-5 animate-spin text-zinc-400" aria-label="Loading" />
    </div>
  );
}

export function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm space-y-3 p-6 text-center">
        <h2 className="font-semibold">Can't reach Lucid</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">The server didn't answer. Check your connection and try again.</p>
        <button type="button" onClick={onRetry} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900">
          Try again
        </button>
      </Card>
    </AuthLayout>
  );
}

/** Built-in email + password sign-in, for servers without Clerk. */
export function PasswordSignIn({ signups }: { signups: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const submit = useMutation({
    mutationFn: () => (mode === "in" ? api.auth.login(email, password) : api.auth.signup(email, password, name)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["me"] }),
  });
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit.mutate();
  };
  const input = "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-400/20 dark:border-zinc-800 dark:bg-zinc-950";

  return (
    <AuthLayout>
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold">{mode === "in" ? "Sign in to Lucid" : "Create your Lucid account"}</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{mode === "in" ? "Welcome back." : "Free to start. Connect your first agent in a minute."}</p>
        </div>
        <Card className="p-5">
          <form onSubmit={onSubmit} className="space-y-3">
            {mode === "up" && (
              <label className="block space-y-1 text-sm">
                <span className="font-medium">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className={input} />
              </label>
            )}
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" className={input} />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Password</span>
              <input
                type="password"
                required
                minLength={mode === "up" ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "in" ? "current-password" : "new-password"}
                className={input}
              />
              {mode === "up" && <span className="text-xs text-zinc-500">At least 10 characters.</span>}
            </label>
            {submit.isError && <p className="text-sm text-rose-600">{submit.error.message}</p>}
            <button type="submit" disabled={submit.isPending} className="w-full rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
              {submit.isPending ? "…" : mode === "in" ? "Sign in" : "Create account"}
            </button>
          </form>
        </Card>
        {signups && (
          <p className="text-center text-sm text-zinc-500">
            {mode === "in" ? "New here? " : "Already have an account? "}
            <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="font-medium text-violet-600 dark:text-violet-400">
              {mode === "in" ? "Create an account" : "Sign in"}
            </button>
          </p>
        )}
      </div>
    </AuthLayout>
  );
}
