// Terminal tabs: a pinned Home tab plus one tab per claude session running in an xterm over a PTY.
// TEMPORARY port of the prototype's tabs and terminals, kept behaviour for behaviour (gliding tab pill, tab
// enter and close springs, second click to end a running session, resume of an open session switches to
// its tab). WP2 owns and rewrites this: raw-byte channel, flow control, pop-out, background terminals,
// external windows (every launch opens here for now, whatever settings.openIn says).

import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { PtyEvent } from "../../bindings/PtyEvent";
import type { QuitDecision } from "../../bindings/QuitDecision";
import { call, listen } from "../../core/api";
import { type LaunchRequest, on } from "../../core/bus";
import { registerCommand } from "../../core/commands";
import { $, html, setHtml } from "../../core/dom";
import { leaf } from "../../core/format";
import { icon } from "../../core/icons";
import { describeError, log } from "../../core/log";
import { animate, Spring, settleIn } from "../../core/motion";
import { isMac, isWindows, windowsBuild } from "../../core/platform";
import { profileName } from "../../core/profiles";
import { settings } from "../../core/settings";
import { store, type TermInfo } from "../../core/store";
import { choose } from "../../ui/dialog";
import { refreshIndex } from "../index-data/api";
import { startProfile } from "../profiles/api";
import "./terminals.css";

declare module "../../core/api" {
  interface Commands {
    pty_new: {
      args: { dir: string; profile: string; cols: number; rows: number; onEvent: Channel<PtyEvent> };
      result: number;
    };
    pty_resume: {
      args: {
        sessionId: string;
        profile: string;
        fork: boolean;
        dir: string;
        cols: number;
        rows: number;
        onEvent: Channel<PtyEvent>;
      };
      result: number;
    };
    pty_write: { args: { id: number; data: string }; result: null };
    pty_resize: { args: { id: number; cols: number; rows: number }; result: null };
    pty_kill: { args: { id: number }; result: null };
    pty_kill_all: { args: undefined; result: null };
  }
}

/** A tab with its xterm. Presentation-only fields (armed, closing) stay here, not in the store. */
interface Tab extends TermInfo {
  pane: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  /** ms timestamp until which a click on × ends the running session. */
  armed: number;
  closing: boolean;
}

const tabs: Tab[] = [];
let active: Tab | null = null; // null = Home
let nextKey = 1;
const entering = new Map<number, number>(); // tab key -> entrance progress 0..1, kept across re-renders
const el = {} as { tabs: HTMLElement; tabList: HTMLElement; tabPill: HTMLElement; panes: HTMLElement };

