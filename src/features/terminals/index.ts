// Terminal tabs: claude sessions in xterms over PTYs, in tabs next to the pinned Home tab (Windows app:
// ClaudeManager.ps1 "terminal tabs"). Handles the bus events "launch" (a tab here, or a terminal window of
// the OS per settings.openIn) and "terminal:show", the tab commands and keys, file drops, pop-out windows,
// and the question asked when the app closes while terminals run.
//
// Terminals outlive the page: after a reload the tabs come back from pty_list (nothing is killed), and a
// pop-out window gives its terminal back with "Move back to main window".

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PtyExit } from "../../bindings/PtyExit";
import type { PtyInfo } from "../../bindings/PtyInfo";
import type { QuitDecision } from "../../bindings/QuitDecision";
import { call, listen } from "../../core/api";
import { emit, type LaunchRequest, on } from "../../core/bus";
import { registerCommand } from "../../core/commands";
import { $ } from "../../core/dom";
import { leaf } from "../../core/format";
import { modalOpen, registerShortcut } from "../../core/keyboard";
import { describeError, log } from "../../core/log";
import { settleIn } from "../../core/motion";
import { profileName } from "../../core/profiles";
import { settings } from "../../core/settings";
import { store, type TermInfo } from "../../core/store";
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
  /** Closed (or moved to a pop-out window) while its terminal was still starting. */
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

async function popOut(tab: Tab) {
  if (tab.ptyId === null || tab.exited || tab.closing) return;
  const res = await call("pty_popout", { id: tab.ptyId });
  if (res.ok && !tab.closing) removeTab(tab);
}

function tabMenu(tab: Tab): MenuItem[] {
  return [
    { label: "Open folder in VS Code", icon: "vscode", run: () => void openInCode([tab.dir]) },
    { label: folderLabel(), icon: "folder", run: () => void openFolder(tab.dir) },
    { label: "Copy folder path", icon: "copy", run: () => void copyText(tab.dir) },
    { kind: "separator" },
    {
      label: "Pop out to its own window",
      icon: "popout",
      disabled: tab.ptyId === null || tab.exited,
      run: () => void popOut(tab),
    },
    { label: "Close terminal", icon: "close", danger: true, shortcut: "CmdOrCtrl+W", run: () => void closeTab(tab) },
  ];
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
      {
        label: "Pop out to its own window",
        icon: "popout",
        disabled: tab.ptyId === null || tab.exited,
        run: () => void popOut(tab),
      },
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
  }
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

/** Takes a running terminal over (after a reload, or back from a pop-out window). */
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

/** Terminals the previous page had open come back as tabs; Home stays in front. */
async function restore() {
  const res = await call("pty_list", undefined, { quiet: true });
  if (!res.ok) return;
  for (const info of res.value) {
    if (info.window === null || info.window === "main") await adopt(info, false);
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
    popOut: (id) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void popOut(tab);
    },
    menu: (id, at) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void showMenu(tabMenu(tab), { at, label: "Terminal tab" });
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
  void listen("pty-returned", async (id) => {
    const res = await call("pty_list", undefined, { quiet: true });
    const info = res.ok ? res.value.find((t) => t.id === id) : undefined;
    if (info) await adopt(info, true);
  });
  renderStrip();
  void restore();
}
