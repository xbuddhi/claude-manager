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

export function applyLive(live: LiveChanged): void {
  const byId: Record<string, LiveSession> = {};
  for (const s of live.sessions) byId[s.sessionId] = s;
  store.set({ live: byId, liveCwd: live.liveCwd });
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
