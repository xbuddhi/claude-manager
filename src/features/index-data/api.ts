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
    /** Projects are null when the generation equals `sinceGen` (nothing changed), or when only the changes
     *  since `sinceGen` are sent (`base`, `changed`, `order`). */
    get_index: { args: { sinceGen: number | null }; result: IndexSnapshot };
    /** Forgets every read position and reads all transcripts again; `index-changed` follows. */
    rescan_full: { args: undefined; result: null };
    count_for: { args: { profile: string | null }; result: number };
    /** The session's shown text at up to 600 characters (its `label` is the first 140); null when not listed. */
    session_text: { args: { profile: string; id: string }; result: string | null };
    /** Ids of the sessions whose text contains `query` (case-insensitive), newest first, at most 500. */
    search_sessions: { args: { query: string; profile: string | null }; result: string[] };
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
  if (heldGen !== null && snap.gen < heldGen) {
    if (index.error) store.set({ index: { ...index, error: null } });
    return;
  }
  let projects = snap.projects;
  if (projects !== null) {
    fillCwd(projects);
  } else if (snap.base !== null && snap.changed !== null && snap.order !== null) {
    projects =
      snap.base === heldGen && heldGen === index.gen ? mergeIndex(index.projects, snap.changed, snap.order) : null;
    if (projects === null) {
      // the changes do not fit what is held: ask for every project
      heldGen = null;
      again = true;
      return;
    }
  }
  if (projects === null) {
    if (index.error) store.set({ index: { ...index, error: null } });
    return;
  }
  heldGen = snap.gen;
  const loaded = projects.length ? "ok" : "empty";
  store.set({ index: { gen: snap.gen, projects, loaded, error: null } });
}

/**
 * Applies the changes the backend sent since the held generation: `changed` replaces (or adds) projects by
 * path, `order` lists every path in display order. Unchanged projects keep their object, so caches keyed
 * by them stay valid; when nothing changed at all, `held` itself is returned. Null when a path in `order`
 * is in neither list (the changes do not fit `held`). Fills the cwd of the changed projects.
 */
export function mergeIndex(held: readonly Project[], changed: Project[], order: readonly string[]): Project[] | null {
  fillCwd(changed);
  const fresh = new Map(changed.map((p) => [p.path, p]));
  const old = new Map(held.map((p) => [p.path, p]));
  const out: Project[] = [];
  let same = order.length === held.length;
  for (const [i, path] of order.entries()) {
    const p = fresh.get(path) ?? old.get(path);
    if (p === undefined) return null;
    same &&= p === held[i];
    out.push(p);
  }
  return same ? (held as Project[]) : out;
}

/**
 * The backend leaves a session's `cwd` out when it equals its project's path; put it back so every
 * consumer can read `s.cwd`. Sessions of an "Unknown folder" project (path = transcript slug) keep null.
 * Changes the freshly received objects in place.
 */
export function fillCwd(projects: Project[]): void {
  for (const p of projects) {
    for (const s of p.sessions) {
      if (s.cwd === null && p.path !== s.slug) s.cwd = p.path;
    }
  }
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
  texts.clear();
  textsPending.clear();
  lastFor = null;
}

/** Session texts fetched so far, by `<profile>/<id>`; an entry is stale once the session's `modified` moved on. */
const texts = new Map<string, { modified: number; text: string }>();
const TEXT_CACHE = 200;
const textsPending = new Map<string, Promise<string | null>>();
const textKey = (s: Session) => `${s.profile}/${s.id}`;

/** The session's full text (up to 600 characters) when it was fetched already and is still current. */
export function sessionTextCached(s: Session): string | undefined {
  const hit = texts.get(textKey(s));
  return hit !== undefined && hit.modified === s.modified ? hit.text : undefined;
}

/**
 * The session's full text, fetched on demand (the index only carries the 140-character label); null when
 * the backend no longer lists it. Kept for the next look at the same session.
 */
