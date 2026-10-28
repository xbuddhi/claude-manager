// The sidebar tree as plain data: PROJECTS (each group with its folders nested) then FOLDERS (every folder
// not in a group). A port of the Windows app's Tree.Build (MacUI.cs) with no DOM, so it is unit tested.

import type { Group } from "../../bindings/Group";
import type { PathKind } from "../../bindings/PathKind";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { leaf } from "../../core/format";
import { normPath, pathKey } from "../../core/paths";
import { S } from "./strings";

export type LiveLevel = 0 | 1 | 2;

/** One folder of the sidebar: a folder sessions ran in, a pinned folder, or a folder a group references. */
export interface FolderInfo {
  path: string;
  name: string;
  /** Newest session time (ms); 0 without sessions. */
  last: number;
  pinned: boolean;
  missing: boolean;
  /** Newest first. */
  sessions: Session[];
}

export interface GroupInfo {
  name: string;
  folders: FolderInfo[];
  /** Sessions of all its folders, newest first. */
  sessions: Session[];
  last: number;
}

export type RowKind = "section" | "group" | "folder" | "more" | "hint";
export type RowIcon = "folder" | "star" | "warning" | "group";

export interface TreeRow {
  kind: RowKind;
  key: string;
  title: string;
  /** px: section 30, group 34, folder 32, more/hint 28 (the empty-projects hint 30). */
  height: number;
  /** Nesting level: 1 for a folder in a group and its "Show more" / hint rows. */
  indent: number;
  /** Name of the group the row belongs to (folders, "more" and hints inside a group). */
  group?: string;
  folder?: FolderInfo;
  info?: GroupInfo;
  icon?: RowIcon;
  /** Group: total sessions. */
  badge?: string;
  /** Folder: time of its newest session. */
  detail?: string;
  /** Open (true) or closed (false) chevron; undefined = the row has none. */
  open?: boolean;
  acceptsDrop: boolean;
  draggable: boolean;
  /** Missing folder: drawn dimmed. */
  dim: boolean;
  live: LiveLevel;
  /** The last nested row of its block (its guide line stops half way). */
  lastChild: boolean;
}

export interface FolderInput {
  /** Projects of the profile in view (sessions already filtered). */
  projects: readonly Project[];
  /** settings.pinned */
  pinned: readonly string[];
  os: string;
  /** Known kinds of folders the index does not list, by pathKey. */
  kinds?: Readonly<Record<string, PathKind>>;
}

export interface TreeInput extends FolderInput {
  groups: readonly Group[];
  /** settings.ungroupedCollapsed */
  foldersCollapsed: boolean;
  /** settings.hidden: folders left out of FOLDERS (a project's folders are always shown). */
  hidden?: readonly string[];
  /** The hidden folders are listed (dimmed) after the others (session only). */
  showHidden?: boolean;
  /** Lower-cased names of groups showing all their folders (session only). */
  showAll: ReadonlySet<string>;
  /** Search text; '' in the sidebar (search shows its results in its own dropdown). */
  query: string;
  /** Highest live level per folder, by pathKey (store.liveCwd). */
  liveCwd: Readonly<Record<string, 1 | 2>>;
  /** `ago()` of a time; a parameter so tests can fix the clock. */
  ago: (ms: number) => string;
}

/** Folders listed before "Show N more" appears. */
export const FOLDER_LIMIT = 6;
/** Folders shown when a group has more than FOLDER_LIMIT. */
export const FOLDER_SHOWN = 5;

export const groupKey = (name: string) => `g:${name.toLowerCase()}`;
export const folderKey = (path: string, os: string) => `f:${pathKey(path, os)}`;
export const moreKey = (name: string) => `m:${name.toLowerCase()}`;
export const PROJECTS_KEY = "s:projects";
export const FOLDERS_KEY = "s:folders";
/** The "Show N hidden" row at the end of FOLDERS. */
export const HIDDEN_KEY = "m:hidden";

