// What the search dropdown lists for a query (Get-SearchItems): PROJECTS (groups, at most 4), FOLDERS (at
// most 6) and SESSIONS (at most 8). Matching is a case-insensitive substring; names that start with the
// query come first. Pure, so it is tested without the DOM.

import type { Group } from "../../bindings/Group";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { ago, leaf, plural } from "../../core/format";
import { pathKey, samePath } from "../../core/paths";

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

/** The project (group) a folder belongs to, if any. */
export function groupOf(path: string, groups: readonly Group[], os: string): Group | undefined {
  return groups.find((g) => g.folders.some((f) => samePath(f, path, os)));
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

  const folders = d.projects
    .map((p) => ({ p, name: lower(p, leaf(p.path)) }))
    .filter((x) => x.name.includes(q))
    .sort((a, b) => rank(a.name, q) - rank(b.name, q) || b.p.modified - a.p.modified)
    .slice(0, LIMITS.folders);
  if (folders.length) {
    out.push({ kind: "section", title: "FOLDERS" });
    for (const { p } of folders) {
      const group = groupOf(p.path, d.groups, d.os)?.name ?? null;
      out.push({
        kind: "folder",
        title: leaf(p.path),
        sub: group ? `in ${group}` : parentLeaf(p.path),
        right: p.sessions.length ? ago(p.modified, now) : "",
        live: d.liveCwd[pathKey(p.path, d.os)] ?? 0,
        path: p.path,
        group,
      });
    }
  }

  const sessions = d.projects
    .flatMap((p) => p.sessions)
    .filter((s) => s.label !== "(no prompt)" && lower(s, s.full).includes(q))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, LIMITS.sessions);
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
