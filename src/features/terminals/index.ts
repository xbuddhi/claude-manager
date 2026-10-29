// Terminal tabs: claude sessions in xterms over PTYs, in tabs next to the pinned Home tab (Windows app:
// ClaudeManager.ps1 "terminal tabs"). Handles the bus events "launch" (a tab here, or a terminal window of
// the OS per settings.openIn) and "terminal:show", the tab commands and keys, file drops, the files panel
// left of the terminals and the source control panel right of them (both for the folder of the tab in
// front; files can be dragged into the terminal), the terminal panel under them (each tab's own shell, for
// the user's commands), and the questions asked when the app or this window closes while terminals run.
//
// Every app window has its own tabs, like browser windows (core/window.ts). Tabs move between windows
// (dragged out of the strip, or "Move to ..." in their menu); their terminals keep running and the window
// they go to takes them over. Opening a session that is open in another window brings that tab forward.
// Terminals outlive the page: after a reload the tabs come back from pty_list (nothing is killed).
// xterm (./term) is loaded when the first tab opens, not at startup.

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
import { $, h } from "../../core/dom";
import { leaf, plural } from "../../core/format";
import { modalOpen, registerShortcut } from "../../core/keyboard";
import { describeError, log } from "../../core/log";
import { settleIn } from "../../core/motion";
import { pathKey } from "../../core/paths";
import { profileName } from "../../core/profiles";
import { settings } from "../../core/settings";
import { store, type TermInfo } from "../../core/store";
import { isMainWindow, MAIN_WINDOW, windowLabel } from "../../core/window";
import { ask, choose } from "../../ui/dialog";
import { type MenuItem, showMenu } from "../../ui/menu";
import { splitter } from "../../ui/splitter";
import { toast } from "../../ui/toast";
import { createExplorer, type Explorer } from "../files/api";
import { createSourceControlPanel, type SourceControlPanel } from "../git/api";
import { refreshIndex } from "../index-data/api";
import { copyText, folderLabel, openFolder, openInCode } from "../os/api";
import { startProfile } from "../profiles/api";
import { newSessionFromHome } from "../sessions/api";
import { defaultTitle, groupOrder, insertIndex, quotePaths, tabSub } from "./logic";
import "./pty";
import { SessionBar } from "./sessionbar";
import { ShellPanel } from "./shellpanel";
import { Strip } from "./tabs";
import type { TermView } from "./term";
import "./terminals.css";

type TermModule = typeof import("./term");
let termModule: TermModule | null = null;
let termLoading: Promise<TermModule | null> | null = null;

/** Loads xterm and the terminal view once; null when it failed (said in a toast; the next tab tries again). */
function loadTerm(): Promise<TermModule | null> {
  termLoading ??= import("./term").then(
    (m) => (termModule = m),
    (e) => {
      termLoading = null;
      log.error(`loading the terminal failed: ${describeError(e)}`);
      toast("The terminal could not be loaded.", { kind: "error" });
      return null;
    },
  );
  return termLoading;
}

/** Runs `fn` with the terminal module: at once when it is loaded, else once it is (in call order). */
function withTerm(fn: (m: TermModule) => void) {
  if (termModule) fn(termModule);
  else
    void loadTerm().then((m) => {
      if (m) fn(m);
    });
}

/** One of the user's shells in the terminal panel under a tab (the first starts when the panel shows). */
interface Shell {
  /** Unique in this window, for the panel's list. */
  id: number;
  /** The shell program ("zsh", "pwsh"). */
  name: string;
  view: TermView;
  ptyId: number | null;
}

/** A tab with its xterm. Presentation-only fields stay here, not in the store. */
interface Tab extends TermInfo {
  view: TermView;
  /** Closed (or moved to another window) while its terminal was still starting. */
  closing: boolean;
  shells: Shell[];
  /** The one of `shells` in front. */
  shell: Shell | null;
}