const missingKind = (kind: PathKind | undefined) => kind !== undefined && kind !== "dir";

/**
 * The folder list: every project of the index plus the pinned folders, flagged pinned (a pinned folder is
 * listed even without sessions). Pinned first, then by last activity, newest first.
 */
export function folderList(input: FolderInput): FolderInfo[] {
  const { os, kinds = {} } = input;
  const map = new Map<string, FolderInfo>();
  for (const p of input.projects) {
    const key = pathKey(p.path, os);
    const sessions = [...p.sessions].sort((a, b) => b.modified - a.modified);
    const last = sessions[0]?.modified ?? 0;
    const known = map.get(key);
    if (known) {
      // two spellings of one folder: merge them
      known.sessions = [...known.sessions, ...sessions].sort((a, b) => b.modified - a.modified);
      known.last = Math.max(known.last, last);
      known.pinned ||= p.pinned;
      continue;
    }
    map.set(key, {
      path: normPath(p.path),
      name: p.name || leaf(p.path),
      last,
      pinned: p.pinned,
      missing: p.missing,
      sessions,
    });
  }
  for (const raw of input.pinned) {
    if (!raw.trim()) continue;
    const key = pathKey(raw, os);
    const known = map.get(key);
    if (known) known.pinned = true;
    else {
      const path = normPath(raw);
      map.set(key, { path, name: leaf(path), last: 0, pinned: true, missing: missingKind(kinds[key]), sessions: [] });
    }
  }
  return [...map.values()].sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.last - a.last));
}

/**
 * Pinned and grouped folders the index does not list: whether they still exist has to be looked up
 * (path_kinds), since only the index knows it for the rest.
 */
export function unlistedPaths(
  projects: readonly Project[],
  pinned: readonly string[],
  groups: readonly Group[],
  os: string,
): string[] {
  const listed = new Set(projects.map((p) => pathKey(p.path, os)));
  const out = new Map<string, string>();
  for (const raw of [...pinned, ...groups.flatMap((g) => g.folders)]) {
    if (!raw.trim()) continue;
    const key = pathKey(raw, os);
    if (!listed.has(key) && !out.has(key)) out.set(key, normPath(raw));
  }
  return [...out.values()];
}

const has = (text: string | null | undefined, q: string) => !!text && text.toLowerCase().includes(q.toLowerCase());

function matches(f: FolderInfo, q: string): boolean {
  if (!q || has(f.name, q)) return true;
  return f.sessions.some((s) => s.label !== "(no prompt)" && has(s.full, q));
}

const maxLive = (a: LiveLevel, b: LiveLevel): LiveLevel => (a > b ? a : b);

function folderRow(f: FolderInfo, input: TreeInput, group: string | undefined, indent: number): TreeRow {
  return {
    kind: "folder",
    key: folderKey(f.path, input.os),
    title: f.name,
    height: 32,
    indent,
    group,
    folder: f,
    icon: f.missing ? "warning" : f.pinned ? "star" : "folder",
    detail: f.sessions.length ? input.ago(f.last) : undefined,
    acceptsDrop: false,
    draggable: true,
    dim: f.missing,
    live: input.liveCwd[pathKey(f.path, input.os)] ?? 0,
    lastChild: false,
  };
}

function plain(kind: RowKind, key: string, title: string, height: number, indent = 0, group?: string): TreeRow {
  return {
    kind,
    key,
    title,
    height,
    indent,
    group,
    acceptsDrop: false,
    draggable: false,
    dim: false,
    live: 0,
    lastChild: false,
  };
}

