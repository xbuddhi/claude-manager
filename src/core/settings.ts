// Typed mirror of the backend settings (store.settings), kept current by the `settings-changed` event.

import type { Settings } from "../bindings/Settings";
import { call, listen } from "./api";
import { keepEqual } from "./equal";
import { store } from "./store";

export function settings(): Settings {
  return store.get().settings;
}

/**
 * Puts settings in the mirror. Keys whose value did not change keep their old object, and nothing is
 * published when no key changed: a save comes back twice (the answer and the `settings-changed` echo), and
 * selectors on settings.groups and the like should not fire for either.
 */
export function applySettings(next: Settings): void {
  const merged = keepEqual(settings(), next);
  if (merged !== settings()) store.set({ settings: merged });
}

/**
 * Saves top-level keys. The mirror updates at once so the UI never waits on disk; when the backend
 * rejects the patch the mirror goes back to what the backend holds (other updates made meanwhile stay).
 * Returns whether it was saved. Features may store keys of their own (unknown keys are kept by the backend).
 */
export async function updateSettings(patch: Partial<Settings> & Record<string, unknown>): Promise<boolean> {
  const before = settings();
  applySettings({ ...before, ...patch });
  const res = await call("update_settings", { patch });
  if (res.ok) {
    applySettings(res.value);
    return true;
  }
  const current = await call("get_settings", undefined, { quiet: true });
  if (current.ok) {
    applySettings(current.value);
  } else {
    // undo only this patch's keys
    type Loose = Settings & Record<string, unknown>;
    const undone: Loose = { ...settings() };
    for (const key of Object.keys(patch)) undone[key] = (before as Loose)[key];
    applySettings(undone);
  }
  return false;
}

export async function initSettings(): Promise<void> {
  let heard = false;
  // both requests go out together; the listener is registered before the answer is applied
  const [, res] = await Promise.all([
    listen("settings-changed", (s) => {
      heard = true;
      applySettings(s);
    }),
    call("get_settings", undefined, { quiet: true }),
  ]);
  // an event that arrived meanwhile is newer than this answer
  if (res.ok && !heard) applySettings(res.value);
}
