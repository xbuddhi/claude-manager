// Terminal tabs: claude sessions in xterms over PTYs, in tabs next to the pinned Home tab (Windows app:
// ClaudeManager.ps1 "terminal tabs"). Handles the bus events "launch" (a tab here, or a terminal window of
// the OS per settings.openIn) and "terminal:show", the tab commands and keys, file drops, and the
// questions asked when the app or this window closes while terminals run.
//
// Every app window has its own tabs, like browser windows (core/window.ts). Tabs move between windows
// (dragged out of the strip, or "Move to ..." in their menu); their terminals keep running and the window
// they go to takes them over. Opening a session that is open in another window brings that tab forward.
// Terminals outlive the page: after a reload the tabs come back from pty_list (nothing is killed).

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Point } from "../../bindings/Point";
import type { PtyExit } from "../../bindings/PtyExit";
import type { PtyInfo } from "../../bindings/PtyInfo";
import type { QuitDecision } from "../../bindings/QuitDecision";
import type { WindowDecision } from "../../bindings/WindowDecision";
import type { WindowInfo } from "../../bindings/WindowInfo";
import { call, listen } from "../../core/api";
import { emit, type LaunchRequest, on } from "../../core/bus";
import { registerCommand } from "../../core/commands";
import { $ } from "../../core/dom";
import { leaf, plural } from "../../core/format";
import { modalOpen, registerShortcut } from "../../core/keyboard";
import { describeError, log } from "../../core/log";
import { settleIn } from "../../core/motion";
import { profileName } from "../../core/profiles";
import { settings } from "../../core/settings";
import { store, type TermInfo } from "../../core/store";
import { isMainWindow, MAIN_WINDOW, windowLabel } from "../../core/window";
import { ask, choose } from "../../ui/dialog";
import { type MenuItem, showMenu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { refreshIndex } from "../index-data/api";
import { copyText, folderLabel, openFolder, openInCode } from "../os/api";
import { startProfile } from "../profiles/api";
import { newSessionFromHome } from "../sessions/api";
import { defaultTitle, quotePaths, tabSub } from "./logic";
import "./pty";
import { Strip } from "./tabs";
import { TermView } from "./term";
import "./terminals.css";

/** A tab with its xterm. Presentation-only fields stay here, not in the store. */
interface Tab extends TermInfo {
  view: TermView;
  /** Closed (or moved to another window) while its terminal was still starting. */
  closing: boolean;
}

const tabs: Tab[] = [];
let active: Tab | null = null; // null = Home
let nextId = 1;
let strip: Strip;
let panes: HTMLElement;

/** Mirrors the tabs into the store for other features (and the shell, which swaps workspace and terminals). */
function publish() {
  store.set({
    terminals: tabs.map(({ id, ptyId, pid, title, sub, dir, profile, sessionId, exited }) => ({
      id,
      ptyId,
      pid,
      title,
      sub,
      dir,
      profile,
      sessionId,
      exited,
    })),
    activeTerminal: active?.id ?? null,
  });
}

function renderStrip() {
  strip.render(tabs, active?.id ?? null);
}

function showTab(tab: Tab | null) {
  const prev = active;
  active = tab;
  for (const t of tabs) t.view.pane.hidden = t !== tab;
  publish(); // the shell swaps the workspace and the terminals synchronously
  renderStrip();
  if (prev && prev !== tab) prev.view.setActive(false);
  if (tab) {
    tab.view.setActive(true);
    if (prev !== tab) settleIn(tab.view.pane, 0);
  }
}

/** Removes a tab (its terminal keeps running unless the caller ends it). */
function removeTab(tab: Tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.closing = true;
  tabs.splice(i, 1);
  if (active === tab) {
    // the next tab to the right, else the one to the left, else Home
    active = null;
    showTab(tabs[i] ?? tabs[i - 1] ?? null);
  } else {
    publish();
    renderStrip();
  }
  tab.view.dispose();
}

/** Close terminal: asks first while it runs ("The Claude session is saved and can be resumed later."). */
async function closeTab(tab: Tab, confirm = true) {
  if (tab.closing) return;
  if (confirm && !tab.exited) {
    const ok = await ask(
      `Close this terminal?\n\n${tab.title}\n${tab.sub}\n\nThe Claude session is saved and can be resumed later.`,
      "Close terminal",
    );
    if (!ok || tab.closing) return;
  }
  // also for an exited tab: the backend may not have dropped it yet
  if (tab.ptyId !== null) void call("pty_kill", { id: tab.ptyId }, { quiet: true });
  removeTab(tab);
}

/** Closes several tabs with one question for the ones still running. */
async function closeTabs(list: Tab[]) {
  const running = list.filter((t) => !t.exited && !t.closing);
  if (running.length) {
    const ok = await ask(
      `Close ${running.length} terminal${running.length === 1 ? "" : "s"}?\n\nThe Claude sessions are saved and can be resumed later.`,
      "Close terminals",
    );
    if (!ok) return;
  }
  for (const t of list) await closeTab(t, false);
}

const movable = (t: Tab) => t.ptyId !== null && !t.exited && !t.closing;

/**
 * Moves tabs to window `to`, else to the window under the screen point `at`, else to a new window. Their
 * terminals keep running; the other window takes them over. Another window left with no tabs closes, like
 * a browser window whose last tab was dragged out.
 */
async function moveTabs(list: Tab[], where: { to?: string; at?: Point } = {}) {
  const going = list.filter(movable);
  if (!going.length) return;
  const res = await call("pty_move", { ids: going.map((t) => t.ptyId as number), ...where });
  if (!res.ok) return;
  for (const t of going) if (!t.closing) removeTab(t);
  if (!tabs.length && !isMainWindow()) void getCurrentWindow().close();
}

/** "main window", "Window 2", ... */
function windowName(w: WindowInfo): string {
  return w.label === MAIN_WINDOW ? "main window" : `Window ${w.number}`;
}

async function tabMenu(tab: Tab): Promise<MenuItem[]> {
  const wins = await call("window_list", undefined, { quiet: true });
  const others = wins.ok ? wins.value.filter((w) => !w.current) : [];
  const i = tabs.indexOf(tab);
  const right = tabs.slice(i + 1);
  const rest = tabs.filter((t) => t !== tab);
  const canMove = movable(tab);
  const items: MenuItem[] = [
    { label: "Open folder in VS Code", icon: "vscode", run: () => void openInCode([tab.dir]) },
    { label: folderLabel(), icon: "folder", run: () => void openFolder(tab.dir) },
    { label: "Copy folder path", icon: "copy", run: () => void copyText(tab.dir) },
    { kind: "separator" },
  ];
  if (tab.sessionId) {
    const sessionId = tab.sessionId;
    items.push({
      label: "Fork as a new session",
      icon: "fork",
      run: () =>
        emit("launch", { dir: tab.dir, profile: tab.profile, mode: "embed", resume: { sessionId, fork: true } }),
    });
  }
  items.push(
    { label: "Move to new window", icon: "popout", disabled: !canMove, run: () => void moveTabs([tab]) },
    ...others.map(
      (w): MenuItem => ({
        label: `Move to ${windowName(w)}`,
        icon: "attach",
        detail: plural(w.terminals, "tab"),
        disabled: !canMove,
        run: () => void moveTabs([tab], { to: w.label }),
      }),
    ),
    { kind: "separator" },
    { label: "Close terminal", icon: "close", danger: true, shortcut: "CmdOrCtrl+W", run: () => void closeTab(tab) },
    { label: "Close other tabs", disabled: !rest.length, run: () => void closeTabs(rest) },
    { label: "Close tabs to the right", disabled: !right.length, run: () => void closeTabs(right) },
  );
  return items;
}

/** Moves a tab one place left or right (Ctrl+Shift+PageUp / PageDown, as in a browser). */
function shiftTab(tab: Tab | null, by: -1 | 1) {
  if (!tab) return;
  const i = tabs.indexOf(tab);
  const j = i + by;
  if (i < 0 || j < 0 || j >= tabs.length) return;
  reorder(tab, j);
}

/** Puts a tab at index `to` of the strip. */
function reorder(tab: Tab, to: number) {
  const i = tabs.indexOf(tab);
  if (i < 0 || i === to) return;
  tabs.splice(i, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab);
  publish();
  renderStrip();
}

/** The terminal's own lines when it ends: why, if it failed to start claude. */
function onExit(tab: Tab, exit: PtyExit) {
  if (tab.closing) return;
  tab.exited = true;
  tab.pid = null;
  if (exit.code === 127) tab.view.note("claude not found on PATH", "error");
  tab.view.note("[session ended — close this tab, or resume it from the sidebar]");
  publish();
  renderStrip();
  void refreshIndex();
}

function newTab(info: Pick<TermInfo, "title" | "dir" | "profile" | "sessionId">): Tab {
  const id = nextId++;
  const view = new TermView(panes, {
    onTitle: (title) => setTitle(tab, title),
    menuItems: () => [
      { label: "Move to new window", icon: "popout", disabled: !movable(tab), run: () => void moveTabs([tab]) },
      { label: "Close terminal", icon: "close", danger: true, run: () => void closeTab(tab) },
    ],
  });
  const tab: Tab = {
    id,
    ptyId: null,
    pid: null,
    title: info.title,
    sub: tabSub(info.dir, profileName(info.profile)),
    dir: info.dir,
    profile: info.profile,
    sessionId: info.sessionId,
    exited: false,
    view,
    closing: false,
  };
  tabs.push(tab);
  return tab;
}

function setTitle(tab: Tab, title: string) {
  if (tab.closing || title === tab.title) return;
  tab.title = title;
  strip.setTitle(tab.id, title);
  publish();
  if (tab.ptyId !== null) void call("pty_set_title", { id: tab.ptyId, title }, { quiet: true });
}

/** Puts a new tab in front and opens its xterm (it measures a visible pane). */
function openInFront(tab: Tab) {
  const prev = active;
  active = tab;
  for (const t of tabs) t.view.pane.hidden = t !== tab;
  publish();
  tab.view.open();
  prev?.view.setActive(false);
  showTab(tab);
}

// ---------- launching ----------

function launch(req: LaunchRequest) {
  const mode = req.shellOnly ? "external" : (req.mode ?? settings().openIn);
  const profile = req.profile ?? startProfile() ?? undefined;
  if (mode === "external") {
    void call("launch_external", {
      dir: req.dir,
      profile,
      sessionId: req.resume?.sessionId,
      fork: req.resume?.fork ?? false,
      shellOnly: req.shellOnly ?? false,
    });
    return;
  }
  if (!profile) {
    toast("No Claude Code profile was found.", { kind: "error" });
    return;
  }
  const resume = req.resume;
  if (resume && !resume.fork) {
    // already open here? go to it
    const open = tabs.find((t) => t.sessionId === resume.sessionId && !t.exited);
    if (open) return showTab(open);
    // open in another window: that window comes forward with it (two tabs on one session would clash)
    void call("pty_focus_session", { sessionId: resume.sessionId }, { quiet: true }).then((res) => {
      if (!(res.ok && res.value)) openTab(req, profile);
    });
    return;
  }
  openTab(req, profile);
}

function openTab(req: LaunchRequest, profile: string) {
  const resume = req.resume;
  const tab = newTab({
    title: defaultTitle(resume, req.label),
    dir: req.dir,
    profile,
    sessionId: resume && !resume.fork ? resume.sessionId : null,
  });
  openInFront(tab);
  void start(tab, req);
}

async function start(tab: Tab, req: LaunchRequest) {
  const { onOutput } = tab.view.channel((exit) => onExit(tab, exit));
  const common = { profile: tab.profile, dir: tab.dir, title: tab.title, ...tab.view.size, onOutput };
  const res = req.resume
    ? await call(
        "pty_resume",
        { sessionId: req.resume.sessionId, fork: req.resume.fork ?? false, ...common },
        { quiet: true },
      )
    : await call("pty_new", common, { quiet: true });
  if (!res.ok) {
    tab.exited = true;
    tab.view.note(res.error.message, "error");
    publish();
    renderStrip();
    return;
  }
  // closed while it was starting: end it now, nothing else will
  if (tab.closing) {
    void call("pty_kill", { id: res.value.id }, { quiet: true });
    return;
  }
  bindTab(tab, res.value);
}

function bindTab(tab: Tab, info: PtyInfo) {
  tab.ptyId = info.id;
  tab.pid = info.pid;
  tab.view.bind(info.id);
  publish();
  renderStrip();
}

/** Takes a running terminal over (after a reload, or moved here from another window). */
async function adopt(info: PtyInfo, front: boolean): Promise<void> {
  if (tabs.some((t) => t.ptyId === info.id)) return;
  const tab = newTab({ title: info.title, dir: info.dir, profile: info.profile, sessionId: info.sessionId });
  if (front) openInFront(tab);
  else {
    tab.view.pane.hidden = true;
    // xterm opens on a hidden pane and fits once shown
    tab.view.open();
    publish();
    renderStrip();
  }
  const { onOutput } = tab.view.channel((exit) => onExit(tab, exit));
  const res = await call("pty_attach", { id: info.id, onOutput }, { quiet: true });
  if (!res.ok) {
    removeTab(tab);
    return;
  }
  if (tab.closing) return;
  bindTab(tab, res.value);
}

/**
 * Terminals this window had open come back as tabs (after a reload), Home staying in front; the main window
 * also takes terminals whose window is gone. A window opened for moved tabs shows the first one.
 */
async function restore() {
  const res = await call("pty_list", undefined, { quiet: true });
  if (!res.ok) return;
  const me = windowLabel();
  const main = me === MAIN_WINDOW;
  for (const info of res.value) {
    if (info.window === me || (main && info.window === null)) await adopt(info, false);
  }
  const first = tabs[0];
  if (!main && first && !active) showTab(first);
}

/** Terminals moved here from another window, the first in front. */
async function takeMoved(ids: number[]) {
  const res = await call("pty_list", undefined, { quiet: true });
  if (!res.ok) return;
  let front = true;
  for (const id of ids) {
    const info = res.value.find((t) => t.id === id);
    if (!info) continue;
    await adopt(info, front);
    front = false;
  }
}

// ---------- commands ----------

/** Next/previous tab, Home included, wrapping around. */
function cycle(dir: 1 | -1) {
  const order: Array<Tab | null> = [null, ...tabs];
  const i = order.indexOf(active);
  const next = order[(i + dir + order.length) % order.length];
  if (next !== undefined && next !== active) showTab(next);
}

/** Cmd/Ctrl+1..9: Home is the first tab, 9 is always the last one (as in a browser). */
function selectNth(n: number) {
  const order: Array<Tab | null> = [null, ...tabs];
  const next = n === 9 ? order[order.length - 1] : order[n - 1];
  if (next !== undefined) showTab(next);
}

/** New session (Cmd/Ctrl+T): in the active tab's folder, else the folder selected in the sidebar. */
function newSession() {
  if (active) {
    emit("launch", { dir: active.dir, profile: active.profile, mode: "embed" });
    return;
  }
  // Home: the sessions view decides (selected session's folder, folder picker for a group)
  if (newSessionFromHome()) return;
  const sel = store.get().sidebarSelection;
  if (sel?.kind === "folder" && sel.path) {
    emit("launch", { dir: sel.path });
    return;
  }
  const folders = sel?.kind === "group" ? (sel.folders ?? []) : [];
  if (folders.length === 1 && folders[0]) {
    emit("launch", { dir: folders[0] });
    return;
  }
  if (folders.length > 1) {
    void showMenu(
      [
        { kind: "section", label: `Start in which folder of '${sel?.name ?? ""}'?` },
        ...folders.map((dir) => ({
          label: leaf(dir),
          icon: "folder" as const,
          detail: dir,
          run: () => emit("launch", { dir }),
        })),
      ],
      { at: { x: Math.max(16, window.innerWidth / 2 - 160), y: 96 }, label: "Start in folder" },
    );
    return;
  }
  toast("Select a folder in the sidebar first.");
}

/** Only for the window in front: macOS menu shortcuts reach every window of the app. */
const focused = () => document.hasFocus();

function registerCommands() {
  registerCommand({
    id: "tab:close",
    title: "Close Tab",
    enabled: () => active !== null && focused(),
    run: () => {
      if (active) void closeTab(active);
    },
  });
  registerCommand({ id: "tab:next", title: "Next Tab", enabled: focused, run: () => cycle(1) });
  registerCommand({ id: "tab:prev", title: "Previous Tab", enabled: focused, run: () => cycle(-1) });
  registerCommand({ id: "session:new", title: "New Session", enabled: focused, run: newSession });
  // the tray's "New session": the backend raises the window first, but a tray click leaves the focus with
  // the taskbar, so it must not wait for document.hasFocus()
  registerCommand({ id: "tray:new-session", title: "New Session", run: newSession });
  // Ctrl+W and Ctrl+T mean something to claude (delete word, task list): on Windows they stay with the
  // terminal while it has focus; the Cmd versions on macOS always reach the app
  registerShortcut({ id: "tab:close", keys: "CmdOrCtrl+W" });
  registerShortcut({ id: "session:new", keys: "CmdOrCtrl+T" });
  registerShortcut({ id: "tab:next", keys: ["Ctrl+Tab", "Cmd+Shift+]"], inTerminal: true });
  registerShortcut({ id: "tab:prev", keys: ["Ctrl+Shift+Tab", "Cmd+Shift+["], inTerminal: true });
  registerCommand({ id: "tab:moveLeft", title: "Move Tab Left", enabled: focused, run: () => shiftTab(active, -1) });
  registerCommand({ id: "tab:moveRight", title: "Move Tab Right", enabled: focused, run: () => shiftTab(active, 1) });
  registerShortcut({ id: "tab:moveLeft", keys: "CmdOrCtrl+Shift+PageUp", inTerminal: true });
  registerShortcut({ id: "tab:moveRight", keys: "CmdOrCtrl+Shift+PageDown", inTerminal: true });
  registerCommand({
    id: "tab:moveToNewWindow",
    title: "Move Tab to New Window",
    enabled: () => active !== null && focused(),
    run: () => {
      if (active) void moveTabs([active]);
    },
  });
  for (let n = 1; n <= 9; n++) {
    registerCommand({ id: `tab:select${n}`, title: `Tab ${n}`, enabled: focused, run: () => selectNth(n) });
    registerShortcut({ id: `tab:select${n}`, keys: `CmdOrCtrl+${n}`, inTerminal: true });
  }
}

// ---------- quit while terminals run ----------

async function onCloseRequested(n: number) {
  const decision = await choose<QuitDecision>(
    `${n} terminal${n === 1 ? " is" : "s are"} still open inside the app\nKeep running in the background? Claude can keep working, and they come back as tabs the next time you open the app. Closing them ends them; the sessions stay saved and can be resumed.`,
    [
      { id: "cancel", label: "Cancel" },
      { id: "close", label: "Close terminals", kind: "danger" },
      { id: "keep", label: "Keep running", kind: "primary" },
    ],
    { cancel: "cancel", primary: "keep", kind: "warning" },
  );
  await call("app_quit_decision", { decision });
}

/** This window closes while other windows stay: its running terminals move to another window or end. */
async function onWindowCloseRequested(n: number) {
  const decision = await choose<WindowDecision>(
    `${n} terminal${n === 1 ? " is" : "s are"} open in this window\nMove ${n === 1 ? "it" : "them"} to another window, or close ${n === 1 ? "it" : "them"}? Closing ends ${n === 1 ? "it" : "them"}; the sessions stay saved and can be resumed.`,
    [
      { id: "cancel", label: "Cancel" },
      { id: "close", label: "Close terminals", kind: "danger" },
      { id: "move", label: "Move to other window", kind: "primary" },
    ],
    { cancel: "cancel", primary: "move", kind: "warning" },
  );
  await call("window_close_decision", { decision });
}

/** Files dropped while a terminal tab is in front are pasted as shell-quoted paths. */
function installDrops() {
  getCurrentWebview()
    .onDragDropEvent((e) => {
      if (e.payload.type !== "drop" || !active || active.exited || store.get().screen !== "main") return;
      active.view.paste(quotePaths(e.payload.paths, store.get().platform.os));
      active.view.focus();
    })
    .catch((e) => log.warn(`file drops are not available: ${describeError(e)}`));
}

// ---------- mount ----------

export function mount(): void {
  panes = $("#terminal-root");
  strip = new Strip($("#tabstrip-slot"), {
    select: (id) => {
      const tab = id === null ? null : (tabs.find((t) => t.id === id) ?? undefined);
      if (tab !== undefined && tab !== active) showTab(tab);
      else tab?.view.focus();
    },
    close: (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void closeTab(tab);
    },
    moveOut: (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void moveTabs([tab]);
    },
    reorder: (id, before) => {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      const target = before === null ? undefined : tabs.find((t) => t.id === before);
      const rest = tabs.filter((t) => t !== tab);
      reorder(tab, target ? rest.indexOf(target) : rest.length);
    },
    tearOff: (id, at) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void moveTabs([tab], { at });
    },
    menu: (id, at) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void tabMenu(tab).then((items) => showMenu(items, { at, label: "Terminal tab" }));
    },
  });

  on("launch", launch);
  on("terminal:show", ({ id }) => {
    const tab = id === null ? null : tabs.find((t) => t.id === id);
    if (tab !== undefined && tab !== active) showTab(tab);
  });
  registerCommands();

  // keep the visible terminal sized to its pane
  new ResizeObserver(() => active?.view.fitNow()).observe(panes);
  // window focus -> the terminal in front gets the keys, unless a dialog is open (Enter would reach claude)
  window.addEventListener("focus", () => {
    if (active && store.get().screen === "main" && !modalOpen()) active.view.focus();
  });
  if (isTauri()) installDrops();

  void listen("app:close-requested", ({ terminals }) => void onCloseRequested(terminals));
  void listen("window:close-requested", ({ terminals }) => void onWindowCloseRequested(terminals));
  void listen("pty-moved", (ids) => void takeMoved(ids));
  void listen("pty-focus", (id) => {
    const tab = tabs.find((t) => t.ptyId === id);
    if (!tab) return;
    if (tab !== active) showTab(tab);
    tab.view.focus();
  });
  renderStrip();
  void restore();
}
