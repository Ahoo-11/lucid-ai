// Clerk sign-in for hosted Lucid. The server says whether Clerk is on and
// hands over the publishable key (GET /api/auth/config), so one build serves
// every deployment.

import { ClerkFailed, ClerkLoading, ClerkProvider, Show, SignIn, SignOutButton, useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { type Me, api, setTokenSource } from "./api";
import { forgetCache, useAccountCache } from "./cache";
import { Landing } from "./landing/Landing";
import { AuthLayout, Splash } from "./pages/SignIn";
import { Card } from "./ui";

const DARK = "(prefers-color-scheme: dark)";
const subscribe = (onChange: () => void) => {
  const media = matchMedia(DARK);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const useDark = () => useSyncExternalStore(subscribe, () => matchMedia(DARK).matches);

const FONT = '"Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const SHARED = { fontFamily: FONT, borderRadius: "0.625rem" };

const DARK_COLORS = {
  ...SHARED,
  colorPrimary: "#d8f84a",
  colorPrimaryForeground: "#09090b",
  colorBackground: "#18181b",
  colorForeground: "#fafafa",
  colorMutedForeground: "#a1a1aa",
  colorNeutral: "#fafafa",
  colorInput: "#09090b",
  colorInputForeground: "#fafafa",
  colorBorder: "#27272a",
  colorRing: "#d8f84a",
  colorDanger: "#f43f5e",
  colorSuccess: "#10b981",
};

/**
 * Clerk's components in the app (the account menu) in Lucid's colors and font,
 * following the system theme. Primary is near-black in light mode: Clerk colors
 * its links with it too, and lime text is unreadable on white.
 */
function appearance(dark: boolean) {
  return {
    // Under Tailwind's utilities (see styles.css), so classes can restyle Clerk.
    cssLayerName: "clerk",
    variables: dark
      ? DARK_COLORS
      : {
          ...SHARED,
          colorPrimary: "#18181b",
          colorPrimaryForeground: "#ffffff",
          colorBackground: "#ffffff",
          colorForeground: "#18181b",
          colorMutedForeground: "#71717a",
          colorNeutral: "#18181b",
          colorInput: "#ffffff",
          colorInputForeground: "#18181b",
          colorBorder: "#e4e4e7",
          colorDanger: "#e11d48",
          colorSuccess: "#059669",
        },
  };
}

/** The sign-in card sits on the always-dark sign-in screen and matches Lucid's own (AuthCard). */
const SIGN_IN_APPEARANCE = {
  variables: { ...DARK_COLORS, colorBackground: "#141416", borderRadius: "0.75rem" },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "relative w-full max-w-[400px] rounded-2xl border-0 shadow-2xl shadow-black/50 ring-1 ring-white/10 before:absolute before:inset-x-10 before:top-0 before:z-10 before:h-px before:bg-linear-to-r before:from-transparent before:via-brand-300/70 before:to-transparent",
    headerTitle: "font-display text-3xl font-bold tracking-tight",
    headerSubtitle: "text-zinc-400",
    socialButtonsBlockButton: "h-11 rounded-full border-0 bg-white shadow-none ring-0 hover:bg-zinc-200",
    socialButtonsBlockButtonText: "text-sm font-semibold text-zinc-900",
    dividerLine: "bg-white/10",
    dividerText: "text-zinc-500",
    formFieldLabel: "text-zinc-300",
    formFieldInput: "h-11 rounded-xl border-0 bg-zinc-950 shadow-none ring-1 ring-white/10 hover:ring-white/20 focus:ring-2 focus:ring-brand-300/60",
    formButtonPrimary: "h-11 rounded-full bg-brand-300 font-semibold text-zinc-950 shadow-[0_10px_40px_-12px_rgba(216,248,74,0.6)] hover:bg-brand-200",
    footerActionLink: "font-medium text-brand-300 hover:text-brand-200",
  },
};

const LOCALIZATION = {
  signIn: { start: { titleCombined: "Welcome to Lucid", subtitleCombined: "Sign in or create your account. Free while in beta." } },
};

/**
 * Gives every API call the current session token, and drops cached data
 * when the signed-in user changes, so one account never sees another's runs.
 */
function SessionBridge() {
  const { getToken, userId, isLoaded } = useAuth();
  const queryClient = useQueryClient();
  // Set during render too: the first queries below start before effects run.
  setTokenSource(() => getToken());
  useLayoutEffect(() => {
    setTokenSource(() => getToken());
    return () => setTokenSource(null);
  }, [getToken]);
  // Before the pages below render, so they paint from the last visit at once.
  useAccountCache(isLoaded && userId ? `clerk:${userId}` : null);
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return;
    if (previous.current !== undefined && previous.current !== (userId ?? null)) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth-config" });
      if (!userId) forgetCache();
    }
    previous.current = userId ?? null;
  }, [isLoaded, userId, queryClient]);
  return null;
}

