// Light or dark, from settings: the app (theme) and the terminals (terminalTheme) each follow the OS or are
// set. Resolved into <html data-theme> and <html data-term-theme>, which pick the colour tokens (tokens.css).

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "../bindings/Settings";
import { store } from "./store";

export type Scheme = "light" | "dark";

const osDark = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

/** The app's scheme for these settings and OS preference. */
export function appScheme(s: Pick<Settings, "theme">, dark = osDark.matches): Scheme {
  return s.theme === "system" ? (dark ? "dark" : "light") : s.theme;
}

/** The terminals' scheme: their own choice, or the app's. */
export function termScheme(s: Pick<Settings, "theme" | "terminalTheme">, dark = osDark.matches): Scheme {
  return s.terminalTheme === "app" ? appScheme(s, dark) : s.terminalTheme;
}

/** Whether terminals are dark now. */
export function termDark(): boolean {
  return document.documentElement.dataset.termTheme === "dark";
}

/** Runs `fn` whenever either scheme changes. Returns the unsubscribe. */
export function onThemeChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply() {
  const s = store.get().settings;
  const root = document.documentElement;
  const app = appScheme(s);
  const term = termScheme(s);
  if (root.dataset.theme === app && root.dataset.termTheme === term) return;
  root.dataset.theme = app;
  root.dataset.termTheme = term;
  for (const fn of listeners) fn();
}

// the OS scheme until settings load, so the first paint is not the wrong one
apply();

/** Applies the theme from settings and keeps it current. */
export function initTheme(): void {
  apply();
  osDark.addEventListener("change", apply);
  store.select((s) => [s.settings.theme, s.settings.terminalTheme] as const, apply, {
    equals: (a, b) => a[0] === b[0] && a[1] === b[1],
  });
  // the native frame (macOS traffic lights, menus) follows the app's choice
  if (!isTauri()) return;
  store.select(
    (s) => s.settings.theme,
    (t) =>
      void getCurrentWindow()
        .setTheme(t === "system" ? null : t)
        .catch(() => {}),
    { immediate: true },
  );
}