const tabs: Tab[] = [];
let active: Tab | null = null; // null = Home
let nextId = 1;
let strip: Strip;
let panes: HTMLElement;
let bar: SessionBar;
let files: Explorer;
let filesSide: HTMLElement;
let filesOpen = false;
let source: SourceControlPanel;
let sourceSide: HTMLElement;
let sourceOpen = false;
let panel: ShellPanel;
let center: HTMLElement;
let shellOpen = false;
/** The panel fills the chat's place too. */
let shellMax = false;
let nextShellId = 1;
/** The shell, not the chat, had the keys last: window focus and file drops go back to it. */
let shellFocused = false;

const FILES_KEY = "terminals.files";
const FILES_WIDTH_KEY = "terminals.filesWidth";
const FILES_MIN = 180;
/** Room the terminal keeps when a side panel is dragged wide. */
const TERM_MIN = 320;
const SOURCE_KEY = "terminals.source";
const SOURCE_WIDTH_KEY = "terminals.sourceWidth";
const SOURCE_MIN = 300;
const SHELL_KEY = "terminals.shell";
const SHELL_HEIGHT_KEY = "terminals.shellHeight";
const SHELL_MIN = 90;
/** Room the chat keeps when the terminal panel is dragged tall. */
const CHAT_MIN = 140;

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveValue(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // only a convenience
  }
}

/** Shows each side panel when it is open and a terminal is in front; they follow that terminal's folder. */
function syncFiles() {
  filesSide.hidden = !filesOpen;
  files.setRoot(active?.dir ?? null);
  files.setShown(filesOpen && active !== null);
  bar.setFilesOpen(filesOpen);
  sourceSide.hidden = !sourceOpen;
  source.setFolder(active?.dir ?? null);
  source.setShown(sourceOpen && active !== null);
  bar.setSourceOpen(sourceOpen);
  syncShell();
}

/**
 * Shows the terminal panel with the tab in front's shells, starting the first one. Minimized, it stays as a
 * bar at the bottom of every tab (naming its shells, if any); a click on it opens the panel.
 */
function syncShell() {
  const tab = active;
  const show = shellOpen && tab !== null;
  const minimized = !shellOpen && tab !== null;
  panel.el.hidden = !show && !minimized;
  panel.setMinimized(minimized);
  center.classList.toggle("shell-max", show && shellMax);
  panel.setMaximized(shellMax);
  bar.setShellOpen(shellOpen);
  for (const t of tabs) for (const sh of t.shells) sh.view.pane.hidden = !show || t !== tab || sh !== t.shell;
  if (tab && (show || minimized)) panel.render(tab.shells, tab.shell?.id ?? null);
  if (!show || !tab) return;
  if (tab.shell) tab.shell.view.fitNow();
  // once the tab's own terminal is up, so the shell can be found under it again after a reload
  else if (tab.ptyId !== null || tab.exited) addShell(tab, true);
}

function toggleShell() {
  shellOpen = !shellOpen;
  saveValue(SHELL_KEY, shellOpen ? "1" : "0");
  if (!shellOpen) shellMax = false;
  syncShell();
  // a shell started just now gets the keys once its view exists (xterm loads on first use)
  if (shellOpen) withTerm(() => active?.shell?.view.focus());
  else active?.view.focus();
}

/** New terminal: another shell under the tab in front, opening the panel. */
function newTerminal() {
  if (!active) return;
  if (!shellOpen) {
    shellOpen = true;
    saveValue(SHELL_KEY, "1");
  }
  addShell(active, false);
}

function toggleMax() {
  shellMax = !shellMax;
  syncShell();
  active?.shell?.view.focus();
}

/** Starts a shell under `tab` and puts it in front; `first`: only when the tab has none yet. */
function addShell(tab: Tab, first: boolean) {
  withTerm((term) => {
    if (first && tab.shells.length) return;
    void startShell(term, tab);
  });
}

function newShell(term: TermModule, tab: Tab, name: string): Shell {
  const view = new term.TermView(panel.panes, {
    tinted: true,
    menuItems: () => [
      { label: "New terminal", icon: "plus", shortcut: "Ctrl+Shift+`", run: newTerminal },
      { label: "Minimize panel", shortcut: "Ctrl+`", run: toggleShell },
      { label: "Kill terminal", icon: "trash", danger: true, run: () => killShell(tab, shell) },
    ],
  });
  const shell: Shell = { id: nextShellId++, name, view, ptyId: null };
  tab.shells.push(shell);
  tab.shell = shell;
  syncShell();
  shell.view.open();
  return shell;
}

