import { UserButton } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { api, useLiveUpdates } from "./api";
import { ClerkGate } from "./auth";
import { Landing } from "./landing/Landing";
import { PasswordSignIn, Splash, Unreachable } from "./pages/SignIn";
import { Arena, ExperimentPage, NewExperiment } from "./pages/Arena";
import { Connect } from "./pages/Connect";
import { Inbox, isRecurring } from "./pages/Inbox";
import { RunPage } from "./pages/Run";
import { Runs } from "./pages/Runs";
import { cx } from "./ui";

function Home() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  if (overview.isPending) return null;
  // Nothing captured yet: the only useful screen is the one that connects an agent.
  const hasRuns = (overview.data?.harnesses.length ?? 0) > 0;
  return <Navigate to={hasRuns ? "/inbox" : "/connect"} replace />;
}

function Tab({ to, children, badge }: { to: string; children: string; badge?: number }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
          isActive ? "bg-zinc-900 text-white dark:bg-white dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800",
        )
      }
    >
      {children}
      {badge ? <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-semibold leading-4 text-white">{badge}</span> : null}
    </NavLink>
  );
}

/**
 * Hosted Lucid asks who you are first (Clerk, or built-in email + password)
 * and shows signed-out visitors to "/" the landing page; local Lucid goes
 * straight in. /landing always shows the landing page.
 */
export function App() {
  const { pathname } = useLocation();
  const config = useQuery({ queryKey: ["auth-config"], queryFn: api.auth.config, staleTime: Number.POSITIVE_INFINITY, retry: 2 });
  if (pathname === "/landing") return <Landing />;
  if (config.isPending) return <Splash />;
  if (config.isError) return <Unreachable onRetry={() => void config.refetch()} />;
  const { provider, publishableKey, signups } = config.data;
  if (provider === "clerk" && publishableKey) {
    return (
      <ClerkGate publishableKey={publishableKey} signups={signups}>
        {() => <Shell account={<UserButton />} />}
      </ClerkGate>
    );
  }
  return <BuiltInGate />;
}

function BuiltInGate() {
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.auth.me, staleTime: 60_000 });
  if (me.isPending) return <Splash />;
  if (me.data?.mode === "hosted" && !me.data.user) return pathname === "/" ? <Landing /> : <PasswordSignIn signups={me.data.signups !== false} />;
  return <Shell account={me.data?.mode === "hosted" && me.data.user ? <AccountMenu email={me.data.user.email ?? ""} /> : null} />;
}

function AccountMenu({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const logout = useMutation({ mutationFn: api.auth.logout, onSuccess: () => queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth-config" }) });
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500">
      <span className="hidden max-w-40 truncate md:inline" title={email}>
        {email}
      </span>
      <button type="button" onClick={() => logout.mutate()} className="rounded-md px-2 py-1 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
        Sign out
      </button>
    </div>
  );
}

function Shell({ account }: { account: ReactNode }) {
  const live = useLiveUpdates();
  const issues = useQuery({ queryKey: ["issues"], queryFn: api.issues });
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-white/80 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:gap-6">
          <NavLink to="/" className="flex items-center gap-2 font-display text-lg font-bold tracking-tight">
            <span className="relative flex size-6 items-center justify-center rounded-full bg-brand-300 ring-1 ring-black/10">
              <span className="size-2.5 rounded-full bg-zinc-950" />
            </span>
            <span className="hidden sm:inline">Lucid</span>
          </NavLink>
          <nav className="flex items-center gap-1 overflow-x-auto">
            <Tab to="/inbox" badge={issues.data?.issues.filter(isRecurring).length}>
              Inbox
            </Tab>
            <Tab to="/runs">Runs</Tab>
            <Tab to="/arena">Arena</Tab>
            <Tab to="/connect">Connect</Tab>
          </nav>
          <div
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500"
            title={live ? "New runs appear on their own" : "Not connected to the server; reload to retry"}
          >
            <span className={cx("size-2 rounded-full", live ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700")} />
            <span className="hidden sm:inline">{live ? "Live" : "Offline"}</span>
          </div>
          {account}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/arena" element={<Arena />} />
          <Route path="/arena/new" element={<NewExperiment />} />
          <Route path="/arena/:id" element={<ExperimentPage />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
