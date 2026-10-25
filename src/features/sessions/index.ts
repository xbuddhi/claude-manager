// The "Sessions" view of the main card: the selected project's sessions.
// TEMPORARY port of the prototype's Home page (header with New Session, a table, click a row to resume,
// content settles in when it changes). WP5 replaces it with the virtualized table, details pane and actions.

import type { Project } from "../../bindings/Project";
import { emit } from "../../core/bus";
import { $, html, setHtml } from "../../core/dom";
import { ago, size } from "../../core/format";
import { scroller, settleIn } from "../../core/motion";
import { profileName } from "../../core/profiles";
import { store } from "../../core/store";
import { registerView } from "../../core/views";
import { button } from "../../ui/button";
import { visibleProjects } from "../index-data/api";
import "./sessions.css";

let body: HTMLElement;

function current(): Project | undefined {
  const s = store.get();
  const path = s.sidebarSelection?.path;
  return visibleProjects(s.index.projects, s.currentProfile, s.searchQuery).find((p) => p.path === path);
}

function newSession(p: Project) {
  emit("launch", { dir: p.path }); // the handler picks the start profile
}

function resume(p: Project, sessionId: string | undefined) {
  const session = p.sessions.find((x) => x.id === sessionId);
  if (!session) return;
  emit("launch", {
    dir: session.cwd ?? p.path,
    profile: session.profile,
    resume: { sessionId: session.id, fork: false },
    label: session.label,
  });
}

function render(animated: boolean) {
  const p = current();
  if (!p) {
    setHtml(
      body,
      html`<div class="ses-hint"><h1>Claude Manager</h1><p>Pick a project on the left to see its sessions.<br>Double-click a project to start a new session, or click a session to resume it.</p></div>`,
    );
  } else {
    setHtml(
      body,
      html`<div class="ses-page">
        <header class="ses-head">
          <div class="ses-title"><h2>${p.name}</h2><div class="ses-path selectable">${p.path}</div></div>
        </header>
        <div class="ses-table" role="table" aria-label="Sessions">
          <div class="ses-thead" role="row"><span>Session</span><span>Messages</span><span>Last active</span><span>Profile</span><span>Size</span></div>
          ${p.sessions.map(
            (s) => html`<div class="ses-row" role="row" data-id="${s.id}" data-tip="Click to resume">
              <span class="ses-label">${s.label}</span><span>${s.count}</span><span>${ago(s.modified)}</span><span>${profileName(s.profile)}</span><span>${size(s.sizeKb)}</span>
            </div>`,
          )}
        </div>
      </div>`,
    );
    $(".ses-head", body).append(
      button({ label: "New Session", icon: "plus", kind: "primary", onClick: () => newSession(p) }),
    );
  }
  if (animated) settleIn(body.firstElementChild as HTMLElement | null);
}

export function mount(): void {
  registerView({
    id: "sessions",
    title: "Sessions",
    order: 0,
    mount(el) {
      body = el;
      body.classList.add("ses-body");
      scroller(body);
      body.addEventListener("click", (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(".ses-row");
        const p = current();
        if (row && p) resume(p, row.dataset.id);
      });
    },
  });

  render(false);
  // data or filters changed: redraw in place
  store.select(
    (s) => [s.index, s.currentProfile, s.searchQuery, s.profiles] as const,
    () => render(false),
    { equals: (a, b) => a.every((v, i) => v === b[i]) },
  );
  // another project, or back from a terminal: the new content settles in
  store.select(
    (s) => s.sidebarSelection?.path ?? null,
    () => render(true),
  );
  store.select(
    (s) => s.activeTerminal === null,
    (home) => home && render(true),
  );
}