/** The output channel of a shell; when it ends (exit) it leaves the panel. */
function shellChannel(tab: Tab, shell: Shell) {
  return shell.view.channel(() => dropShell(tab, shell));
}

/** The shell program's name from its path ("/bin/zsh" -> "zsh", "...\\pwsh.exe" -> "pwsh"). */
function shellName(title: string): string {
  return leaf(title).replace(/\.exe$/i, "") || "Terminal";
}

async function startShell(term: TermModule, tab: Tab) {
  if (tab.closing || !tabs.includes(tab)) return;
  const shell = newShell(term, tab, "Terminal");
  if (tab === active) shell.view.focus();
  const { onOutput } = shellChannel(tab, shell);
  const owner = tab.ptyId ?? 0;
  const res = await call(
    "pty_shell",
    { owner, dir: tab.dir, profile: tab.profile, ...shell.view.size, onOutput },
    { quiet: true },
  );
  if (!res.ok) {
    shell.view.note(res.error.message, "error");
    return;
  }
  // the tab closed or the shell was killed while it started: end it now, nothing else will
  if (!tab.shells.includes(shell)) {
    void call("pty_kill", { id: res.value.id }, { quiet: true });
    return;
  }
  bindShell(tab, shell, res.value);
}

function bindShell(tab: Tab, shell: Shell, info: PtyInfo) {
  shell.ptyId = info.id;
  shell.name = shellName(info.title);
  shell.view.bind(info.id);
  if (tab === active) syncShell();
}

/** A shell that runs in the backend (after a reload, or moved here with its tab) goes back under its tab. */
async function adoptShell(info: PtyInfo): Promise<void> {
  const term = termModule ?? (await loadTerm());
  const tab = tabs.find((t) => t.ptyId === info.owner);
  if (!tab) {
    // its tab is gone: nothing could show it
    void call("pty_kill", { id: info.id }, { quiet: true });
    return;
  }
  if (!term) return;
  const shell = newShell(term, tab, shellName(info.title));
  const { onOutput } = shellChannel(tab, shell);
  const res = await call("pty_attach", { id: info.id, onOutput }, { quiet: true });
  if (!res.ok) dropShell(tab, shell);
  else if (tab.shells.includes(shell)) bindShell(tab, shell, res.value);
}

/**
 * Removes a shell from its tab (its process is ended by the caller, or already gone). The one before it
 * comes to the front; with none left the panel goes back to its bar.
 */
function dropShell(tab: Tab, shell: Shell) {
  const i = tab.shells.indexOf(shell);
  if (i < 0) return;
  tab.shells.splice(i, 1);
  shell.view.dispose();
  if (tab.shell === shell) tab.shell = tab.shells[Math.max(0, i - 1)] ?? null;
  if (tab.closing || tab !== active) return;
  if (!tab.shell && shellOpen) {
    shellOpen = false;
    shellMax = false;
    saveValue(SHELL_KEY, "0");
    shellFocused = false;
    tab.view.focus();
  }
  syncShell();
  if (shellFocused) tab.shell?.view.focus();
}

/** Kill terminal: ends one shell of the tab. */
function killShell(tab: Tab, shell: Shell) {
  if (shell.ptyId !== null) void call("pty_kill", { id: shell.ptyId }, { quiet: true });
  dropShell(tab, shell);
}

function selectShell(id: number) {
  const tab = active;
  const shell = tab?.shells.find((sh) => sh.id === id);
  if (!tab || !shell) return;
  tab.shell = shell;
  syncShell();
  shell.view.focus();
}

/** Where pasted paths go: the shell when it had the keys last, else the chat. */
function inputView(tab: Tab): TermView | null {
  if (shellFocused && shellOpen && tab.shell) return tab.shell.view;
  return tab.exited ? null : tab.view;
}

/** Pastes a path into the terminal in front, quoted as for a dropped file. */
function pastePath(path: string) {
  const view = active && inputView(active);
  if (!view) return;
  view.paste(quotePaths([path], store.get().platform.os));
  view.focus();
}

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
  bar.show(active?.dir ?? null);
  syncFiles();
}

