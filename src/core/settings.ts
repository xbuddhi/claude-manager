// Typed mirror of the backend settings (store.settings), kept current by the `settings-changed` event.

import type { Settings } from "../bindings/Settings";
import { call, listen } from "./api";
import { store } from "./store";

export function settings(): Settings {
  return store.get().settings;
}

/**
 * Saves top-level keys. The mirror updates at once so the UI never waits on disk; when the backend
 * rejects the patch the mirror goes back to what the backend holds (other updates made meanwhile stay).
 * Returns whether it was saved. Features may store keys of their own (unknown keys are kept by the backend).
 */
export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<boolean> {
  const before = settings();
  store.set({ settings: { ...before, ...patch } });
  const res = await call("update_settings", { patch });
  if (res.ok) {
    store.set({ settings: res.value });
    return true;
  }
  const current = await call("get_settings", undefined, { quiet: true });
  if (current.ok) {
    store.set({ settings: current.value });
  } else {
    // undo only this patch's keys
    type Loose = Settings & Record<string, unknown>;
    const undone: Loose = { ...settings() };
    for (const key of Object.keys(patch)) undone[key] = (before as Loose)[key];
    store.set({ settings: undone });
  }
  return false;
}

export async function initSettings(): Promise<void> {
  await listen("settings-changed", (s) => store.set({ settings: s }));
  const res = await call("get_settings", undefined, { quiet: true });
  if (res.ok) store.set({ settings: res.value });
}
