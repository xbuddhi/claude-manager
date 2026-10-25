// Typed mirror of the backend settings (store.settings), kept current by the `settings-changed` event.

import type { Settings } from "../bindings/Settings";
import { call, listen } from "./api";
import { store } from "./store";

export function settings(): Settings {
  return store.get().settings;
}

/**
 * Saves top-level keys. The mirror updates at once so the UI never waits on disk; when the backend
 * rejects the patch the mirror goes back to what the backend holds. Returns whether it was saved.
 * Features may store keys of their own (unknown keys are kept by the backend).
 */
export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<boolean> {
  const before = settings();
  store.set({ settings: { ...before, ...patch } });
  const res = await call("update_settings", { patch });
  store.set({ settings: res.ok ? res.value : before });
  return res.ok;
}

export async function initSettings(): Promise<void> {
  await listen("settings-changed", (s) => store.set({ settings: s }));
  const res = await call("get_settings", undefined, { quiet: true });
  if (res.ok) store.set({ settings: res.value });
}