export function sessionText(s: Session): Promise<string | null> {
  const cached = sessionTextCached(s);
  if (cached !== undefined) return Promise.resolve(cached);
  // renders close together ask once
  const key = `${textKey(s)}@${s.modified}`;
  let pending = textsPending.get(key);
  if (!pending) {
    pending = fetchText(s).finally(() => textsPending.delete(key));
    textsPending.set(key, pending);
  }
  return pending;
}

async function fetchText(s: Session): Promise<string | null> {
  const res = await call("session_text", { profile: s.profile, id: s.id }, { quiet: true });
  if (!res.ok || res.value === null) return null;
  const key = textKey(s);
  texts.delete(key);
  texts.set(key, { modified: s.modified, text: res.value });
  if (texts.size > TEXT_CACHE) {
    const oldest = texts.keys().next().value;
    if (oldest !== undefined) texts.delete(oldest);
  }
  return res.value;
}

/**
 * Ids of the sessions whose text contains `query` (case-insensitive, matched by the backend over the full
 * text); `profile` null = all profiles. Empty on failure, so the search still shows label matches.
 */
export async function searchSessions(query: string, profile: string | null): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await call("search_sessions", { query: q, profile }, { quiet: true });
  return res.ok ? res.value : [];
}

// lowercased search text, computed once per object (objects are replaced only when the index changes)
const projectText = new WeakMap<Project, string>();
const sessionLabel = new WeakMap<Session, string>();

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
      !sessions.some((s) => lowerOf(sessionLabel, s, () => s.label).includes(q))
    ) {
      continue;
    }
    out.push(sessions === p.sessions ? p : { ...p, sessions });
  }
  return out;
}

// projectsFor results: the last list asked for, and each filtered project by the project it came from, so an
// unchanged project keeps its object across index updates (selectors and row updates compare by reference)
let lastFor: {
  profile: string | null;
  projects: readonly Project[];
  hidden: readonly string[];
  out: Project[];
} | null = null;
const filtered = new WeakMap<Project, { filter: string; out: Project }>();

/** Projects with only the sessions of `profile` (null = all profiles); pinned projects stay even when empty. */
export function projectsFor(
  profile: string | null,
  projects: readonly Project[] = store.get().index.projects,
): Project[] {
  const hiddenList = store.get().settings.hiddenProfiles;
  if (lastFor && lastFor.profile === profile && lastFor.projects === projects && lastFor.hidden === hiddenList) {
    return lastFor.out;
  }
  // "All profiles": every profile the app shows (not the ones removed from it)
  const hidden = profile === null ? new Set(hiddenList) : null;
  const keep = hidden ? (s: Session) => !hidden.has(s.profile) : (s: Session) => s.profile === profile;
  const filter = hidden ? `all\n${hiddenList.join("\n")}` : `one\n${profile}`;
  let out: Project[];
  if (hidden && !hidden.size) out = [...projects];
  else {
    out = [];
    for (const p of projects) {
      const seen = filtered.get(p);
      let next = seen?.filter === filter ? seen.out : undefined;
      if (!next) {
        const sessions = p.sessions.filter(keep);
        next = sessions.length === p.sessions.length ? p : { ...p, sessions };
        filtered.set(p, { filter, out: next });
      }
      if (next.sessions.length > 0 || next.pinned) out.push(next);
    }
  }
  lastFor = { profile, projects, hidden: hiddenList, out };
  return out;
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
  const hidden = new Set(store.get().settings.hiddenProfiles);
  if (counts.size) {
    if (profile !== null) return counts.get(profile) ?? 0;
    let n = 0;
    for (const [dir, c] of counts) if (!hidden.has(dir)) n += c;
    return n;
  }
  let n = 0;
  for (const p of store.get().index.projects) {
    n += p.sessions.filter((s) => (profile === null ? !hidden.has(s.profile) : s.profile === profile)).length;
  }
  return n;
}
