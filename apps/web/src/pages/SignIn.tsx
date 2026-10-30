import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronsRight, Loader2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { GridGlow, Logo, TraceLine, Underline, useDarkDocument } from "../brand";
import { Card, cx } from "../ui";

/**
 * The frame around every signed-out screen: the brand on the left, the task
 * on the right. Dark whatever the system theme, like the landing page.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  useDarkDocument();
  return (
    <div className="dark grid min-h-dvh bg-zinc-950 text-zinc-100 lg:grid-cols-2">
      <aside className="relative hidden items-center justify-center overflow-hidden border-r border-white/5 px-10 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <GridGlow from="center" />
          <TraceLine className="absolute -top-24 -left-16 w-48" />
          <TraceLine className="absolute -right-16 -bottom-24 w-48 rotate-180" />
        </div>
        <div className="relative flex flex-col items-center text-center">
          <Link to="/" className="flex items-center gap-3 font-display text-3xl font-bold tracking-tight text-white">
            <Logo size="lg" />
            Lucid
          </Link>
          <p className="mt-12 max-w-lg font-display text-5xl font-bold leading-[1.05] tracking-[-0.035em] text-balance text-white xl:text-6xl">
            See why your agents do{" "}
            <span className="relative whitespace-nowrap">
              what they do
              <Underline />
            </span>
          </p>
        </div>
      </aside>
      <main className="relative flex flex-col items-center justify-center px-4 py-20">
        <Link to="/" className="absolute top-6 left-6 inline-flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-white">
          <ArrowLeft className="size-4" />
          Home
        </Link>
        <Link to="/" className="mb-10 flex items-center gap-2.5 font-display text-2xl font-bold tracking-tight text-white lg:hidden">
          <Logo />
          Lucid
        </Link>
        {children}
      </main>
    </div>
  );
}

/** The sign-in card: dark glass with a lime edge along the top. */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("relative w-full max-w-[400px] rounded-2xl bg-zinc-900/70 p-7 shadow-2xl shadow-black/50 ring-1 ring-white/10", className)}>
      <div aria-hidden className="absolute inset-x-10 top-0 h-px bg-linear-to-r from-transparent via-brand-300/70 to-transparent" />
      {children}
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

const input =
  "h-11 w-full rounded-xl bg-zinc-950 px-3.5 text-sm text-white ring-1 ring-white/10 outline-none transition placeholder:text-zinc-600 hover:ring-white/20 focus:ring-2 focus:ring-brand-300/60";

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

  return (
    <AuthLayout>
      <AuthCard>
        <div className="text-center">
          <h2 className="font-display text-3xl font-bold tracking-tight text-white">{mode === "in" ? "Welcome back" : "Create your account"}</h2>
          <p className="mt-2 text-sm text-zinc-400">{mode === "in" ? "Sign in to see what your agents did." : "Free while in beta. Connect your first agent in a minute."}</p>
        </div>
        <form onSubmit={onSubmit} className="mt-7 space-y-4">
          {mode === "up" && (
            <label className="block space-y-1.5 text-sm">
              <span className="font-medium text-zinc-300">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" placeholder="Ada Lovelace" className={input} />
            </label>
          )}
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-zinc-300">Email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@company.com" className={input} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span className="font-medium text-zinc-300">Password</span>
            <input
              type="password"
              required
              minLength={mode === "up" ? 10 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              className={input}
            />
            {mode === "up" && <span className="block text-xs text-zinc-500">At least 10 characters.</span>}
          </label>
          {submit.isError && <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">{submit.error.message}</p>}
          <button
            type="submit"
            disabled={submit.isPending}
            className="group mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand-300 text-sm font-semibold text-zinc-950 shadow-[0_10px_40px_-12px_rgba(216,248,74,0.6)] transition hover:bg-brand-200 disabled:opacity-60"
          >
            {submit.isPending ? <Loader2 className="size-4 animate-spin" /> : mode === "in" ? "Sign in" : "Create account"}
            {!submit.isPending && <ChevronsRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
          </button>
        </form>
      </AuthCard>
      {signups && (
        <p className="mt-6 text-center text-sm text-zinc-500">
          {mode === "in" ? "New here? " : "Already have an account? "}
          <button type="button" onClick={() => setMode(mode === "in" ? "up" : "in")} className="font-medium text-brand-300 transition hover:text-brand-200">
            {mode === "in" ? "Create an account" : "Sign in"}
          </button>
        </p>
      )}
    </AuthLayout>
  );
}