/** Mirrors the tabs into the store for other features (and the shell, which shows terminal-root). */
function publish() {
  store.set({
    terminals: tabs
      .filter((t) => !t.closing)
      .map(({ id, ptyId, pid, title, sub, dir, profile, sessionId, exited }) => ({
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

// ---------- motion ----------
// the active tab's pill glides between tabs (same springs as the Windows tab strip)
const tabX = new Spring(0.3, 0.86, 0.1);
const tabW = new Spring(0.3, 0.9, 0.1);
let tabPillShown = false;

function placeTabPill() {
  const cur = el.tabList.querySelector<HTMLElement>(`.term-tab[data-key="${active ? active.id : 0}"]`);
  if (!cur) return;
  const x = cur.offsetLeft;
  const w = cur.offsetWidth;
  const draw = () => {
    el.tabPill.style.transform = `translateX(${tabX.value}px)`;
    el.tabPill.style.width = `${tabW.value}px`;
  };
  if (!tabPillShown) {
    tabX.snap(x);
    tabW.snap(w);
    draw();
    tabPillShown = true;
    return;
  }
  animate(tabX, x, draw);
  animate(tabW, w, draw);
}

// a new tab fades and scales in; looked up by key each frame because re-renders replace the element
function styleEntering(key: number, v: number) {
  const node = el.tabList.querySelector<HTMLElement>(`.term-tab[data-key="${key}"]`);
  if (!node) return;
  node.style.opacity = String(Math.min(1, v));
  node.style.transform = v >= 1 ? "" : `scale(${0.88 + 0.12 * v})`;
}

function enterTab(key: number) {
  const s = new Spring(0.32, 0.78, 0.002);
  entering.set(key, 0);
  animate(
    s,
    1,
    (v) => {
      entering.set(key, v);
      styleEntering(key, v);
    },
    () => {
      entering.delete(key);
      styleEntering(key, 1);
    },
  );
}

// ---------- tab strip ----------
function renderTabs() {
  setHtml(
    el.tabList,
    html`<div class="term-tab term-home${active ? "" : " active"}" data-key="0" role="tab" aria-selected="${String(!active)}">${icon("home")}<span>Home</span></div>${tabs.map(
      (
        t,
      ) => html`<div class="term-tab${t === active ? " active" : ""}${t.exited ? " exited" : ""}" data-key="${t.id}" role="tab" aria-selected="${String(t === active)}" data-tip="${t.sub}">
          ${icon("terminal")}<span class="term-title">${t.title}</span><span class="term-sub">${t.sub}</span>
          <button class="term-close${t.armed > Date.now() ? " armed" : ""}" type="button" data-close="${t.id}" data-tip="${t.exited ? "Close" : "Click again to end this session"}" aria-label="Close">${icon("close")}</button>
        </div>`,
    )}`,
  );
  // a tab being closed keeps collapsing where it was
  for (const t of tabs) {
    if (t.closing) el.tabList.querySelector<HTMLElement>(`.term-tab[data-key="${t.id}"]`)?.classList.add("closing");
  }
  for (const [key, v] of entering) styleEntering(key, v);
  placeTabPill();
}

function onTabClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const close = t.closest<HTMLElement>("[data-close]");
  if (close) {
    const tab = tabs.find((x) => x.id === Number(close.dataset.close));
    if (!tab || tab.closing) return;
    // a running session needs a second click, so a stray click never ends Claude mid-task
    if (!tab.exited && tab.armed < Date.now()) {
      tab.armed = Date.now() + 2500;
      renderTabs();
      setTimeout(renderTabs, 2600);
      return;
    }
    closeTab(tab);
    return;
  }
  const key = t.closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key === undefined) return;
  const tab = key === "0" ? null : tabs.find((x) => x.id === Number(key) && !x.closing);
  if (tab !== undefined && tab !== active) showTab(tab);
}

function showTab(tab: Tab | null) {
  active = tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  publish(); // the shell swaps the workspace and the terminals synchronously
  renderTabs();
  if (tab) {
    tab.fit.fit();
    tab.term.focus();
    settleIn(tab.pane, 0);
  }
}

function closeTab(tab: Tab) {
  // also for an exited tab: the backend keeps its entry until told
  if (tab.ptyId !== null) void call("pty_kill", { id: tab.ptyId });
  tab.closing = true;
  // switch away first, so the pill glides to the next tab while this one collapses
  if (active === tab) {
    const open = tabs.filter((t) => !t.closing);
    const i = tabs.indexOf(tab);
    const next =
      tabs.slice(i + 1).find((t) => !t.closing) ??
      tabs
        .slice(0, i)
        .reverse()
        .find((t) => !t.closing) ??
      null;
    showTab(open.length ? next : null);
  } else {
    publish();
    renderTabs();
  }
  const node = el.tabList.querySelector<HTMLElement>(`.term-tab[data-key="${tab.id}"]`);
  const w = node?.offsetWidth ?? 0;
  const s = new Spring(0.26, 1, 0.003, 1);
  animate(
    s,
    0,
    (v) => {
      const n = el.tabList.querySelector<HTMLElement>(`.term-tab[data-key="${tab.id}"]`);
      if (n) {
        const k = Math.max(0, v);
        n.style.maxWidth = `${w * k}px`;
        n.style.padding = `0 ${8 * k}px 0 ${10 * k}px`;
        n.style.marginRight = `${4 * k}px`;
        n.style.opacity = String(k);
      }
      placeTabPill();
    },
    () => {
      tab.term.dispose();
      tab.pane.remove();
      tabs.splice(tabs.indexOf(tab), 1);
      renderTabs();
    },
  );
}

// ---------- terminals ----------
const dark = matchMedia("(prefers-color-scheme: dark)");

function termTheme() {
  return dark.matches
    ? { background: "#141416", foreground: "#e6e6ea", cursor: "#d97757", selectionBackground: "#d9775755" }
    : { background: "#fbfbfc", foreground: "#1d1d1f", cursor: "#d97757", selectionBackground: "#d9775740" };
}

function launch(req: LaunchRequest) {
  const profile = req.profile ?? startProfile() ?? "";
  if (req.resume) {
    const { sessionId } = req.resume;
    // already open? go to it
    const open = tabs.find((t) => t.sessionId === sessionId && !t.exited && !t.closing);
    if (open) return showTab(open);
    const title = (req.label ?? "Resumed session").slice(0, 40);
    void openTerminal(req, profile, title, `${leaf(req.dir)} · ${sessionId.slice(0, 8)}`);
    return;
  }
  void openTerminal(req, profile, "New session", `${leaf(req.dir)} · ${profileName(profile)}`);
}

/** Copy/paste keys: Cmd on macOS (Ctrl+C and Ctrl+V always reach claude there), Ctrl on Windows. */
function clipboardKeys(term: Terminal) {
  return (e: KeyboardEvent) => {
    if (e.type !== "keydown" || e.altKey) return true;
    const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod) return true;
    const key = e.key.toLowerCase();
    // copy only with a selection; without one Ctrl+C on Windows interrupts, as in any terminal
    if (key === "c" && term.hasSelection()) {
      writeText(term.getSelection()).catch((err) => log.error(`copy failed: ${describeError(err)}`));
      term.clearSelection();
      return false;
    }
    if (key === "v") return false; // let the browser fire its paste event, which xterm handles
    return true;
  };
}

async function openTerminal(req: LaunchRequest, profile: string, title: string, sub: string) {
  const pane = document.createElement("div");
  pane.className = "term-pane";
  pane.setAttribute("role", "tabpanel");
  el.panes.appendChild(pane);
  const mac = isMac();
  const term = new Terminal({
    allowProposedApi: true, // unicode11 widths
    fontFamily: isWindows()
      ? '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Emoji", "Nirmala UI", monospace'
      : 'ui-monospace, "SF Mono", Menlo, "Apple Color Emoji", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: settings().scrollback,
    smoothScrollDuration: mac ? 0 : 110,
    macOptionIsMeta: mac && settings().macOptionIsMeta,
    macOptionClickForcesSelection: mac,
    theme: termTheme(),
    windowsPty: isWindows() ? { backend: "conpty", buildNumber: windowsBuild() } : undefined,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const tab: Tab = {
    id: nextKey++,
    ptyId: null,
    // the backend does not report it yet (WP2: pty_new returns it with the id)
    pid: null,
    title,
    sub,
    dir: req.dir,
    profile,
    sessionId: req.resume?.sessionId ?? null,
    exited: false,
    pane,
    term,
    fit,
    armed: 0,
    closing: false,
  };
  tabs.push(tab);
  enterTab(tab.id); // before the first render, so the tab never shows at full opacity first
  // in front before xterm opens, so it measures a visible pane
  active = tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  publish();
  term.open(pane);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = "11";
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    // no WebGL: xterm falls back to its DOM renderer
  }
  showTab(tab);

  term.attachCustomKeyEventHandler(clipboardKeys(term));

  const pending: string[] = []; // keys typed before the PTY is up
  const send = (data: string) => {
    if (tab.ptyId === null) pending.push(data);
    else void call("pty_write", { id: tab.ptyId, data }, { quiet: true });
  };
  term.onData(send);
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId !== null) void call("pty_resize", { id: tab.ptyId, cols, rows }, { quiet: true });
  });
  term.onTitleChange((t) => {
    const next = t.trim();
    if (!next || tab.closing || next === tab.title) return;
    tab.title = next;
    // in place: claude animates its title, and a full re-render per frame would be wasted work
    const node = el.tabList.querySelector(`.term-tab[data-key="${tab.id}"] .term-title`);
    if (node) node.textContent = next;
    publish();
  });

  const ch = new Channel<PtyEvent>();
  ch.onmessage = (ev) => {
    if (tab.closing) return; // the xterm may already be disposed
    if (ev.kind === "data") {
      term.write(ev.data);
      return;
    }
    tab.exited = true;
    term.write("\r\n\x1b[90m[session ended — close this tab, or resume it from the sidebar]\x1b[0m\r\n");
    publish();
    renderTabs();
    void refreshIndex();
  };
  const size = { cols: term.cols, rows: term.rows, onEvent: ch };
  const res = req.resume
    ? await call(
        "pty_resume",
        { sessionId: req.resume.sessionId, profile, fork: req.resume.fork ?? false, dir: req.dir, ...size },
        { quiet: true },
      )
    : await call("pty_new", { dir: req.dir, profile, ...size }, { quiet: true });
  if (!res.ok) {
    tab.exited = true;
    term.write(`\x1b[31m${res.error.message.replace(/\n/g, "\r\n")}\x1b[0m\r\n`);
    publish();
    renderTabs();
    return;
  }
  tab.ptyId = res.value;
  // closed while it was starting: end it now, nothing else will
  if (tab.closing) {
    void call("pty_kill", { id: res.value });
    return;
  }
  publish();
  for (const d of pending.splice(0)) send(d);
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

// ---------- mount ----------
export function mount(): void {
  const strip = $("#tabstrip-slot");
  setHtml(
    strip,
    html`<div class="term-tabs"><div class="term-pill"></div><div class="term-tablist" role="tablist" aria-label="Terminals"></div></div>`,
  );
  el.tabs = $(".term-tabs", strip);
  el.tabList = $(".term-tablist", strip);
  el.tabPill = $(".term-pill", strip);
  el.panes = $("#terminal-root");
  el.tabs.addEventListener("click", onTabClick);

  on("launch", launch);
  on("terminal:show", ({ id }) => {
    const tab = id === null ? null : tabs.find((t) => t.id === id && !t.closing);
    if (tab !== undefined && tab !== active) showTab(tab);
  });
  registerCommand({
    id: "tab:close",
    title: "Close Tab",
    enabled: () => active !== null,
    run: () => {
      if (active) closeTab(active);
    },
  });
  registerCommand({ id: "tab:next", title: "Next Tab", run: () => cycle(1) });
  registerCommand({ id: "tab:prev", title: "Previous Tab", run: () => cycle(-1) });

  dark.addEventListener("change", () => {
    for (const t of tabs) t.term.options.theme = termTheme();
  });
  // keep the visible terminal sized to its pane, and the pill on its tab when the window resizes
  new ResizeObserver(() => {
    active?.fit.fit();
    placeTabPill();
  }).observe(el.panes);
  new ResizeObserver(() => placeTabPill()).observe(el.tabs);

  void listen("app:close-requested", ({ terminals }) => void onCloseRequested(terminals));
  void call("pty_kill_all", undefined, { quiet: true }); // after a reload, end terminals the old page had open
  renderTabs();
}

/** Next/previous tab, Home included, wrapping around. */
function cycle(dir: 1 | -1) {
  const order: Array<Tab | null> = [null, ...tabs.filter((t) => !t.closing)];
  const i = order.indexOf(active);
  const next = order[(i + dir + order.length) % order.length];
  if (next !== undefined && next !== active) showTab(next);
}
