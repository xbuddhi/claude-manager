import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { Spring, animate, smoothScroll } from "./spring";

type Session = { id: string; file: string; cwd: string | null; label: string; count: number; modified: number; sizeKb: number; profile: string };
type Project = { path: string; name: string; modified: number; sessions: Session[] };
type Profile = { dir: string; name: string };
type PtyEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };
type Tab = { key: number; title: string; sub: string; pane: HTMLElement; term: Terminal; fit: FitAddon; ptyId: number | null; exited: boolean; armed: number; closing: boolean };

const isWindows = navigator.userAgent.includes("Windows");
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = {
  profile: $<HTMLSelectElement>("#profile"),
  search: $<HTMLInputElement>("#search"),
  projects: $("#projects"),
  list: $("#project-list"),
  selPill: $("#sel-pill"),
  tabs: $("#tabs"),
  tabList: $("#tab-list"),
  tabPill: $("#tab-pill"),
  panes: $("#panes"),
  home: $("#home"),
};

let profiles: Profile[] = [];
let projects: Project[] = [];
let selected: string | null = null; // project path shown on Home
const expanded = new Set<string>();
const tabs: Tab[] = [];
let active: Tab | null = null; // null = Home
let nextKey = 1;
const entering = new Map<number, number>(); // tab key -> entrance progress 0..1, kept across re-renders

// ---------- small helpers ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const profileName = (dir: string) => profiles.find((p) => p.dir === dir)?.name ?? dir.split(/[\\/]/).pop() ?? dir;
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const icon = {
  folder: `<svg viewBox="0 0 16 16"><path d="M1.5 3.5h4.2l1.5 1.5h7.3v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>`,
  chevron: `<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>`,
  plus: `<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>`,
  close: `<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>`,
  home: `<svg viewBox="0 0 16 16"><path d="M2.5 7.5L8 3l5.5 4.5V13h-3.5V9.5h-4V13H2.5z"/></svg>`,
  term: `<svg viewBox="0 0 16 16"><path d="M2 3.5h12v9H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5"/></svg>`,
};
const cssEsc = (s: string) => CSS.escape(s);

// ---------- motion ----------
// sidebar selection: a pill that glides to the selected project (same springs as the Windows sidebar)
const selTop = new Spring(0.3, 0.82, 0.05);
const selH = new Spring(0.3, 0.9, 0.05);
const selA = new Spring(0.2, 1, 0.003);
let selShown = false;
function placeSelPill(snap = false) {
  const row = selected ? el.list.querySelector<HTMLElement>(`.project[data-project="${cssEsc(selected)}"]`) : null;
  if (!row) {
    animate(selA, 0, (v) => (el.selPill.style.opacity = String(v)));
    selShown = false;
    return;
  }
  const top = row.offsetTop, h = row.offsetHeight;
  const draw = () => (el.selPill.style.transform = `translateY(${selTop.value}px)`, el.selPill.style.height = `${selH.value}px`);
  if (snap || !selShown) {
    selTop.snap(top);
    selH.snap(h);
    draw();
  } else {
    animate(selTop, top, draw);
    animate(selH, h, draw);
  }
  selShown = true;
  animate(selA, 1, (v) => (el.selPill.style.opacity = String(v)));
}

// tab strip: the active tab's pill glides between tabs (same springs as the Windows tab strip)
const tabX = new Spring(0.3, 0.86, 0.1);
const tabW = new Spring(0.3, 0.9, 0.1);
let tabPillShown = false;
function placeTabPill() {
  const cur = el.tabList.querySelector<HTMLElement>(`.tab[data-key="${active ? active.key : 0}"]`);
  if (!cur) return;
  const x = cur.offsetLeft, w = cur.offsetWidth;
  const draw = () => (el.tabPill.style.transform = `translateX(${tabX.value}px)`, el.tabPill.style.width = `${tabW.value}px`);
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

// content that appears: fades in and settles up a few pixels
function settleIn(node: HTMLElement, dy = 6) {
  const s = new Spring(0.28, 0.9, 0.003);
  node.style.opacity = "0";
  animate(s, 1, (v) => {
    node.style.opacity = String(Math.min(1, v));
    node.style.transform = v >= 1 ? "" : `translateY(${(1 - v) * dy}px)`;
  });
}

// ---------- data ----------
async function refresh() {
  try {
    projects = await invoke<Project[]>("list_projects");
  } catch (e) {
    console.error(e);
  }
  renderSidebar();
  if (!active) renderHome(false);
}

function visibleProjects(): Project[] {
  const prof = el.profile.value;
  const q = el.search.value.trim().toLowerCase();
  return projects
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => prof === "all" || s.profile === prof) }))
    .filter((p) => p.sessions.length > 0)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || p.sessions.some((s) => s.label.toLowerCase().includes(q)));
}