/**
 * A tab's folder as compared: the tabs of one folder are kept together and grouped in the strip. With
 * "Group tabs by folder" off every tab is its own group, so none are kept together or get a chip.
 */
function folderKey(t: Tab): string {
  return settings().groupTabs ? pathKey(t.dir, store.get().platform.os) : `tab:${t.id}`;
}

/** Puts each folder's tabs together again (grouping was turned on). */
function regroup() {
  tabs.splice(0, tabs.length, ...groupOrder(tabs, folderKey));
  publish();
  renderStrip();
}

function renderStrip() {
  strip.render(
    tabs.map((t) => ({ id: t.id, title: t.title, sub: t.sub, exited: t.exited, dir: t.dir, group: folderKey(t) })),
    active?.id ?? null,
  );
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
  for (const sh of [...tab.shells]) dropShell(tab, sh);
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
  // also for an exited tab: the backend may not have dropped it yet (its shell goes with it)
  if (tab.ptyId !== null) void call("pty_kill", { id: tab.ptyId }, { quiet: true });
  for (const sh of tab.shells) if (sh.ptyId !== null) void call("pty_kill", { id: sh.ptyId }, { quiet: true });
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
  // each tab's shells go along, and come back under it there
  const ids = going.flatMap((t) => [
    t.ptyId as number,
    ...t.shells.flatMap((sh) => (sh.ptyId === null ? [] : [sh.ptyId])),
  ]);
  const res = await call("pty_move", { ids, ...where });
  if (!res.ok) return;
  for (const t of going) if (!t.closing) removeTab(t);
  if (!tabs.length && !isMainWindow()) void getCurrentWindow().close();
}

/** The dragging window refreshes `tab-drag` every 400 ms at most; without it the placeholder goes. */
const INCOMING_TTL_MS = 1200;
let incomingTimer: ReturnType<typeof setTimeout> | undefined;

