// Remembers what the dashboard last showed, per account, in this browser. A
// reload then paints at once from it and refreshes in the background, instead
// of waiting on a round trip to the server for every list.

import { type DehydratedState, type QueryClient, dehydrate, hydrate, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

const STORAGE_KEY = "lucid.cache.v1";
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_CHARS = 1_500_000;
/** Small, often-shown lists. Run details and Arena are left out: bigger, and opened on purpose. */
const KEPT = new Set(["me", "connect", "keys", "overview", "issues", "runs", "syncs"]);

type Saved = { owner: string; savedAt: number; state: DehydratedState };

function restore(client: QueryClient, owner: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Saved | null;
    if (!saved) return;
    // Another account's data never shows, even for a moment.
    if (saved.owner !== owner || Date.now() - saved.savedAt > MAX_AGE_MS) return localStorage.removeItem(STORAGE_KEY);
    hydrate(client, saved.state);
  } catch {
    // Storage blocked or unreadable: start empty, as before.
  }
}

function keepSaving(client: QueryClient, owner: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    try {
      const state = dehydrate(client, { shouldDehydrateQuery: (query) => query.state.status === "success" && KEPT.has(String(query.queryKey[0])) });
      const text = JSON.stringify({ owner, savedAt: Date.now(), state } satisfies Saved);
      if (text.length <= MAX_CHARS) localStorage.setItem(STORAGE_KEY, text);
    } catch {
      // Full or blocked storage only costs the head start.
    }
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    clearTimeout(timer);
    timer = setTimeout(save, 1_000);
  });
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/** On sign-out: nothing of this account stays behind in the browser. */
export function forgetCache() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, then.
  }
}

/**
 * Restores this account's saved lists before anything below the caller asks
 * for them (so it runs during render, once per account), then keeps saving.
 */
export function useAccountCache(owner: string | null) {
  const client = useQueryClient();
  const restored = useRef<string | null>(null);
  if (owner && restored.current !== owner) {
    restored.current = owner;
    restore(client, owner);
  }
  useEffect(() => (owner ? keepSaving(client, owner) : undefined), [client, owner]);
}