// a new session uses the chosen profile, or the one this project was used with last
function startProfile(p: Project) {
  return el.profile.value !== "all" ? el.profile.value : (p.sessions[0]?.profile ?? profiles[0]?.dir ?? "");
}

// ---------- sidebar ----------
function sessionRows(p: Project) {
  return p.sessions
    .slice(0, 30)
    .map((s) => `<div class="row session" data-session="${esc(s.file)}" title="${esc(s.label)}"><span class="label">${esc(s.label)}</span><span class="meta">${ago(s.modified)}</span></div>`)
    .join("");
}

function renderSidebar() {
  const list = visibleProjects();
  if (!list.length) {
    el.list.innerHTML = `<div class="empty">${projects.length ? "No matches" : "Loading sessions..."}</div>`;
    placeSelPill();
    return;
  }
  el.list.innerHTML = list
    .map((p) => {
      const open = expanded.has(p.path);
      return `<div class="row project${p.path === selected ? " selected" : ""}" data-project="${esc(p.path)}" title="${esc(p.path)}">
          <span class="chev${open ? " open" : ""}" data-toggle="${esc(p.path)}">${icon.chevron}</span>
          <span class="ico">${icon.folder}</span>
          <span class="label">${esc(p.name)}</span>
          <span class="meta">${ago(p.modified)}</span>
          <button class="mini" data-new="${esc(p.path)}" title="New session">${icon.plus}</button>
        </div>${open ? `<div class="group" data-group="${esc(p.path)}">${sessionRows(p)}</div>` : ""}`;
    })
    .join("");
  placeSelPill(); // glides if the selection moved, stays put otherwise
}

// open/close a project's session list with a spring on its height
function toggleProject(path: string) {
  const row = el.list.querySelector<HTMLElement>(`.project[data-project="${cssEsc(path)}"]`);
  const p = visibleProjects().find((x) => x.path === path);
  if (!row || !p) return;
  const chev = row.querySelector(".chev")!;
  let group = el.list.querySelector<HTMLElement>(`.group[data-group="${cssEsc(path)}"]`);
  const s = new Spring(0.34, 0.9, 0.5);
  if (expanded.has(path)) {
    expanded.delete(path);
    chev.classList.remove("open");
    if (!group) return;
    const g = group;
    s.snap(g.offsetHeight);
    animate(s, 0, (v) => ((g.style.height = `${Math.max(0, v)}px`), placeSelPill(true)), () => (g.remove(), placeSelPill(true)));
  } else {
    expanded.add(path);
    chev.classList.add("open");
    if (!group) {
      row.insertAdjacentHTML("afterend", `<div class="group" data-group="${esc(path)}" style="height:0">${sessionRows(p)}</div>`);
      group = row.nextElementSibling as HTMLElement;
    }
    const g = group;
    animate(s, g.scrollHeight, (v) => ((g.style.height = `${Math.max(0, v)}px`), placeSelPill(true)), () => ((g.style.height = ""), placeSelPill(true)));
  }
}

el.projects.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const find = (path: string) => projects.find((p) => p.path === path)!;
  const newBtn = t.closest<HTMLElement>("[data-new]");
  if (newBtn) return newSession(find(newBtn.dataset.new!));
  const toggle = t.closest<HTMLElement>("[data-toggle]");
  if (toggle) return toggleProject(toggle.dataset.toggle!);
  const sess = t.closest<HTMLElement>("[data-session]");
  if (sess) {
    for (const p of projects) {
      const s = p.sessions.find((x) => x.file === sess.dataset.session);
      if (s) return resume(p, s);
    }
  }
  const proj = t.closest<HTMLElement>("[data-project]");
  if (proj) {
    const changed = selected !== proj.dataset.project;
    selected = proj.dataset.project!;
    el.list.querySelectorAll(".project.selected").forEach((r) => r.classList.remove("selected"));
    proj.classList.add("selected");
    placeSelPill();
    if (active || changed) showTab(null);
  }
});
el.projects.addEventListener("dblclick", (e) => {
  const proj = (e.target as HTMLElement).closest<HTMLElement>("[data-project]");
  if (proj && !(e.target as HTMLElement).closest("[data-new],[data-toggle]")) newSession(projects.find((p) => p.path === proj.dataset.project)!);
});
el.search.addEventListener("input", renderSidebar);
el.profile.addEventListener("change", () => {
  renderSidebar();
  if (!active) renderHome();
});

