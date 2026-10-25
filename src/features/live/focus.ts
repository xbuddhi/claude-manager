// "Switch to running session": its tab in the app first, else the window it runs in (backend).

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call } from "../../core/api";
import { emit } from "../../core/bus";
import { describeError, log } from "../../core/log";
import { store, type TermInfo } from "../../core/store";
import "./ipc";

/** The open tab the session runs in: its claude (or the shim that started it) is the session's process or an ancestor. */
export function tabFor(sessionId: string, ancestors: number[], terminals: TermInfo[]): TermInfo | null {
  const open = terminals.filter((t) => !t.exited);
  return (
    open.find((t) => t.pid !== null && ancestors.includes(t.pid)) ??
    // a tab whose process is not known yet, started for this very session
    open.find((t) => t.pid === null && t.sessionId === sessionId) ??
    null
  );
}

async function showWindow() {
  if (!isTauri()) return;
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch (e) {
    log.error(`could not show the window: ${describeError(e)}`);
  }
}

export async function focusLive(sessionId: string): Promise<boolean> {
  if (!store.get().live[sessionId]) return false;
  if (store.get().terminals.some((t) => !t.exited)) {
    const chain = await call("live_ancestors", { sessionId }, { quiet: true });
    const tab = tabFor(sessionId, chain.ok ? chain.value : [], store.get().terminals);
    if (tab) {
      emit("terminal:show", { id: tab.id });
      await showWindow();
      return true;
    }
  }
  const res = await call("focus_live", { sessionId }, { quiet: true });
  return res.ok && res.value;
}