/** A tab from another window is dragged over this one (`title`), or left it (null): show where it lands. */
function showIncoming(title: string | null) {
  clearTimeout(incomingTimer);
  strip.setIncoming(title);
  if (title !== null) incomingTimer = setTimeout(() => strip.setIncoming(null), INCOMING_TTL_MS);
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
  // a folder's tabs stay together: a tab dragged past its folder's first tab takes the folder along
  const grouped = groupOrder(tabs, folderKey);
  tabs.splice(0, tabs.length, ...grouped);
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

function newTab(term: TermModule, info: Pick<TermInfo, "title" | "dir" | "profile" | "sessionId">): Tab {
  const id = nextId++;
  const view = new term.TermView(panes, {
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
    shells: [],
    shell: null,
  };
  // next to the other tabs of its folder
  tabs.splice(insertIndex(tabs.map(folderKey), folderKey(tab)), 0, tab);
  return tab;
}

function setTitle(tab: Tab, title: string) {
  if (tab.closing || title === tab.title) return;
  tab.title = title;
  strip.setTitle(tab.id, title);
  // only the title changed: the store's copy is updated, the session bar and side panels stay as they are
  store.set((s) => ({ terminals: s.terminals.map((t) => (t.id === tab.id ? { ...t, title } : t)) }));
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
  withTerm((term) => {
    const resume = req.resume;
    if (resume && !resume.fork) {
      // already open here? go to it
      const open = tabs.find((t) => t.sessionId === resume.sessionId && !t.exited);
      if (open) return showTab(open);
      // open in another window: that window comes forward with it (two tabs on one session would clash)
      void call("pty_focus_session", { sessionId: resume.sessionId }, { quiet: true }).then((res) => {
        if (!(res.ok && res.value)) openTab(term, req, profile);
      });
      return;
    }
    openTab(term, req, profile);
  });
}

function openTab(term: TermModule, req: LaunchRequest, profile: string) {
  const resume = req.resume;
  const tab = newTab(term, {
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
  const term = termModule ?? (await loadTerm());
  if (!term || tabs.some((t) => t.ptyId === info.id)) return;
  const tab = newTab(term, { title: info.title, dir: info.dir, profile: info.profile, sessionId: info.sessionId });
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
  const mine = res.value.filter((info) => info.window === me || (main && info.window === null));
  for (const info of mine) if (info.owner === null) await adopt(info, false);
  for (const info of mine) if (info.owner !== null) await adoptShell(info);
  const first = tabs[0];
  if (!main && first && !active) showTab(first);
}

/** Terminals moved here from another window, the first in front. */
async function takeMoved(ids: number[]) {
  const res = await call("pty_list", undefined, { quiet: true });
  if (!res.ok) return;
  const moved = ids.flatMap((id) => res.value.filter((t) => t.id === id));
  let front = true;
  for (const info of moved) {
    if (info.owner !== null) continue;
    await adopt(info, front);
    front = false;
  }
  for (const info of moved) if (info.owner !== null) await adoptShell(info);
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
  registerCommand({
    id: "tab:toggleTerminal",
    title: "Toggle Terminal",
    enabled: () => active !== null && focused(),
    run: toggleShell,
  });
  registerShortcut({ id: "tab:toggleTerminal", keys: "Ctrl+`", inTerminal: true });
  registerCommand({
    id: "tab:newTerminal",
    title: "New Terminal",
    enabled: () => active !== null && focused(),
    run: newTerminal,
  });
  registerShortcut({ id: "tab:newTerminal", keys: "Ctrl+Shift+`", inTerminal: true });
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
      const view = active && inputView(active);
      if (e.payload.type !== "drop" || !view || store.get().screen !== "main") return;
      view.paste(quotePaths(e.payload.paths, store.get().platform.os));
      view.focus();
    })
    .catch((e) => log.warn(`file drops are not available: ${describeError(e)}`));
}

// ---------- mount ----------

export function mount(): void {
  // the session bar over the files panel and the terminals' panes
  filesOpen = loadFlag(FILES_KEY);
  sourceOpen = loadFlag(SOURCE_KEY);
  shellOpen = loadFlag(SHELL_KEY);
  bar = new SessionBar(
    () => {
      filesOpen = !filesOpen;
      saveValue(FILES_KEY, filesOpen ? "1" : "0");
      syncFiles();
    },
    () => {
      sourceOpen = !sourceOpen;
      saveValue(SOURCE_KEY, sourceOpen ? "1" : "0");
      syncFiles();
    },
    toggleShell,
  );
  panes = h("div", { class: "term-panes" });
  files = createExplorer({
    noRoot: "No folder for this terminal.",
    menuItems: (path) => [{ label: "Add to Chat", icon: "terminal", run: () => pastePath(path) }],
    drop: {
      at: (node) => !!node?.closest(".term-panes"),
      mark: (on) => panes.classList.toggle("drop-target", on),
      run: pastePath,
    },
  });
  const divider = h("div", { class: "term-files-divider" });
  filesSide = h("div", { class: "term-files" }, files.el, divider);
  source = createSourceControlPanel();
  const sourceDivider = h("div", { class: "term-source-divider" });
  sourceSide = h("div", { class: "term-source" }, sourceDivider, source.el);
  panel = new ShellPanel({
    add: newTerminal,
    kill: (id) => {
      const shell = active?.shells.find((sh) => sh.id === id);
      if (active && shell) killShell(active, shell);
    },
    select: selectShell,
    toggleMax,
    toggleOpen: toggleShell,
  });
  const shellSide = panel.el;
  shellSide.addEventListener("focusin", () => {
    shellFocused = true;
  });
  panes.addEventListener("focusin", () => {
    shellFocused = false;
  });
  center = h("div", { class: "term-center" }, panes, shellSide);
  const body = h("div", { class: "term-body" }, filesSide, center, sourceSide);
  $("#terminal-root").append(bar.el, body);
  const setFilesWidth = (px: number) => {
    filesSide.style.width = `${px}px`;
  };
  splitter({
    el: divider,
    label: "Resize the files panel",
    get: () => filesSide.getBoundingClientRect().width,
    min: FILES_MIN,
    max: () => Math.max(FILES_MIN, body.clientWidth - TERM_MIN),
    onResize: setFilesWidth,
    onCommit: (px) => saveValue(FILES_WIDTH_KEY, String(px)),
  });
  // the source control panel is on the right: the splitter moves its left edge, measured from the left
  const setSourceWidth = (px: number) => {
    sourceSide.style.width = `${px}px`;
  };
  splitter({
    el: sourceDivider,
    label: "Resize the source control panel",
    get: () => body.clientWidth - sourceSide.getBoundingClientRect().width,
    min: TERM_MIN,
    max: () => Math.max(TERM_MIN, body.clientWidth - SOURCE_MIN),
    onResize: (edge) => setSourceWidth(Math.max(SOURCE_MIN, body.clientWidth - edge)),
    onCommit: () => saveValue(SOURCE_WIDTH_KEY, String(Math.round(sourceSide.getBoundingClientRect().width))),
  });
  // the terminal panel is below the chat: the splitter moves its top edge, measured from the top
  const setShellHeight = (px: number) => {
    // a variable, not the height: minimized, the bar keeps its own height
    shellSide.style.setProperty("--shell-h", `${px}px`);
  };
  splitter({
    el: panel.divider,
    axis: "y",
    label: "Resize the terminal panel",
    get: () => center.clientHeight - shellSide.getBoundingClientRect().height,
    min: CHAT_MIN,
    max: () => Math.max(CHAT_MIN, center.clientHeight - SHELL_MIN),
    onResize: (edge) => setShellHeight(Math.max(SHELL_MIN, center.clientHeight - edge)),
    onCommit: () => saveValue(SHELL_HEIGHT_KEY, String(Math.round(shellSide.getBoundingClientRect().height))),
  });
  try {
    const savedShell = Number(localStorage.getItem(SHELL_HEIGHT_KEY));
    if (savedShell >= SHELL_MIN) setShellHeight(savedShell);
    const saved = Number(localStorage.getItem(FILES_WIDTH_KEY));
    if (saved >= FILES_MIN) setFilesWidth(saved);
    const savedSource = Number(localStorage.getItem(SOURCE_WIDTH_KEY));
    if (savedSource >= SOURCE_MIN) setSourceWidth(savedSource);
  } catch {
    // the default widths
  }
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
      return tab ? moveTabs([tab], { at }) : undefined;
    },
    dragOver: async (id, at) => {
      const title = tabs.find((t) => t.id === id)?.title ?? "";
      const res = await call("tab_drag_over", { at: at ?? undefined, title }, { quiet: true });
      return res.ok ? res.value : null;
    },
    menu: (id, at) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) void tabMenu(tab).then((items) => showMenu(items, { at, label: "Terminal tab" }));
    },
  });

  store.select((s) => s.settings.groupTabs, regroup);
  on("launch", launch);
  on("terminal:show", ({ id }) => {
    const tab = id === null ? null : tabs.find((t) => t.id === id);
    if (tab !== undefined && tab !== active) showTab(tab);
  });
  registerCommands();

  // keep the visible terminal sized to its pane, once per frame however often the pane resizes (showing a
  // tab and opening one fit at once)
  let fitFrame = 0;
  new ResizeObserver(() => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => {
      fitFrame = 0;
      active?.view.fitNow();
    });
  }).observe(panes);
  let shellFrame = 0;
  new ResizeObserver(() => {
    if (shellFrame) return;
    shellFrame = requestAnimationFrame(() => {
      shellFrame = 0;
      active?.shell?.view.fitNow();
    });
  }).observe(panel.panes);
  // window focus -> the terminal in front gets the keys, unless a dialog is open (Enter would reach claude)
  window.addEventListener("focus", () => {
    if (!active || store.get().screen !== "main" || modalOpen()) return;
    if (shellFocused && shellOpen && active.shell) active.shell.view.focus();
    else active.view.focus();
  });
  if (isTauri()) installDrops();

  void listen("app:close-requested", ({ terminals }) => void onCloseRequested(terminals));
  void listen("window:close-requested", ({ terminals }) => void onWindowCloseRequested(terminals));
  void listen("pty-moved", (ids) => {
    showIncoming(null);
    void takeMoved(ids);
  });
  void listen("tab-drag", showIncoming);
  void listen("pty-focus", (id) => {
    const tab = tabs.find((t) => t.ptyId === id);
    if (!tab) return;
    if (tab !== active) showTab(tab);
    tab.view.focus();
  });
  renderStrip();
  void restore();
}
