// Public API of the session index (features may import this file, never the others in this folder).
// TEMPORARY: a port of the prototype's polling refresh; WP1 replaces the internals with the event-driven
// index and keeps these names.

import type { Profile } from "../../bindings/Profile";
import type { Project } from "../../bindings/Project";
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

/** The profile a new session in `project` starts with: the one in view, else the one used there last. */
export function startProfile(project: Project, current: string | null, profiles: readonly Profile[]): string {
  return current ?? project.sessions[0]?.profile ?? profiles[0]?.dir ?? "";
}
