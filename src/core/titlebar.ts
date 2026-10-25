// The title bar: window title and subtitle, drag region (data-tauri-drag-region="deep" in index.html; buttons
// and fields inside it stay clickable).
// Windows: the native frame and its buttons sit above it. macOS: the native lights sit over the bar
// (titleBarStyle Overlay); we keep 80px free for them, except in full screen where macOS hides them.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { $ } from "./dom";
import { describeError, log } from "./log";
import { isMac } from "./platform";
import { store } from "./store";

export function setTitle(text: string): void {
  $(".tb-name", $("#tb-title")).textContent = text;
}

/** The muted line under the title, e.g. "default · 12 sessions · 4 folders". */
export function setSubtitle(text: string): void {
  $("#tb-subtitle").textContent = text;
}

async function trackFullscreen() {
  const win = getCurrentWindow();
  const update = async () => {
    try {
      document.documentElement.classList.toggle("fullscreen", await win.isFullscreen());
    } catch (e) {
      log.warn(`isFullscreen: ${describeError(e)}`);
    }
  };
  await update();
  await win.onResized(() => void update());
}

function trackFocus() {
  const apply = (focused: boolean) => {
    document.documentElement.classList.toggle("window-inactive", !focused);
    store.set({ windowFocused: focused });
  };
  window.addEventListener("focus", () => apply(true));
  window.addEventListener("blur", () => apply(false));
  apply(document.hasFocus());
}

export async function initTitlebar(): Promise<void> {
  trackFocus();
  if (isMac()) await trackFullscreen();
}
