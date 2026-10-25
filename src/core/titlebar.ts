// The title bar: window title and subtitle, drag region (data-tauri-drag-region="deep" in index.html; buttons
// and fields inside it stay clickable), and the window buttons.
// Windows: the window has no native frame, so we draw traffic lights (close, minimize, zoom) that turn grey
// while the window is inactive. macOS: the native lights sit over the bar (titleBarStyle Overlay); we keep
// 80px free for them, except in full screen where macOS hides them.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, h } from "./dom";
import { icons } from "./icons";
import { describeError, log } from "./log";
import { isMac, isWindows } from "./platform";
import { store } from "./store";

export function setTitle(text: string): void {
  $(".tb-name", $("#tb-title")).textContent = text;
}

/** The muted line under the title, e.g. "default · 12 sessions · 4 folders". */
export function setSubtitle(text: string): void {
  $("#tb-subtitle").textContent = text;
}

type LightAction = "close" | "minimize" | "maximize";

const LIGHTS: Array<{ action: LightAction; label: string; glyph: string }> = [
  { action: "close", label: "Close", glyph: icons.close },
  { action: "minimize", label: "Minimize", glyph: icons.minus },
  { action: "maximize", label: "Zoom", glyph: icons.plus },
];

function renderLights() {
  const win = getCurrentWindow();
  const run: Record<LightAction, () => Promise<void>> = {
    close: () => win.close(),
    minimize: () => win.minimize(),
    maximize: () => win.toggleMaximize(),
  };
  const root = $("#tb-lights");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Window");
  for (const { action, label, glyph } of LIGHTS) {
    const b = h("button", { class: "tb-light", type: "button", dataset: { action }, attrs: { "aria-label": label } });
    b.innerHTML = glyph;
    b.addEventListener("click", () => run[action]().catch((e) => log.error(`window ${action}: ${describeError(e)}`)));
    root.append(b);
  }
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
  if (isWindows()) renderLights();
  if (isMac()) await trackFullscreen();
}
