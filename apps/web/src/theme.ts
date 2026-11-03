// Light by default, dark when you pick it. The choice lives in this browser;
// index.html applies it before the first paint, so the page never flashes.

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "lucid.theme";
/** The browser bar's colour, matching each theme's page. */
const BAR: Record<Theme, string> = { light: "#f7f7f5", dark: "#09090b" };

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const listeners = new Set<() => void>();

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR[theme]);
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: it lasts until the page reloads.
  }
  apply(theme);
  for (const listener of listeners) listener();
}

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

const current = (): Theme => (document.documentElement.classList.contains("dark") ? "dark" : "light");

export const useTheme = () => useSyncExternalStore(subscribe, current);

// In case index.html's script was blocked.
apply(stored());
