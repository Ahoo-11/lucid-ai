import { UserButton } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router";
import { type AuthConfig, api, useLiveUpdates } from "./api";
import { AsciiField } from "./ascii";
import { ClerkGate } from "./auth";
import { forgetCache, useAccountCache } from "./cache";
import { Landing } from "./landing/Landing";
import { PasswordSignIn, Splash, Unreachable } from "./pages/SignIn";
import { Arena, ExperimentPage, NewExperiment } from "./pages/Arena";
import { Connect } from "./pages/Connect";
import { Inbox, needsFix } from "./pages/Inbox";
import { LinkPage } from "./pages/Link";
import { SessionRoute } from "./pages/Session";
import { Runs } from "./pages/Runs";
import { useSyncs } from "./syncs";
import { setTheme, useTheme } from "./theme";
import { cx } from "./ui";

function Home() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  if (overview.isPending) return null;
  // Nothing captured yet: the only useful screen is the one that connects an agent.
  const hasRuns = (overview.data?.harnesses.length ?? 0) > 0;
  return <Navigate to={hasRuns ? "/inbox" : "/connect"} replace />;
}

/** `also`: another path the tab's pages live under (a session opens at /sessions/…, the list is /runs). */
function Tab({ to, also, children, badge, busy }: { to: string; also?: string; children: string; badge?: number; busy?: string }) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cx(
          "relative flex flex-1 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition sm:flex-none",
          isActive || (also && pathname.startsWith(also))
            ? "bg-white text-zinc-900 shadow-[0_1px_2px_rgba(24,24,27,0.08)] ring-1 ring-black/5 dark:bg-zinc-800 dark:text-white dark:ring-white/5"
            : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white",
        )
      }
    >
      {children}
      {busy && <Loader2 className="size-3.5 animate-spin opacity-70" aria-label={busy} />}
      {badge ? <span className="min-w-4 rounded-full bg-rose-500 px-1.5 text-center text-[10px] leading-4 font-semibold text-white tabular-nums">{badge}</span> : null}
    </NavLink>
  );
}

/** Light is the default; the choice stays in this browser. */
function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-zinc-500 transition hover:bg-zinc-900/5 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-white"
    >
      {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

/**
 * Hosted Lucid asks who you are first (Clerk, or built-in email + password)
 * and shows signed-out visitors to "/" the landing page; local Lucid goes
 * straight in. /landing always shows the landing page.
 */
export function App() {
  const { pathname } = useLocation();
  // The server writes this into the page, which saves a round trip before anything shows.
  const config = useQuery({ queryKey: ["auth-config"], queryFn: api.auth.config, staleTime: Number.POSITIVE_INFINITY, retry: 2, initialData: window.__LUCID_CONFIG__ });
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

declare global {
  interface Window {
    __LUCID_CONFIG__?: AuthConfig;
  }
}

function BuiltInGate() {
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.auth.me, staleTime: 60_000 });
  useAccountCache(me.data?.mode === "local" ? "local" : me.data?.user ? `password:${me.data.user.email}` : null);
  if (me.isPending) return <Splash />;
  if (me.data?.mode === "hosted" && !me.data.user) return pathname === "/" ? <Landing /> : <PasswordSignIn signups={me.data.signups !== false} />;
  return <Shell account={me.data?.mode === "hosted" && me.data.user ? <AccountMenu email={me.data.user.email ?? ""} /> : null} />;
}

function AccountMenu({ email }: { email: string }) {
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSuccess: () => {
      forgetCache();
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "auth-config" });
    },
  });
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="hidden max-w-40 truncate md:inline" title={email}>
        {email}
      </span>
      <button type="button" onClick={() => logout.mutate()} className="rounded-lg px-2.5 py-1.5 font-medium transition hover:bg-zinc-900/5 hover:text-zinc-900 dark:hover:bg-white/10 dark:hover:text-zinc-100">
        Sign out
      </button>
    </div>
  );
}

function Shell({ account }: { account: ReactNode }) {
  const live = useLiveUpdates();
  const issues = useQuery({ queryKey: ["issues"], queryFn: api.issues });
  const syncing = useSyncs().active.length > 0;
  return (
    // Its own stacking context, so the ASCII field sits above the page colour and under everything else.
    <div className="relative isolate min-h-dvh">
      <AsciiField />
      <header className="sticky top-0 z-20 border-b border-zinc-900/[0.07] bg-paper/80 backdrop-blur-md dark:border-white/[0.07] dark:bg-zinc-950/80">
        {/* On a phone the tabs get their own full-width row under the logo. */}
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 px-4 sm:h-16 sm:flex-nowrap sm:gap-5 sm:px-6 lg:px-8">
          <NavLink to="/" className="flex h-14 shrink-0 items-center gap-2 font-display text-lg font-bold tracking-tight sm:h-auto">
            <span className="relative flex size-7 items-center justify-center rounded-full bg-brand-300 ring-1 ring-black/10">
              <span className="size-2.5 rounded-full bg-zinc-950" />
            </span>
            Lucid
          </NavLink>
          <nav className="order-last mb-3 flex w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-xl bg-zinc-900/[0.05] p-1 [scrollbar-width:none] sm:order-none sm:mb-0 sm:w-auto dark:bg-white/[0.06]">
            <Tab to="/inbox" badge={issues.data?.issues.filter(needsFix).length}>
              Inbox
            </Tab>
            <Tab to="/runs" also="/sessions" busy={syncing ? "Bringing in past runs" : undefined}>
              Sessions
            </Tab>
            <Tab to="/arena">Arena</Tab>
            <Tab to="/connect">Connect</Tab>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <div
              className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
              title={live ? "New runs appear on their own" : "Not connected to the server; reload to retry"}
            >
              <span className={cx("size-1.5 rounded-full", live ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700")} />
              <span className="hidden md:inline">{live ? "Live" : "Offline"}</span>
            </div>
            <ThemeToggle />
            {account}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 pt-8 pb-16 sm:px-6 sm:pt-10 lg:px-8">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<SessionRoute by="run" />} />
          <Route path="/sessions" element={<Navigate to="/runs" replace />} />
          <Route path="/sessions/:id" element={<SessionRoute by="session" />} />
          <Route path="/arena" element={<Arena />} />
          <Route path="/arena/new" element={<NewExperiment />} />
          <Route path="/arena/:id" element={<ExperimentPage />} />
          <Route path="/connect" element={<Connect />} />
          <Route path="/link" element={<LinkPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
