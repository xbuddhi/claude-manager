// Which app window this page is: the main window ("main") or another one like it ("win-<n>", opened with
// New window or by moving tabs out). Each has its own tabs; only the main window shows the profile picker
// and takes requests from outside the app.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const MAIN_WINDOW = "main";

export function windowLabel(): string {
  if (!isTauri()) return MAIN_WINDOW;
  try {
    return getCurrentWindow().label;
  } catch {
    return MAIN_WINDOW;
  }
}

export function isMainWindow(): boolean {
  return windowLabel() === MAIN_WINDOW;
}
