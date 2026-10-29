// Clerk sign-in for hosted Lucid. The server says whether Clerk is on and
// hands over the publishable key (GET /api/auth/config), so one build serves
// every deployment.

import { ClerkFailed, ClerkLoading, ClerkProvider, Show, SignIn, SignOutButton, useAuth } from "@clerk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { type Me, api, setTokenSource } from "./api";
import { AuthLayout, Splash } from "./pages/SignIn";
import { Card } from "./ui";

const DARK = "(prefers-color-scheme: dark)";
const subscribe = (onChange: () => void) => {
  const media = matchMedia(DARK);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
};
const useDark = () => useSyncExternalStore(subscribe, () => matchMedia(DARK).matches);

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Clerk's components in Lucid's colors (zinc + violet) and font, following the system theme. */
function appearance(dark: boolean) {
  const shared = { fontFamily: FONT, borderRadius: "0.625rem" };
  return {
    variables: dark
      ? {
          ...shared,
          colorPrimary: "#8b5cf6",
          colorPrimaryForeground: "#ffffff",
          colorBackground: "#18181b",
          colorForeground: "#fafafa",
          colorMutedForeground: "#a1a1aa",
          colorNeutral: "#fafafa",
          colorInput: "#09090b",
          colorInputForeground: "#fafafa",
          colorBorder: "#27272a",
          colorDanger: "#f43f5e",
          colorSuccess: "#10b981",
        }
      : {
          ...shared,
          colorPrimary: "#7c3aed",
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
    elements: { rootBox: "w-full flex justify-center", cardBox: "shadow-xl shadow-zinc-950/5 dark:shadow-black/40" },
  };
}

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
  const previous = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return;
    if (previous.current !== undefined && previous.current !== (userId ?? null)) {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth-config" });
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

export function ClerkGate({ publishableKey, signups, children }: { publishableKey: string; signups: boolean; children: (me: Me) => ReactNode }) {
  const dark = useDark();
  // After signing in, come back to the page that was asked for.
  const here = `${window.location.pathname}${window.location.search}`;
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={appearance(dark)}>
      <SessionBridge />
      <ClerkLoading>
        <Splash />
      </ClerkLoading>
      <ClerkFailed>
        <AuthLayout>
          <Card className="w-full max-w-sm space-y-2 p-6 text-center">
            <h2 className="font-semibold">Sign-in didn't load</h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">Something blocked the sign-in service (an ad blocker or a network filter). Allow it and reload.</p>
          </Card>
        </AuthLayout>
      </ClerkFailed>
      <Show when="signed-out">
        <AuthLayout>
          <SignIn routing="hash" withSignUp={signups} fallbackRedirectUrl={here} signUpFallbackRedirectUrl={here} />
        </AuthLayout>
      </Show>
      <Show when="signed-in">
        <Account>{children}</Account>
      </Show>
    </ClerkProvider>
  );
}
