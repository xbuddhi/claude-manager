// Entry of a pop-out window (src/popout.html, window label "term-<id>"): one terminal in its own window.
// It takes the terminal's output over (the backend replays its recent output first). Closing the window
// asks like closing a tab; "Move back to main window" gives the terminal back to the main window.

import "../../styles/tokens.css";
import "../../styles/base.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PtyExit } from "../../bindings/PtyExit";
import { call } from "../../core/api";
import { registerCommand } from "../../core/commands";
import { $, nextFrame } from "../../core/dom";
import { installKeyboard, modalOpen, registerShortcut } from "../../core/keyboard";
import { captureGlobalErrors, describeError, log } from "../../core/log";
import { initPlatform } from "../../core/platform";
import { initProfiles, profileName } from "../../core/profiles";
import { initSettings } from "../../core/settings";
import { store } from "../../core/store";
import { ask } from "../../ui/dialog";
import { installTooltips } from "../../ui/tooltip";
import { quotePaths, tabSub } from "./logic";
import "./pty";
import { TermView } from "./term";
import "./terminals.css";

let exited = false;
let closing = false;
let title = "Terminal";
let sub = "";

async function close() {
  if (closing) return;
  if (!exited) {
    const ok = await ask(
      `Close this terminal?\n\n${title}\n${sub}\n\nThe Claude session is saved and can be resumed later.`,
      "Close terminal",
    );
    if (!ok) return;
  }
  closing = true;
  const res = await call("pty_close_window", { kill: true });
  if (!res.ok) closing = false;
}

async function moveBack() {
  if (closing) return;
  closing = true;
  const res = await call("pty_return");
  if (!res.ok) closing = false;
}

function onExit(view: TermView, exit: PtyExit) {
  exited = true;
  if (exit.code === 127) view.note("claude not found on PATH", "error");
  view.note("[session ended — close this window, or resume it from the sidebar]");
}

async function start() {
  captureGlobalErrors();
  installTooltips();
  await Promise.all([initPlatform(), initSettings(), initProfiles()]);
  await installKeyboard();
  const win = getCurrentWindow();
  const id = Number(win.label.replace(/^term-/, ""));

  const view = new TermView($("#popout-root"), {
    onTitle: (t) => {
      title = t;
      document.title = t;
      void call("pty_set_title", { id, title: t }, { quiet: true });
    },
    menuItems: () => [
      { label: "Move back to main window", icon: "chevronLeft", disabled: exited, run: () => void moveBack() },
      { label: "Close terminal", icon: "close", danger: true, run: () => void close() },
    ],
  });
  view.open();
  new ResizeObserver(() => view.fitNow()).observe(view.pane);
  // not behind the close dialog: Enter or Esc would reach claude
  window.addEventListener("focus", () => {
    if (!modalOpen()) view.focus();
  });

  registerCommand({
    id: "tab:close",
    title: "Close Terminal",
    enabled: () => document.hasFocus(),
    run: () => close(),
  });
  registerShortcut({ id: "tab:close", keys: "CmdOrCtrl+W" });
  await win.onCloseRequested((e) => {
    // decided here; the backend destroys the window (and ends the terminal) once the user agrees
    e.preventDefault();
    void close();
  });
  void getCurrentWebview()
    .onDragDropEvent((e) => {
      if (e.payload.type !== "drop" || exited) return;
      view.paste(quotePaths(e.payload.paths, store.get().platform.os));
      view.focus();
    })
    .catch((e) => log.warn(`file drops are not available: ${describeError(e)}`));

  const list = await call("pty_list", undefined, { quiet: true });
  const info = list.ok ? list.value.find((t) => t.id === id) : undefined;
  if (info) {
    title = info.title;
    sub = tabSub(info.dir, profileName(info.profile));
    document.title = title;
    const { onOutput } = view.channel((exit) => onExit(view, exit));
    const res = await call("pty_attach", { id, onOutput }, { quiet: true });
    if (res.ok) view.bind(id);
    else onExit(view, { code: null });
  } else {
    onExit(view, { code: null });
  }

  view.setActive(true);
}

/** The window is created hidden; it is shown after the first paint, and also when starting failed. */
async function show() {
  await nextFrame();
  document.documentElement.classList.add("ready");
  await getCurrentWindow().show();
}

if (isTauri()) {
  start()
    .catch((e) => log.error(`pop-out window failed to start: ${describeError(e)}`))
    .finally(() => void show().catch((e) => log.error(`showing the window failed: ${describeError(e)}`)));
}
