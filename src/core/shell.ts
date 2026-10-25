// Behaviour of the layout shell in index.html: which screen and which area is in front, the sidebar width
// and its splitter, and the webview's own context menu (which offers "Reload" and would end every terminal).

import { splitter } from "../ui/splitter";
import { $ } from "./dom";
import { settings, updateSettings } from "./settings";
import { store } from "./store";

const SIDEBAR_MIN = 240;
/** Width the card keeps when the sidebar is dragged wide. */
const CARD_MIN = 460;

function sidebarWidth(): number {
  return $("#sidebar-slot").getBoundingClientRect().width || settings().sidebarWidth;
}

function setSidebarWidth(px: number) {
  document.documentElement.style.setProperty("--sidebar-w", `${px}px`);
}

/** Text fields keep their menu (cut/copy/paste); everywhere else the webview's default menu is suppressed. */
function suppressContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    const t = e.target as HTMLElement | null;
    const editable = t?.closest("input, textarea:not(.xterm-helper-textarea), [contenteditable='true']");
    if (!editable) e.preventDefault();
  });
}

export function initShell(): void {
  suppressContextMenu();

  store.select((s) => s.settings.sidebarWidth, setSidebarWidth, { immediate: true });
  splitter({
    el: $("#workspace-splitter"),
    label: "Resize sidebar",
    get: sidebarWidth,
    min: SIDEBAR_MIN,
    max: () => Math.max(SIDEBAR_MIN, $("#workspace").clientWidth - 10 - CARD_MIN),
    onResize: setSidebarWidth,
    onCommit: (px) => void updateSettings({ sidebarWidth: px }),
  });

  // a terminal tab in front replaces the workspace (see shell.css)
  store.select(
    (s) => s.activeTerminal !== null,
    (terminal) => document.documentElement.classList.toggle("mode-terminal", terminal),
    { immediate: true },
  );
  store.select(
    (s) => s.screen,
    (screen) => {
      $("#picker-root").hidden = screen !== "picker";
      $("#main").hidden = screen !== "main";
    },
    { immediate: true },
  );
}
