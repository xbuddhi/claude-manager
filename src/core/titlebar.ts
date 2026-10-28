// The title bar: window title and subtitle, drag region (data-tauri-drag-region="deep" in index.html; buttons
// and fields inside it stay clickable).
// Windows: no native frame (Windows 10 cannot colour it to match), so we draw Windows-style minimize,
// maximize/restore and close buttons at the right. macOS: the native lights sit over the bar
// (titleBarStyle Overlay); we keep 92px free for them, except in full screen where macOS hides them.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { $, h } from "./dom";
import { type IconSpec, iconNode } from "./icons";
import { describeError, log } from "./log";
import { isMac, isWindows } from "./platform";
import { store } from "./store";

export function setTitle(text: string): void {
  $(".tb-name", $("#tb-title")).textContent = text;
}

/** One icon-and-count item of the subtitle ("💬 113"). */
export interface SubtitleItem {
  icon: IconSpec;
  text: string;
}

/**
 * The muted line under the title: plain text ("Choose a profile"), or icon-and-count items with `tip`
 * saying the same in words (shown on hover and read by screen readers).
 */
export function setSubtitle(content: string | readonly SubtitleItem[], tip?: string): void {
  const el = $("#tb-subtitle");
  if (typeof content === "string") el.textContent = content;
  else el.replaceChildren(...content.map((i) => h("span", { class: "tb-sub-item" }, iconNode(i.icon), i.text)));
  if (tip) {
    el.dataset.tip = tip;
    el.setAttribute("aria-label", tip);
  } else {
    delete el.dataset.tip;
    el.removeAttribute("aria-label");
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
  const hidden = () => document.documentElement.classList.toggle("page-hidden", document.hidden);
  document.addEventListener("visibilitychange", hidden);
  hidden();
}

const GLYPH = {
  minimize: `<path d="M0.5 5.5h10"/>`,
  maximize: `<rect x="0.5" y="0.5" width="10" height="10"/>`,
  restore: `<path d="M2.5 2.5v-2h8v8h-2"/><rect x="0.5" y="2.5" width="8" height="8"/>`,
  close: `<path d="M0.5 0.5l10 10M10.5 0.5l-10 10"/>`,
};
const glyph = (body: string) => `<svg viewBox="0 0 11 11" width="10" height="10" aria-hidden="true">${body}</svg>`;

/** Windows caption buttons: 46px wide, full bar height, close turns red on hover (as in Windows 11). */
async function renderCaption() {
  const win = getCurrentWindow();
  const root = $("#tb-caption");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Window");
  const make = (cls: string, label: string, body: string, run: () => Promise<void>) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `tb-cap ${cls}`;
    b.setAttribute("aria-label", label);
    b.innerHTML = glyph(body);
    b.addEventListener("click", () => run().catch((e) => log.error(`window ${label}: ${describeError(e)}`)));
    root.append(b);
    return b;
  };
  make("tb-min", "Minimize", GLYPH.minimize, () => win.minimize());
  const max = make("tb-max", "Maximize", GLYPH.maximize, () => win.toggleMaximize());
  make("tb-close", "Close", GLYPH.close, () => win.close());
  const update = async () => {
    try {
      const on = await win.isMaximized();
      max.innerHTML = glyph(on ? GLYPH.restore : GLYPH.maximize);
      max.setAttribute("aria-label", on ? "Restore" : "Maximize");
      document.documentElement.classList.toggle("maximized", on);
    } catch (e) {
      log.warn(`isMaximized: ${describeError(e)}`);
    }
  };
  await update();
  await win.onResized(() => void update());
}

export async function initTitlebar(): Promise<void> {
  trackFocus();
  if (isWindows()) await renderCaption();
  if (isMac()) await trackFullscreen();
}