function InviteOnly({ message }: { message: string }) {
  return (
    <AuthLayout>
      <Card className="w-full max-w-sm space-y-3 p-6 text-center">
        <h2 className="font-semibold">You're signed in, but not on the list</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
        <SignOutButton>
          <button type="button" className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900">
            Use another account
          </button>
        </SignOutButton>
      </Card>
    </AuthLayout>
  );
}

/** Signed in with Clerk: make sure Lucid has an account for this user, then show the app. */
function Account({ children }: { children: (me: Me) => ReactNode }) {
  const me = useQuery({ queryKey: ["me"], queryFn: api.auth.me, staleTime: 60_000 });
  if (me.isPending) return <Splash />;
  if (me.data?.mode === "hosted" && me.data.closed) return <InviteOnly message={me.data.error ?? "Sign-ups are closed on this server."} />;
  // Signed in at Clerk but the server didn't accept the token yet (clock skew,
  // a just-created session): Clerk refreshes it, so retry shortly.
  if (me.data?.mode === "hosted" && !me.data.user) return <Retry onRetry={() => void me.refetch()} />;
  return <>{children(me.data!)}</>;
}

function Retry({ onRetry }: { onRetry: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onRetry, 1_500);
    return () => clearTimeout(timer);
  }, [onRetry]);
  return <Splash />;
}

/**
 * Clerk's __client_uat cookie holds the last sign-in time, or 0 when signed
 * out. Good enough to show new visitors the landing page while Clerk loads.
 */
const maybeSignedIn = () => /(?:^|;\s*)__client_uat(?:_[\w-]+)?=[1-9]/.test(document.cookie);

export function ClerkGate({ publishableKey, signups, children }: { publishableKey: string; signups: boolean; children: (me: Me) => ReactNode }) {
  const dark = useDark();
  const { pathname, search } = useLocation();
  // Signed-out visitors to "/" get the landing page; every other page asks them to sign in.
  const atLanding = pathname === "/";
  // After signing in, come back to the page that was asked for (from /sign-in, the app).
  const here = pathname === "/sign-in" ? "/" : `${pathname}${search}`;
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={appearance(dark)} localization={LOCALIZATION}>
      <SessionBridge />
      <ClerkLoading>{atLanding && !maybeSignedIn() ? <Landing /> : <Splash />}</ClerkLoading>
      <ClerkFailed>
        {atLanding ? (
          <Landing />
        ) : (
          <AuthLayout>
            <Card className="w-full max-w-sm space-y-2 p-6 text-center">
              <h2 className="font-semibold">Sign-in didn't load</h2>
              <p className="text-sm text-zinc-500 dark:text-zinc-400">Something blocked the sign-in service (an ad blocker or a network filter). Allow it and reload.</p>
            </Card>
          </AuthLayout>
        )}
      </ClerkFailed>
      <Show when="signed-out">
        {atLanding ? (
          <Landing />
        ) : (
          <AuthLayout>
            <SignIn routing="hash" withSignUp={signups} fallbackRedirectUrl={here} signUpFallbackRedirectUrl={here} appearance={SIGN_IN_APPEARANCE} />
          </AuthLayout>
        )}
      </Show>
      <Show when="signed-in">
        <Account>{children}</Account>
      </Show>
    </ClerkProvider>
  );
}
