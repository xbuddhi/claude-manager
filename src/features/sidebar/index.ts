// Sidebar: the "Workspace" card with the profile filter and the project list.
// TEMPORARY port of the prototype's sidebar, kept behaviour for behaviour (gliding selection pill, spring
// expand/collapse, double-click or + for a new session, click a session to resume). WP4 replaces it with the
// projects/groups tree on ui/list.ts.

import type { Project } from "../../bindings/Project";
import { emit } from "../../core/bus";
import { $, cssEsc, html, setHtml } from "../../core/dom";
import { ago, plural } from "../../core/format";
import { icon } from "../../core/icons";
import { animate, Spring, scroller } from "../../core/motion";
import { profileName } from "../../core/profiles";
import { type AppState, store } from "../../core/store";
import { setSubtitle } from "../../core/titlebar";
import { refreshIndex, startProfile, visibleProjects } from "../index-data/api";
import { mountSearch } from "./search";
import "./sidebar.css";
import "./state";

const el = {} as { profile: HTMLSelectElement; projects: HTMLElement; list: HTMLElement; pill: HTMLElement };
const expanded = new Set<string>();

const selectedPath = () => store.get().sidebarSelection?.path ?? null;
const visible = (s: AppState = store.get()) => visibleProjects(s.index.projects, s.currentProfile, s.searchQuery);
const findProject = (path: string | undefined) => store.get().index.projects.find((p) => p.path === path);

// ---------- motion ----------
// the selection pill glides to the selected project (same springs as the Windows sidebar)
const selTop = new Spring(0.3, 0.82, 0.05);
const selH = new Spring(0.3, 0.9, 0.05);
const selA = new Spring(0.2, 1, 0.003);
let selShown = false;

function placeSelPill(snap = false) {
  const path = selectedPath();
  const row = path ? el.list.querySelector<HTMLElement>(`.sb-project[data-project="${cssEsc(path)}"]`) : null;
  if (!row) {
    animate(selA, 0, (v) => {
      el.pill.style.opacity = String(v);
    });
    selShown = false;
    return;
  }
  const top = row.offsetTop;
  const h = row.offsetHeight;
  const draw = () => {
    el.pill.style.transform = `translateY(${selTop.value}px)`;
    el.pill.style.height = `${selH.value}px`;
  };
  if (snap || !selShown) {
    selTop.snap(top);
    selH.snap(h);
    draw();
  } else {
    animate(selTop, top, draw);
    animate(selH, h, draw);
  }
  selShown = true;
  animate(selA, 1, (v) => {
    el.pill.style.opacity = String(v);
  });
}

// ---------- rendering ----------
function sessionRows(p: Project) {
  return p.sessions
    .slice(0, 30)
    .map(
      (s) =>
        html`<div class="sb-row sb-session" data-session="${s.id}" data-tip="${s.label}"><span class="sb-label">${s.label}</span><span class="sb-meta">${ago(s.modified)}</span></div>`,
    );
}

function emptyText(s: AppState): string {
  if (s.index.loaded === "loading") return "Loading sessions...";
  if (s.index.loaded === "error" && !s.index.projects.length) return `Could not read sessions\n${s.index.error ?? ""}`;
  if (s.index.loaded === "empty") return "No Claude Code sessions found in ~/.claude*";
  return "No matches";
}

function render() {
  const s = store.get();
  const list = visible(s);
  updateSubtitle(s, list);
  if (!list.length) {
    const retry = s.index.loaded === "error" ? html`<button class="sb-retry" type="button">Retry</button>` : "";
    setHtml(el.list, html`<div class="sb-empty">${emptyText(s)}${retry}</div>`);
    placeSelPill();
    return;
  }
  const selected = selectedPath();
  setHtml(
    el.list,
    html`${list.map((p) => {
      const open = expanded.has(p.path);
      return html`<div class="sb-row sb-project${p.path === selected ? " selected" : ""}" data-project="${p.path}" data-tip="${p.path}">
          <span class="sb-chev${open ? " open" : ""}" data-toggle="${p.path}">${icon("chevron")}</span>
          <span class="sb-ico">${icon("folder")}</span>
          <span class="sb-label">${p.name}</span>
          <span class="sb-meta">${ago(p.modified)}</span>
          <button class="sb-mini" type="button" data-new="${p.path}" data-tip="New session" aria-label="New session">${icon("plus")}</button>
        </div>${open ? html`<div class="sb-group" data-group="${p.path}">${sessionRows(p)}</div>` : ""}`;
    })}`,
  );
  placeSelPill(); // glides if the selection moved, stays put otherwise
}

function updateSubtitle(s: AppState, list: Project[]) {
  if (s.index.loaded === "loading") return;
  const who = s.currentProfile === null ? "All profiles" : profileName(s.currentProfile);
  const sessions = list.reduce((n, p) => n + p.sessions.length, 0);
  setSubtitle(`${who} · ${plural(sessions, "session")} · ${plural(list.length, "folder")}`);
}

function renderProfiles(s: AppState) {
  const value = s.currentProfile ?? "all";
  setHtml(
    el.profile,
    html`<option value="all">All profiles</option>${s.profiles.map((p) => html`<option value="${p.dir}">${p.name}</option>`)}`,
  );
  el.profile.value = value;
}

