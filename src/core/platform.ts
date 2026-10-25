// Which OS the app runs on (from the backend's platform_info; guessed from the user agent until then)
// and the OS conventions that follow from it.

import { call } from "./api";
import { store } from "./store";

export function isMac(): boolean {
  return store.get().platform.os === "macos";
}

export function isWindows(): boolean {
  return store.get().platform.os === "windows";
}

/** Windows build number (ConPTY quirks in xterm); undefined elsewhere or when unknown. */
export function windowsBuild(): number | undefined {
  const { os, build } = store.get().platform;
  const n = Number.parseInt(build, 10);
  return os === "windows" && Number.isFinite(n) ? n : undefined;
}

export async function initPlatform(): Promise<void> {
  const res = await call("platform_info", undefined, { quiet: true });
  if (res.ok) store.set({ platform: res.value });
  const root = document.documentElement;
  root.classList.add(`os-${store.get().platform.os}`);
}

const MAC_GLYPHS: Record<string, string> = {
  Cmd: "⌘",
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Enter: "↩",
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Tab: "⇥",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "Cmd"];

/**
 * How a shortcut reads on this OS: "CmdOrCtrl+Shift+F" is "⇧⌘F" on macOS and "Ctrl+Shift+F" on Windows.
 * Accepts the same key syntax as the keyboard registry.
 */
export function shortcutLabel(keys: string, mac = isMac()): string {
  const parts = keys.split("+").map((p) => p.trim());
  const key = parts.pop() ?? "";
  const mods = parts.map((m) => {
    if (m === "CmdOrCtrl") return mac ? "Cmd" : "Ctrl";
    if (m === "Option") return "Alt";
    return m;
  });
  if (mac) {
    mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
    return mods.map((m) => MAC_GLYPHS[m] ?? m).join("") + (MAC_GLYPHS[key] ?? key.toUpperCase());
  }
  const winKey = key === "Escape" ? "Esc" : key === "Delete" ? "Del" : key.length === 1 ? key.toUpperCase() : key;
  return [...mods, winKey].join("+");
}

/** "Finder" or "Explorer", for labels like "Show in Finder". */
export function fileManagerName(): string {
  return isMac() ? "Finder" : "Explorer";
}
