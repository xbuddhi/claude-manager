// Public API of the session index (features may import this file, never the others in this folder).
// The backend keeps the index current with a file watcher and emits `index-changed` with a new generation;
// refreshIndex() then fetches the projects only when they changed. No polling.

import type { IndexChanged } from "../../bindings/IndexChanged";
import type { IndexSnapshot } from "../../bindings/IndexSnapshot";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { call } from "../../core/api";
import { store } from "../../core/store";

declare module "../../core/api" {
  interface Commands {
    /** Projects are null when the generation equals `sinceGen` (nothing changed). */
    get_index: { args: { sinceGen: number | null }; result: IndexSnapshot };
    /** Forgets every read position and reads all transcripts again; `index-changed` follows. */
    rescan_full: { args: undefined; result: null };
    count_for: { args: { profile: string | null }; result: number };
  }
  interface BackendEvents {
    "index-changed": IndexChanged;
  }
}

let inflight: Promise<void> | null = null;
let again = false;
/** Generation of the projects in the store; null until the first ones arrived. */
let heldGen: number | null = null;
let counts = new Map<string, number>();

async function load(): Promise<void> {
  const res = await call("get_index", { sinceGen: heldGen }, { quiet: true });
  const index = store.get().index;
  if (!res.ok) {
    const loaded = heldGen === null ? "error" : index.loaded;
    store.set({ index: { ...index, loaded, error: res.error.message } });
    return;
  }
  const snap = res.value;
  // not ready: the first scan still runs and `index-changed` follows
  if (!snap.ready) return;
  counts = new Map(snap.counts.map((c) => [c.profile, c.count]));
  // an older answer than what is shown changes nothing
  if (snap.projects === null || (heldGen !== null && snap.gen < heldGen)) {
    if (index.error) store.set({ index: { ...index, error: null } });
    return;
  }
  heldGen = snap.gen;
  const loaded = snap.projects.length ? "ok" : "empty";
  store.set({ index: { gen: snap.gen, projects: snap.projects, loaded, error: null } });
}

/** Fetches the index if it changed. Calls made while one runs are merged into one more after it. */
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

/** Reads every transcript again (F5). The new index arrives through `index-changed`. */
export async function rescanIndex(): Promise<void> {
  await call("rescan_full");
}

/** For tests: forget what was fetched. */
export function resetIndexClient(): void {
  inflight = null;
  again = false;
  heldGen = null;
  counts = new Map();
}

// lowercased search text, computed once per object (objects are replaced only when the index changes)
const projectText = new WeakMap<Project, string>();
const sessionText = new WeakMap<Session, string>();

function lowerOf<T extends object>(cache: WeakMap<T, string>, key: T, text: () => string): string {
  let v = cache.get(key);
  if (v === undefined) {
    v = text().toLowerCase();
    cache.set(key, v);
  }
  return v;
}

/** Projects with only the sessions of `profile` (null = all), matching `query` by name, path or session
 *  label. Pinned folders stay even without sessions. */
export function visibleProjects(projects: readonly Project[], profile: string | null, query: string): Project[] {
  const q = query.trim().toLowerCase();
  const out: Project[] = [];
  for (const p of projects) {
    const sessions = profile === null ? p.sessions : p.sessions.filter((s) => s.profile === profile);
    if (!sessions.length && !p.pinned) continue;
    if (
      q &&
      !lowerOf(projectText, p, () => `${p.name}\n${p.path}`).includes(q) &&
      !sessions.some((s) => lowerOf(sessionText, s, () => s.label).includes(q))
    ) {
      continue;
    }
    out.push(sessions === p.sessions ? p : { ...p, sessions });
  }
  return out;
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
  if (counts.size) {
    if (profile !== null) return counts.get(profile) ?? 0;
    let n = 0;
    for (const c of counts.values()) n += c;
    return n;
  }
  let n = 0;
  for (const p of store.get().index.projects) {
    n += profile === null ? p.sessions.length : p.sessions.filter((s) => s.profile === profile).length;
  }
  return n;
}
