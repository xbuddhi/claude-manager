// What the search dropdown lists for a query (Get-SearchItems): PROJECTS (groups, at most 4), FOLDERS (at
// most 6) and SESSIONS (at most 8). Matching is a case-insensitive substring; names that start with the
// query come first. Sessions match by label here, and by their full text through the ids the backend
// found (`textMatches`, search_sessions). Pure, so it is tested without the DOM.

import type { Group } from "../../bindings/Group";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { ago, leaf, plural } from "../../core/format";
import { pathKey } from "../../core/paths";

export const LIMITS = { groups: 4, folders: 6, sessions: 8 } as const;

export type SearchItem =
  | { kind: "section"; title: string }
  | { kind: "empty"; title: string }
  | { kind: "group"; title: string; sub: string; name: string }
  | { kind: "folder"; title: string; sub: string; right: string; live: number; path: string; group: string | null }
  | { kind: "session"; title: string; sub: string; right: string; live: number; session: Session };

export type PickItem = Extract<SearchItem, { kind: "group" | "folder" | "session" }>;

export function pickable(item: SearchItem | undefined): item is PickItem {
  return !!item && (item.kind === "group" || item.kind === "folder" || item.kind === "session");
}

export interface SearchData {
  groups: readonly Group[];
  /** Projects of the profile in view. */
  projects: readonly Project[];
  /** Live level by session id. */
  live: Readonly<Record<string, { level: number }>>;
  /** Highest live level by folder key (pathKey). */
  liveCwd: Readonly<Record<string, number>>;
  os: string;
  profileName(dir: string): string;
  /** Projects hold every session (no profile filter): their `modified` is their newest session's time. */
  unfiltered?: boolean;
  /** Ids of the sessions whose full text matches the query (from the backend); labels are matched here. */
  textMatches?: ReadonlySet<string>;
  now?: number;
}

// lower-cased text, cached per object: typing does not re-lower every label on each keystroke
const lowered = new WeakMap<object, string>();
function lower(owner: object, text: string): string {
  let v = lowered.get(owner);
  if (v === undefined) {
    v = text.toLowerCase();
    lowered.set(owner, v);
  }
  return v;
}

/** 0 when `name` starts with the query, else 1. */
const rank = (name: string, q: string) => (name.startsWith(q) ? 0 : 1);

/**
 * The first `k` items in `cmp` order, as a stable sort and slice would give them, without sorting every
 * match (a short query matches most sessions).
 */
export function topK<T>(items: Iterable<T>, k: number, cmp: (a: T, b: T) => number): T[] {
  const out: T[] = [];
  if (k <= 0) return out;
  for (const x of items) {
    if (out.length === k && cmp(out[k - 1] as T, x) <= 0) continue;
    let i = out.length;
    while (i > 0 && cmp(out[i - 1] as T, x) > 0) i--;
    out.splice(i, 0, x);
    if (out.length > k) out.pop();
  }
  return out;
}

/** The project (group) name of each folder by pathKey; the first group listing a folder wins. */
function groupNames(groups: readonly Group[], os: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) {
    for (const f of g.folders) {
      const key = pathKey(f, os);
      if (!out.has(key)) out.set(key, g.name);
    }
  }
  return out;
}

/** The parent folder's name: "C:\\code\\app" gives "code". */
function parentLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parent = trimmed.slice(0, Math.max(0, trimmed.search(/[\\/][^\\/]*$/)));
  return parent ? leaf(parent) : "";
}

export function searchItems(query: string, d: SearchData): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const now = d.now ?? Date.now();
  const out: SearchItem[] = [];

  const groups = d.groups
    .map((g) => ({ g, name: g.name.toLowerCase() }))
    .filter((x) => x.name.includes(q))
    .sort((a, b) => rank(a.name, q) - rank(b.name, q))
    .slice(0, LIMITS.groups);
  if (groups.length) {
    out.push({ kind: "section", title: "PROJECTS" });
    for (const { g } of groups) {
      out.push({ kind: "group", title: g.name, sub: plural(g.folders.length, "folder"), name: g.name });
    }
  }

  // the newest session in view: with a profile filter p.modified would count every profile's sessions
  const last = (p: Project) => (d.unfiltered ? p.modified : p.sessions.reduce((m, s) => Math.max(m, s.modified), 0));
  const matched: Array<{ p: Project; name: string; last: number }> = [];
  for (const p of d.projects) {
    const name = lower(p, leaf(p.path));
    if (name.includes(q)) matched.push({ p, name, last: last(p) });
  }
  const folders = topK(matched, LIMITS.folders, (a, b) => rank(a.name, q) - rank(b.name, q) || b.last - a.last);
  if (folders.length) {
    out.push({ kind: "section", title: "FOLDERS" });
    const groupByKey = groupNames(d.groups, d.os);
    for (const { p, last } of folders) {
      const group = groupByKey.get(pathKey(p.path, d.os)) ?? null;
      out.push({
        kind: "folder",
        title: leaf(p.path),
        sub: group ? `in ${group}` : parentLeaf(p.path),
        right: p.sessions.length ? ago(last, now) : "",
        live: d.liveCwd[pathKey(p.path, d.os)] ?? 0,
        path: p.path,
        group,
      });
    }
  }

  const byText = d.textMatches;
  function* matching() {
    for (const p of d.projects) {
      for (const s of p.sessions) {
        if (s.label !== "(no prompt)" && (byText?.has(s.id) || lower(s, s.label).includes(q))) yield s;
      }
    }
  }
  const sessions = topK(matching(), LIMITS.sessions, (a, b) => b.modified - a.modified);
  if (sessions.length) {
    out.push({ kind: "section", title: "SESSIONS" });
    for (const s of sessions) {
      const live = d.live[s.id]?.level ?? 0;
      out.push({
        kind: "session",
        title: s.label,
        sub: `${s.cwd ? leaf(s.cwd) : ""}  ·  ${d.profileName(s.profile)}`,
        right: live === 2 ? "working" : live ? "open" : ago(s.modified, now),
        live,
        session: s,
      });
    }
  }

  if (!out.length) out.push({ kind: "empty", title: `No results for '${query.trim()}'` });
  return out;
}

/** The next pickable index from `from` going `delta` (±1), wrapping around; -1 when nothing is pickable. */
export function nextPick(items: readonly SearchItem[], from: number, delta: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + delta * step) % n) + n) % n;
    if (pickable(items[i])) return i;
  }
  return -1;
}
