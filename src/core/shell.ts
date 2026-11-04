// Behaviour of the layout shell in index.html: which screen and which area is in front, the sidebar width
// and its splitter, and the webview's own context menu (which offers "Reload" and would end every terminal).

import { button } from "../ui/button";
import { splitter } from "../ui/splitter";
import { emit } from "./bus";
import { registerCommand } from "./commands";
import { $ } from "./dom";
import { registerShortcut } from "./keyboard";
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

/** How long the peeking sidebar stays after the pointer leaves it. */
const PEEK_LINGER_MS = 280;
/** How long the pointer rests at the left edge before the sidebar slides in (a pointer passing by does not). */
const PEEK_DELAY_MS = 140;

/**
 * Whether something opened over the window (a menu, popover or dialog) holds the peeking sidebar in. The
 * tooltip and the toast stack stay in the overlay root once created, so they never count.
 */
export function overlayHoldsPeek(overlay: Element): boolean {
  return [...overlay.children].some((c) => !c.matches(".tooltip, .toast-stack"));
}

/**
 * Hidden sidebar: hiding slides it out to the left while the content grows into its place. While hidden,
 * the pointer at the workspace's left edge slides it in over the content ("peek"), and it slides away once
 * the pointer has left it.
 */
function initSidebarHiding() {
  const root = document.documentElement;
  const side = $("#sidebar-slot");
  const edge = document.createElement("div");
  edge.id = "sidebar-edge";
  $("#workspace").prepend(edge);
  let linger: ReturnType<typeof setTimeout> | undefined;
  /** Puts the sidebar back into the layout without animating the switch itself. */
  const settle = () => {
    root.classList.add("sidebar-instant");
    root.classList.remove("sidebar-peek", "sidebar-peek-out");
    void side.offsetWidth;
    requestAnimationFrame(() => root.classList.remove("sidebar-instant"));
  };
  const peek = (on: boolean) => {
    clearTimeout(linger);
    linger = undefined;
    if (on) {
      root.classList.remove("sidebar-peek-out");
      root.classList.add("sidebar-peek");
    } else if (root.classList.contains("sidebar-peek")) {
      root.classList.add("sidebar-peek-out");
    }
  };
  side.addEventListener("animationend", (e) => {
    if (e.target === side && root.classList.contains("sidebar-peek-out")) settle();
  });
  // the pointer resting on the left edge, or on the show-sidebar button, slides it in: it must rest a moment
  // (a pointer passing by does not), and coming back while it slides away brings it back at once
  let delay: ReturnType<typeof setTimeout> | undefined;
  const peekOnRest = (target: HTMLElement) => {
    target.addEventListener("pointerenter", () => {
      clearTimeout(delay);
      if (!root.classList.contains("sidebar-hidden")) return;
      if (root.classList.contains("sidebar-peek-out")) return peek(true);
      delay = setTimeout(() => peek(true), PEEK_DELAY_MS);
    });
    target.addEventListener("pointerleave", () => clearTimeout(delay));
  };
  peekOnRest(edge);
  // while peeking, the pointer's position decides: over the sidebar (or just beside it) keeps it, anywhere
  // else hides it after a moment. Enter/leave events alone miss a pointer that touches the edge and leaves.
  window.addEventListener("pointermove", (e) => {
    if (!root.classList.contains("sidebar-peek") || root.classList.contains("sidebar-peek-out")) return;
    // where the sidebar ends once in (not its animated position while it slides)
    const right = $("#workspace").getBoundingClientRect().left + side.offsetWidth;
    const near = e.clientX <= right + 16;
    if (near) {
      clearTimeout(linger);
      linger = undefined;
    } else if (linger === undefined) {
      linger = setTimeout(() => {
        linger = undefined;
        // a menu or dialog opened from the sidebar keeps it out (a tooltip or a toast does not)
        if (overlayHoldsPeek($("#overlay-root"))) return;
        peek(false);
      }, PEEK_LINGER_MS);
    }
  });

  const toggle = () => void updateSettings({ sidebarHidden: !settings().sidebarHidden });
  registerCommand({
    id: "sidebar:toggle",
    title: "Show or hide the sidebar",
    enabled: () => store.get().screen === "main",
    run: toggle,
  });
  registerShortcut({ id: "sidebar:toggle", keys: ["CmdOrCtrl+S", "CmdOrCtrl+B"] });

  // in the card head while the sidebar is hidden
  const show = button({ icon: "sidebar", kind: "plain", title: "Show sidebar  (Ctrl+S)", onClick: toggle });
  show.id = "sidebar-show";
  $("#card-head").prepend(show);
  // resting on it previews the sidebar (the click keeps it)
  peekOnRest(show);

  // the tabs sit in the content column in both styles (index.html), so the sidebar runs the full height beside
  // them and a tab joins its own card (Classic hides the sidebar while a terminal is in front: the tabs then
  // span the window). Docked keeps the sidebar beside terminals too, and has no Home tab.
  store.select(
    (s) => s.settings.sidebarStyle,
    (style) => {
      const docked = style === "docked";
      root.classList.toggle("layout-docked", docked);
      root.classList.toggle("layout-classic", !docked);
    },
    { immediate: true },
  );
  store.select(
    (s) => s.settings.sidebarHidden,
    (hidden) => {
      // shown again while peeking: it is already on screen, so it just stays
      if (!hidden && root.classList.contains("sidebar-peek")) settle();
      root.classList.toggle("sidebar-hidden", hidden);
    },
    { immediate: true },
  );

  // Docked: the sidebar is home. Picking anything in it brings that project's sessions back in front of a
  // terminal (there is no Home tab).
  side.addEventListener("click", (e) => {
    if (!root.classList.contains("layout-docked") || store.get().activeTerminal === null) return;
    if ((e.target as Element).closest(".list-row")) emit("terminal:show", { id: null });
  });
}

export function initShell(): void {
  suppressContextMenu();
  initSidebarHiding();

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
