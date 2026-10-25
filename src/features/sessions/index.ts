// The "Sessions" view of the main card: the sessions of the folder or project selected in the sidebar,
// a details pane, and the actions on them (new, continue, resume, fork, delete).

import { on } from "../../core/bus";
import { registerCommand } from "../../core/commands";
import { h } from "../../core/dom";
import { registerShortcut } from "../../core/keyboard";
import { scroller, settleIn } from "../../core/motion";
import { profileName } from "../../core/profiles";
import { store } from "../../core/store";
import { registerView } from "../../core/views";
import { findSession, projectsFor } from "../index-data/api";
import { sessionLevel } from "../live/api";
import { deleteSelected, doNew, doResume, resumeSelected, selectedSessions } from "./actions";
import { createDetails, type Details } from "./details";
import { type Header, mountHeader } from "./header";
import { showSessionMenu } from "./menus";
import { buildScope } from "./model";
import "./sessions.css";
import "./state";
import { createTable, type Table } from "./table";

const MINUTE = 60_000;

let table: Table;
let details: Details;
let page: HTMLElement;
let header: Header | null = null;

function renderDetails() {
  const s = store.get();
  const selected = selectedSessions();
  const first = selected[0];
  // until the index is there, say so instead of the usual hint
  const { loaded, error } = s.index;
  const hint =
    loaded === "loading"
      ? "Loading sessions..."
      : loaded === "error"
        ? `Could not read the sessions. ${error ?? ""}`
        : undefined;
  details.render(s.sessionsScope, selected, first ? sessionLevel(first.id) : 0, profileName, hint);
}

function recomputeScope() {
  const s = store.get();
  const projects = projectsFor(s.currentProfile, s.index.projects);
  store.set({ sessionsScope: buildScope(s.sidebarSelection, projects, s.platform.os) });
}

/** Selects the row asked for by sessionsWanted (search picked a session) once the table lists it. */
function applyWanted() {
  const id = store.get().sessionsWanted;
  if (!id || !table.list.rows().some((r) => r.id === id)) return;
  table.list.select([id]);
  table.list.scrollToKey(id);
  store.set({ sessionsWanted: null, sessionsSelected: [id] });
}

/** Where the group folder picker opens for a keyboard New Session: under the button when it is on screen. */
function newAnchor() {
  const s = store.get();
  return header && s.activeTerminal === null && s.view === "sessions" ? { anchor: header.newAnchor() } : undefined;
}

export function mount(): void {
  registerView({
    id: "sessions",
    title: "Sessions",
    order: 0,
    mount(body) {
      body.classList.add("ses-view");
      table = createTable({
        onSelect: (ids) => store.set({ sessionsSelected: ids }),
        onActivate: (s) => void doResume(s),
        onMenu: (s, e) => showSessionMenu(s, { x: e.clientX, y: e.clientY }),
        onDelete: deleteSelected,
      });
      scroller(table.list.el);
      details = createDetails({
        onResume: () => resumeSelected(),
        onFork: () => resumeSelected({ fork: true }),
        onDelete: deleteSelected,
      });
      page = h("div", { class: "ses-page" }, table.el, details.el);
      body.append(page);
    },
    headerActions(el) {
      header = mountHeader(el);
    },
  });

  store.select(
    (s) => s.sessionsScope,
    (scope) => {
      table.setRows(scope?.sessions ?? [], scope?.kind ?? "folder");
      applyWanted();
      renderDetails();
    },
    { immediate: true },
  );
  store.select((s) => [s.index, s.currentProfile, s.sidebarSelection, s.platform.os] as const, recomputeScope, {
    equals: (a, b) => a.every((v, i) => v === b[i]),
  });
  recomputeScope();
  store.select((s) => s.sessionsWanted, applyWanted);
  store.select((s) => s.sessionsSelected, renderDetails);
  store.select((s) => s.index.loaded, renderDetails);
  // running state and profile names show in the rows and the pane
  store.select(
    (s) => [s.live, s.profiles] as const,
    () => {
      table.refresh();
      renderDetails();
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  // "5m ago" keeps up with the clock
  setInterval(() => {
    if (!document.hidden) table.refresh();
  }, MINUTE);

  // another folder, or back from a terminal: the content settles in
  store.select(
    (s) => s.sidebarSelection?.key ?? null,
    () => settleIn(page),
  );
  store.select(
    (s) => s.activeTerminal === null,
    (home) => home && settleIn(page),
  );

  on("session:resume", ({ sessionId, mode, fork }) => {
    const found = findSession(sessionId);
    if (found) void doResume(found.session, { mode, fork });
  });
  registerCommand({
    id: "session:new",
    title: "New Session",
    run: () => doNew(undefined, newAnchor()),
    enabled: () => store.get().sessionsScope !== null,
  });
  registerShortcut({ id: "session:new", keys: "CmdOrCtrl+T" });
}
