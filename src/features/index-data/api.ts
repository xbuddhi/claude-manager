// Public API of the session index (features may import this file, never the others in this folder).
// WP1 owns it. refreshIndex() is a TEMPORARY port of the prototype's polling refresh; WP1 replaces the
// internals with the event-driven index. The query helpers below already work on store.index; WP1 may
// change their bodies (e.g. to use its own lookups) but keeps the names and signatures.

import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { call } from "../../core/api";
import { store } from "../../core/store";

declare module "../../core/api" {
  interface Commands {
    list_projects: { args: undefined; result: Project[] };
  }
}

let inflight: Promise<void> | null = null;
let again = false;
let lastSignature = "";

async function load(): Promise<void> {
  const res = await call("list_projects", undefined, { quiet: true });
  const index = store.get().index;
  if (!res.ok) {
    store.set({
      index: { ...index, loaded: index.projects.length ? index.loaded : "error", error: res.error.message },
    });
    return;
  }
  const loaded = res.value.length ? "ok" : "empty";
  // unchanged data keeps the same object, so views do not re-render every poll
  const signature = JSON.stringify(res.value);
  if (signature === lastSignature) {
    if (index.loaded !== loaded || index.error) store.set({ index: { ...index, loaded, error: null } });
    return;
  }
  lastSignature = signature;
  store.set({ index: { gen: index.gen + 1, projects: res.value, loaded, error: null } });
}

/** Rescans now. Calls made while a scan runs are merged into one more scan after it. */
export function refreshIndex(): Promise<void> {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = load().finally(() => {
    inflight = null;
    if (again) {
      again = false;
      void refreshIndex();
    }
  });
  return inflight;
}

/** Projects with only the sessions of `profile` (null = all), matching `query` by name, path or session label. */
export function visibleProjects(projects: readonly Project[], profile: string | null, query: string): Project[] {
  const q = query.trim().toLowerCase();
  return projects
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => profile === null || s.profile === profile) }))
    .filter((p) => p.sessions.length > 0)
    .filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.sessions.some((s) => s.label.toLowerCase().includes(q)),
    );
}

/** Projects with only the sessions of `profile` (null = all profiles); pinned projects stay even when empty. */
export function projectsFor(
  profile: string | null,
  projects: readonly Project[] = store.get().index.projects,
): Project[] {
  if (profile === null) return [...projects];
  return projects
    .map((p) => ({ ...p, sessions: p.sessions.filter((s) => s.profile === profile) }))
    .filter((p) => p.sessions.length > 0 || p.pinned);
}

/** A session by id, with the project it is listed under. */
export function findSession(sessionId: string): { session: Session; project: Project } | null {
  for (const project of store.get().index.projects) {
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session) return { session, project };
  }
  return null;
}

/** Number of sessions of `profile` (null = all profiles), e.g. for the profile picker. */
export function countFor(profile: string | null): number {
  let n = 0;
  for (const p of store.get().index.projects) {
    n += profile === null ? p.sessions.length : p.sessions.filter((s) => s.profile === profile).length;
  }
  return n;
}