/** The rows of the sidebar. */
export function buildTree(input: TreeInput): TreeRow[] {
  const { os, query } = input;
  const list = folderList(input);
  const byPath = new Map(list.map((f) => [pathKey(f.path, os), f]));
  const used = new Set<string>();
  const searching = query.trim() !== "";
  const q = query.trim();
  const rows: TreeRow[] = [];

  rows.push(plain("section", PROJECTS_KEY, S.projects, 30));
  let shownGroups = 0;
  for (const g of input.groups) {
    const info: GroupInfo = { name: g.name, folders: [], sessions: [], last: 0 };
    for (const raw of g.folders) {
      if (!raw.trim()) continue;
      const key = pathKey(raw, os);
      if (used.has(key)) continue; // one project per folder; a hand-edited settings file may list it twice
      used.add(key);
      const path = normPath(raw);
      const f = byPath.get(key) ?? {
        path,
        name: leaf(path),
        last: 0,
        pinned: false,
        missing: missingKind(input.kinds?.[key]),
        sessions: [],
      };
      info.folders.push(f);
      info.sessions.push(...f.sessions);
      info.last = Math.max(info.last, f.last);
    }
    info.sessions.sort((a, b) => b.modified - a.modified);
    const shown = info.folders.filter((f) => !searching || has(g.name, q) || matches(f, q));
    if (searching && shown.length === 0 && !has(g.name, q)) continue;
    const open = searching || !g.collapsed;
    const live = info.folders.reduce<LiveLevel>((m, f) => maxLive(m, input.liveCwd[pathKey(f.path, os)] ?? 0), 0);
    rows.push({
      ...plain("group", groupKey(g.name), g.name, 34),
      info,
      icon: "group",
      badge: String(info.sessions.length),
      open,
      acceptsDrop: true,
      live,
    });
    shownGroups++;
    if (!open) continue;
    // long projects show their first few folders and a "Show N more" row
    const all = searching || input.showAll.has(g.name.toLowerCase()) || shown.length <= FOLDER_LIMIT;
    const limit = all ? shown.length : FOLDER_SHOWN;
    for (const f of shown.slice(0, limit)) rows.push(folderRow(f, input, g.name, 1));
    if (limit < shown.length)
      rows.push(plain("more", moreKey(g.name), S.showMore(shown.length - limit), 28, 1, g.name));
    else if (!searching && shown.length > FOLDER_LIMIT)
      rows.push(plain("more", moreKey(g.name), S.showLess, 28, 1, g.name));
    if (shown.length === 0) rows.push(plain("hint", `h:${g.name.toLowerCase()}`, S.dragHere, 28, 1, g.name));
  }
  if (shownGroups === 0) rows.push(plain("hint", "h:projects", searching ? S.noMatches : S.noProjects, 30));

  const hidden = new Set((input.hidden ?? []).map((p) => pathKey(p, os)));
  const ungrouped = list.filter((f) => !used.has(pathKey(f.path, os)) && matches(f, q));
  const rest = ungrouped.filter((f) => !hidden.has(pathKey(f.path, os))).map((f) => folderRow(f, input, undefined, 0));
  const out = ungrouped
    .filter((f) => hidden.has(pathKey(f.path, os)))
    .map((f) => ({ ...folderRow(f, input, undefined, 0), dim: true }));
  const openRest = searching || !input.foldersCollapsed;
  rows.push({ ...plain("section", FOLDERS_KEY, S.folders(rest.length), 30), open: openRest, acceptsDrop: true });
  if (openRest) {
    rows.push(...rest);
    // listed under their own divider, which also folds them away; searching lists them anyway (a hidden
    // folder can still be found)
    const showHidden = searching || !!input.showHidden;
    if (out.length && !searching) {
      const title = showHidden ? S.hiddenHeading(out.length) : S.showHidden(out.length);
      rows.push({ ...plain("more", HIDDEN_KEY, title, 28), open: showHidden });
    }
    if (showHidden) rows.push(...out);
  }

  rows.forEach((r, i) => {
    r.lastChild = r.indent > 0 && (rows[i + 1]?.indent ?? 0) < r.indent;
  });
  return rows;
}

/** Sessions and folders the header subtitle counts (every listed folder, grouped or not). */
export function counts(folders: readonly FolderInfo[]): { sessions: number; folders: number } {
  return { sessions: folders.reduce((n, f) => n + f.sessions.length, 0), folders: folders.length };
}
