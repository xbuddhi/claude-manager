// Live sessions (WP3): keeps store.live / store.liveCwd current from the backend scan, tells the backend
// which terminal is in front (so finish notifications skip the session being watched), switches to a
// session when its notification is clicked, and provides "Close background sessions".

import { isTauri } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { LiveChanged } from "../../bindings/LiveChanged";
import type { LiveSession } from "../../bindings/LiveSession";
import { call, listen } from "../../core/api";
import { registerCommand } from "../../core/commands";
import { describeError, log } from "../../core/log";
import { isMac } from "../../core/platform";
import { type AppState, store } from "../../core/store";
import { focusLive } from "./focus";
import "./ipc";
import { closeOrphans } from "./orphans";

function sameFlat(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Publishes a scan. Entries and maps that did not change keep their objects, so the sidebar, table and search
 * (which compare by reference) only redraw for a real change.
 */
export function applyLive(live: LiveChanged): void {
  const held = store.get();
  const byId: Record<string, LiveSession> = {};
  let same = live.sessions.length === Object.keys(held.live).length;
  for (const s of live.sessions) {
    const old = held.live[s.sessionId];
    const keep = old !== undefined && sameFlat(old, s);
    byId[s.sessionId] = keep ? old : s;
    if (!keep) same = false;
  }
  store.set({
    live: same ? held.live : byId,
    liveCwd: sameFlat(held.liveCwd, live.liveCwd) ? held.liveCwd : live.liveCwd,
  });
}

/** The process of the terminal tab in front; null on Home or while it is not known. */
export function activePid(s: AppState): number | null {
  if (s.activeTerminal === null) return null;
  const t = s.terminals.find((x) => x.id === s.activeTerminal);
  return t && !t.exited ? t.pid : null;
}

/** macOS asks once for permission to show notifications; do it when the user turns them on. */
async function askNotifyPermission() {
  if (!isTauri() || !isMac()) return;
  try {
    if (!(await isPermissionGranted())) await requestPermission();
  } catch (e) {
    log.warn(`notification permission request failed: ${describeError(e)}`);
  }
}

export function mount(): void {
  void (async () => {
    let heard = false;
    await listen("live-changed", (live) => {
      heard = true;
      applyLive(live);
    });
    const res = await call("get_live", undefined, { quiet: true });
    // an event that arrived meanwhile is newer than this answer
    if (res.ok && !heard) applyLive(res.value);
  })();
  void listen("notify:clicked", ({ sessionId }) => void focusLive(sessionId));

  store.select(activePid, (pid) => void call("set_active_terminal_pid", { pid }, { quiet: true }), { immediate: true });
  store.select(
    (s) => s.settings.notify,
    (on, was) => {
      if (on && !was) void askNotifyPermission();
    },
  );

  registerCommand({ id: "live:closeOrphans", title: "Close background sessions", run: closeOrphans });
}
