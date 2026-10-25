// Folders dropped on the window from Explorer or Finder: each one is pinned and gets a new session (start
// profile, default open mode); files are ignored. Only while the workspace is in front (a terminal tab in
// front, the profile picker or a dialog leaves the drop alone). An overlay shows while something is dragged over.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { call } from "../../core/api";
import { h } from "../../core/dom";
import { describeError, log } from "../../core/log";
import { store } from "../../core/store";
import { pin } from "./groups";
import { newSession } from "./menus";
import { S } from "./strings";

let overlay: HTMLElement | null = null;

function showOverlay(on: boolean) {
  if (on && !overlay) {
    overlay = h(
      "div",
      { class: "sb-drop", attrs: { "aria-hidden": "true" } },
      h("div", { class: "sb-drop-text" }, S.dropHint),
    );
    (document.getElementById("overlay-root") ?? document.body).append(overlay);
  } else if (!on && overlay) {
    overlay.remove();
    overlay = null;
  }
}

function accepts(): boolean {
  const s = store.get();
  return s.screen === "main" && s.activeTerminal === null && !document.querySelector(".dlg-backdrop");
}

/** Starts a session in every folder among `paths` and pins them. Returns the folders. */
export async function dropPaths(paths: readonly string[]): Promise<string[]> {
  const list = paths.slice(0, 1000);
  if (!list.length) return [];
  const res = await call("path_kinds", { paths: list });
  if (!res.ok) return [];
  const dirs = list.filter((_, i) => res.value[i] === "dir");
  for (const dir of dirs) newSession(dir);
  await pin(dirs);
  return dirs;
}

export async function initDrop(): Promise<void> {
  if (!isTauri()) return;
  let active = false;
  try {
    await getCurrentWebview().onDragDropEvent(({ payload }) => {
      switch (payload.type) {
        case "enter":
          active = payload.paths.length > 0;
          showOverlay(active && accepts());
          break;
        case "over":
          showOverlay(active && accepts());
          break;
        case "leave":
          active = false;
          showOverlay(false);
          break;
        case "drop": {
          const ok = active && accepts();
          active = false;
          showOverlay(false);
          if (ok) void dropPaths(payload.paths);
          break;
        }
      }
    });
  } catch (e) {
    log.warn(`folder drop is not available: ${describeError(e)}`);
  }
}