// open/close a project's session list with a spring on its height
function toggleProject(path: string) {
  const row = el.list.querySelector<HTMLElement>(`.sb-project[data-project="${cssEsc(path)}"]`);
  const p = visible().find((x) => x.path === path);
  const chev = row?.querySelector(".sb-chev");
  if (!row || !p || !chev) return;
  let group = el.list.querySelector<HTMLElement>(`.sb-group[data-group="${cssEsc(path)}"]`);
  const s = new Spring(0.34, 0.9, 0.5);
  if (expanded.has(path)) {
    expanded.delete(path);
    chev.classList.remove("open");
    if (!group) return;
    const g = group;
    s.snap(g.offsetHeight);
    animate(
      s,
      0,
      (v) => {
        g.style.height = `${Math.max(0, v)}px`;
        placeSelPill(true);
      },
      () => {
        g.remove();
        placeSelPill(true);
      },
    );
  } else {
    expanded.add(path);
    chev.classList.add("open");
    if (!group) {
      row.insertAdjacentHTML(
        "afterend",
        html`<div class="sb-group" data-group="${path}" style="height:0">${sessionRows(p)}</div>`.value,
      );
      group = row.nextElementSibling as HTMLElement;
    }
    const g = group;
    animate(
      s,
      g.scrollHeight,
      (v) => {
        g.style.height = `${Math.max(0, v)}px`;
        placeSelPill(true);
      },
      () => {
        g.style.height = "";
        placeSelPill(true);
      },
    );
  }
}

// ---------- actions ----------
function select(path: string) {
  const p = findProject(path);
  if (!p) return;
  store.set({ sidebarSelection: { kind: "folder", key: `f:${p.path.toLowerCase()}`, path: p.path, name: p.name } });
}

function newSession(path: string | undefined) {
  const p = findProject(path);
  if (!p) return;
  const s = store.get();
  emit("launch", { dir: p.path, profile: startProfile(p, s.currentProfile, s.profiles) });
}

function resume(sessionId: string | undefined) {
  for (const p of store.get().index.projects) {
    const s = p.sessions.find((x) => x.id === sessionId);
    if (!s) continue;
    emit("launch", {
      dir: s.cwd ?? p.path,
      profile: s.profile,
      resume: { sessionId: s.id, fork: false },
      label: s.label,
    });
    return;
  }
}

function onClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  if (t.closest(".sb-retry")) return void refreshIndex();
  const newBtn = t.closest<HTMLElement>("[data-new]");
  if (newBtn) return newSession(newBtn.dataset.new);
  const toggle = t.closest<HTMLElement>("[data-toggle]");
  if (toggle?.dataset.toggle) return toggleProject(toggle.dataset.toggle);
  const sess = t.closest<HTMLElement>("[data-session]");
  if (sess) return resume(sess.dataset.session);
  const proj = t.closest<HTMLElement>("[data-project]");
  if (proj?.dataset.project) select(proj.dataset.project);
}

function onDoubleClick(e: MouseEvent) {
  const t = e.target as HTMLElement;
  const proj = t.closest<HTMLElement>("[data-project]");
  if (proj && !t.closest("[data-new],[data-toggle]")) newSession(proj.dataset.project);
}

// ---------- mount ----------
export function mount(): void {
  const slot = $("#sidebar-slot");
  setHtml(
    slot,
    html`<header class="sb-head">
        <span class="sb-title">Workspace</span>
        <select class="sb-profile" aria-label="Profile"></select>
      </header>
      <nav class="sb-projects" aria-label="Projects">
        <div class="sb-pill"></div>
        <div class="sb-list"></div>
      </nav>`,
  );
  el.profile = $<HTMLSelectElement>(".sb-profile", slot);
  el.projects = $(".sb-projects", slot);
  el.list = $(".sb-list", slot);
  el.pill = $(".sb-pill", slot);
  mountSearch($("#tb-search-slot"));

  el.projects.addEventListener("click", onClick);
  el.projects.addEventListener("dblclick", onDoubleClick);
  el.profile.addEventListener("change", () =>
    store.set({ currentProfile: el.profile.value === "all" ? null : el.profile.value }),
  );
  scroller(el.projects);

  store.select(
    (s) => s.profiles,
    () => renderProfiles(store.get()),
    { immediate: true },
  );
  store.select(
    (s) => [s.index, s.currentProfile, s.searchQuery, s.profiles] as const,
    () => render(),
    { equals: (a, b) => a.every((v, i) => v === b[i]), immediate: true },
  );
  store.select(
    (s) => s.sidebarSelection?.path ?? null,
    (path) => {
      for (const r of el.list.querySelectorAll<HTMLElement>(".sb-project")) {
        r.classList.toggle("selected", r.dataset.project === path);
      }
      placeSelPill();
    },
  );
  // the first scan picks the most recent project, as the prototype did
  store.select(
    (s) => s.index.gen,
    () => {
      const first = visible()[0];
      if (!store.get().sidebarSelection && first) select(first.path);
    },
  );
  // the pill measures rows, so it waits for the list to be visible again after a terminal was in front
  store.select(
    (s) => s.activeTerminal === null,
    (home) => home && placeSelPill(true),
  );
}
