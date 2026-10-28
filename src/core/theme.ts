// Light or dark, from settings: the app (theme) and the terminals (terminalTheme) each follow the OS or are
// set. Resolved into <html data-theme> and <html data-term-theme>, which pick the colour tokens (tokens.css).
// An interface skin (appColors, core/appColors.ts) overrides the app tokens inline, and a terminal colour
// scheme (terminalColors, core/termColors.ts) the terminal tokens.

import { isTauri } from "@tauri-apps/api/core";
import { Effect, EffectState, getCurrentWindow } from "@tauri-apps/api/window";
import type { Settings } from "../bindings/Settings";
import { skinPalette, skinTokens, terminalColorsFor } from "./appColors";
import { isMac } from "./platform";
import { store } from "./store";
import { paletteTokens, termPalette } from "./termColors";

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

/** Whether the app is dark now. */
export function appDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
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
  const skin = s.appColors;
  const colors = terminalColorsFor(s);
  const d = root.dataset;
  if (d.theme === app && d.termTheme === term && d.appColors === skin && d.termColors === colors) return;
  d.theme = app;
  d.termTheme = term;
  d.appColors = skin;
  d.termColors = colors;
  for (const [name, value] of [...skinTokens(skinPalette(skin, app)), ...paletteTokens(termPalette(colors, term))]) {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
  for (const fn of listeners) fn();
}

// the OS scheme until settings load, so the first paint is not the wrong one
apply();

/** Applies the theme from settings and keeps it current. */
export function initTheme(): void {
  apply();
  osDark.addEventListener("change", apply);
  store.select(
    (s) => [s.settings.theme, s.settings.terminalTheme, s.settings.terminalColors, s.settings.appColors] as const,
    apply,
    { equals: (a, b) => a.every((v, i) => v === b[i]) },
  );
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
  // window glass (macOS): the system's own blur behind the window (no CSS blur, nothing to download);
  // <html data-glass> lets the title bar and sidebar show it. It rests while the window is inactive.
  store.select((s) => isMac() && s.settings.windowGlass, applyGlass, { immediate: true });
}

function applyGlass(on: boolean) {
  document.documentElement.toggleAttribute("data-glass", on);
  const win = getCurrentWindow();
  const done = on
    ? win.setEffects({ effects: [Effect.Sidebar], state: EffectState.FollowsWindowActiveState })
    : win.clearEffects();
  void done.catch(() => {});
}