// ---------- home ----------
function renderHome(animated = true) {
  const p = visibleProjects().find((x) => x.path === selected);
  if (!p) {
    el.home.innerHTML = `<div class="hint"><h1>Claude Manager</h1><p>Pick a project on the left to see its sessions.<br>Double-click a project to start a new session, or click a session to resume it.</p></div>`;
  } else {
    el.home.innerHTML = `
    <header class="home-head">
      <div><h2>${esc(p.name)}</h2><div class="path">${esc(p.path)}</div></div>
      <button class="primary" id="home-new">${icon.plus}<span>New Session</span></button>
    </header>
    <div class="table">
      <div class="thead"><span>Session</span><span>Messages</span><span>Last active</span><span>Profile</span><span>Size</span></div>
      ${p.sessions
        .map(
          (s) => `<div class="trow" data-file="${esc(s.file)}" title="Click to resume">
            <span class="label">${esc(s.label)}</span><span>${s.count}</span><span>${ago(s.modified)}</span><span>${esc(profileName(s.profile))}</span><span>${s.sizeKb >= 1024 ? (s.sizeKb / 1024).toFixed(1) + " MB" : s.sizeKb + " KB"}</span>
          </div>`,
        )
        .join("")}
    </div>`;
    $("#home-new").onclick = () => newSession(p);
    el.home.querySelectorAll<HTMLElement>(".trow").forEach((r) => (r.onclick = () => resume(p, p.sessions.find((s) => s.file === r.dataset.file)!)));
  }
  if (animated) settleIn(el.home.firstElementChild as HTMLElement);
}

// ---------- tabs ----------
function renderTabs() {
  el.tabList.innerHTML =
    `<div class="tab home-tab${active ? "" : " active"}" data-key="0">${icon.home}<span>Home</span></div>` +
    tabs
      .map(
        (t) => `<div class="tab${t === active ? " active" : ""}${t.exited ? " exited" : ""}" data-key="${t.key}" title="${esc(t.sub)}">
          ${icon.term}<span class="t-title">${esc(t.title)}</span><span class="t-sub">${esc(t.sub)}</span>
          <button class="mini close${t.armed > Date.now() ? " armed" : ""}" data-close="${t.key}" title="${t.exited ? "Close" : "Click again to end this session"}">${icon.close}</button>
        </div>`,
      )
      .join("");
  // a tab being closed keeps collapsing where it was
  for (const t of tabs) if (t.closing) el.tabList.querySelector<HTMLElement>(`.tab[data-key="${t.key}"]`)?.classList.add("closing");
  for (const [key, v] of entering) styleEntering(key, v);
  placeTabPill();
}

// a new tab fades and scales in; looked up by key each frame because re-renders replace the element
function styleEntering(key: number, v: number) {
  const node = el.tabList.querySelector<HTMLElement>(`.tab[data-key="${key}"]`);
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
    (v) => (entering.set(key, v), styleEntering(key, v)),
    () => (entering.delete(key), styleEntering(key, 1)),
  );
}

el.tabs.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const close = t.closest<HTMLElement>("[data-close]");
  if (close) {
    const tab = tabs.find((x) => x.key === +close.dataset.close!)!;
    if (tab.closing) return;
    // a running session needs a second click, so a stray click never ends Claude mid-task
    if (!tab.exited && tab.armed < Date.now()) {
      tab.armed = Date.now() + 2500;
      renderTabs();
      setTimeout(renderTabs, 2600);
      return;
    }
    return closeTab(tab);
  }
  const key = t.closest<HTMLElement>("[data-key]")?.dataset.key;
  if (key !== undefined) {
    const tab = key === "0" ? null : (tabs.find((x) => x.key === +key && !x.closing) ?? undefined);
    if (tab !== undefined && tab !== active) showTab(tab);
  }
});

function showTab(tab: Tab | null) {
  active = tab;
  el.home.hidden = !!tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  renderTabs();
  if (tab) {
    tab.fit.fit();
    tab.term.focus();
    settleIn(tab.pane, 0);
  } else {
    renderHome();
    renderSidebar();
  }
}

function closeTab(tab: Tab) {
  if (tab.ptyId !== null && !tab.exited) invoke("pty_kill", { id: tab.ptyId });
  tab.closing = true;
  // switch away first, so the pill glides to the next tab while this one collapses
  if (active === tab) {
    const open = tabs.filter((t) => !t.closing);
    const i = tabs.indexOf(tab);
    const next = tabs.slice(i + 1).find((t) => !t.closing) ?? tabs.slice(0, i).reverse().find((t) => !t.closing) ?? null;
    showTab(open.length ? next : null);
  } else renderTabs();
  const node = el.tabList.querySelector<HTMLElement>(`.tab[data-key="${tab.key}"]`);
  const w = node?.offsetWidth ?? 0;
  const s = new Spring(0.26, 1, 0.003, 1);
  animate(
    s,
    0,
    (v) => {
      const n = el.tabList.querySelector<HTMLElement>(`.tab[data-key="${tab.key}"]`);
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
function newSession(p: Project) {
  openTerminal(p.path, startProfile(p), [], "New session", `${p.name} · ${profileName(startProfile(p))}`);
}
function resume(p: Project, s: Session) {
  // already open? go to it
  const open = tabs.find((t) => t.sub.endsWith(s.id.slice(0, 8)) && !t.exited && !t.closing);
  if (open) return showTab(open);
  openTerminal(s.cwd ?? p.path, s.profile, ["--resume", s.id], s.label.slice(0, 40), `${p.name} · ${s.id.slice(0, 8)}`);
}

async function openTerminal(cwd: string, profile: string, args: string[], title: string, sub: string) {
  const pane = document.createElement("div");
  pane.className = "term-pane";
  el.panes.appendChild(pane);
  const term = new Terminal({
    allowProposedApi: true, // unicode11 widths
    fontFamily: isWindows ? '"Cascadia Mono", "Cascadia Code", Consolas, monospace' : '"SF Mono", Menlo, Monaco, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 10000,
    smoothScrollDuration: 110,
    theme: termTheme(),
    windowsPty: isWindows ? { backend: "conpty", buildNumber: 19045 } : undefined,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const uni = new Unicode11Addon();
  term.loadAddon(uni);
  term.unicode.activeVersion = "11";
  term.open(pane);
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {
    /* no WebGL: xterm falls back to its DOM renderer */
  }
  const tab: Tab = { key: nextKey++, title, sub, pane, term, fit, ptyId: null, exited: false, armed: 0, closing: false };
  tabs.push(tab);
  enterTab(tab.key); // before the first render, so the tab never shows at full opacity first
  showTab(tab);

  // Ctrl+C copies when text is selected (otherwise it interrupts, as usual); Ctrl+V pastes
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
    if (e.key === "c" && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (e.key === "v") return false; // let the browser fire its paste event, which xterm handles
    return true;
  });

  const pending: string[] = []; // keys typed before the PTY is up
  const send = (data: string) => (tab.ptyId === null ? pending.push(data) : invoke("pty_write", { id: tab.ptyId, data }));
  term.onData(send);
  term.onResize(({ cols, rows }) => tab.ptyId !== null && invoke("pty_resize", { id: tab.ptyId, cols, rows }));
  term.onTitleChange((t) => {
    if (t.trim() && !tab.closing) {
      tab.title = t.trim();
      renderTabs();
    }
  });

  const ch = new Channel<PtyEvent>();
  ch.onmessage = (ev) => {
    if (ev.kind === "data") term.write(ev.data);
    else if (!tab.closing) {
      tab.exited = true;
      term.write("\r\n\x1b[90m[session ended — close this tab, or resume it from the sidebar]\x1b[0m\r\n");
      renderTabs();
      refresh();
    }
  };
  try {
    tab.ptyId = await invoke<number>("pty_spawn", { cwd, profile, args, cols: term.cols, rows: term.rows, onEvent: ch });
    for (const d of pending.splice(0)) send(d);
  } catch (e) {
    tab.exited = true;
    term.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
    renderTabs();
  }
}

const dark = matchMedia("(prefers-color-scheme: dark)");
function termTheme() {
  return dark.matches
    ? { background: "#141416", foreground: "#e6e6ea", cursor: "#d97757", selectionBackground: "#d9775755" }
    : { background: "#fbfbfc", foreground: "#1d1d1f", cursor: "#d97757", selectionBackground: "#d9775740" };
}
dark.addEventListener("change", () => tabs.forEach((t) => (t.term.options.theme = termTheme())));

// keep the visible terminal sized to its pane, and the pills on their targets when the window resizes
new ResizeObserver(() => {
  active?.fit.fit();
  placeTabPill();
}).observe(el.panes);

smoothScroll(el.projects);
smoothScroll(el.home);

// ---------- start ----------
window.addEventListener("DOMContentLoaded", async () => {
  renderTabs();
  renderHome();
  renderSidebar(); // "Loading sessions..." while the first scan runs
  invoke("pty_kill_all"); // after a reload, end terminals the old page had open
  profiles = await invoke<Profile[]>("list_profiles");
  el.profile.innerHTML = `<option value="all">All profiles</option>` + profiles.map((p) => `<option value="${esc(p.dir)}">${esc(p.name)}</option>`).join("");
  await refresh();
  if (!selected && projects[0]) {
    selected = projects[0].path;
    renderSidebar();
    renderHome();
  }
  setInterval(refresh, 15000);
  window.addEventListener("focus", refresh);
});
