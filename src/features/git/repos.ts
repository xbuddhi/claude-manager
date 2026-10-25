// Which repository the view shows for the sidebar selection, and the picker's labels. Pure helpers.

import { leaf } from "../../core/format";
import { pathKey } from "../../core/paths";
import type { SidebarSelection } from "../../core/store";

export interface Target {
  /** Candidates for the picker, which shows when there are any. */
  repos: string[];
  /** The folder to show: the pick, the only repository, or the folder itself. */
  folder: string | null;
}

/** Unique by path key, first spelling wins. */
export function unique(paths: readonly string[], os: string): string[] {
  const seen = new Set<string>();
  return paths.filter((p) => {
    const k = pathKey(p, os);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The target for a selection, given each folder's repositories (`found`, in folder order). A group shows a
 * picker over all its folders' repositories (its folders when none has one, so the first says "not a
 * repository"); a folder shows a picker only when it holds several.
 */
export function pickTarget(
  sel: SidebarSelection | null,
  found: readonly string[][],
  pick: string | null,
  os: string,
): Target {
  if (!sel) return { repos: [], folder: null };
  const folders = sel.kind === "group" ? (sel.folders ?? []) : sel.path ? [sel.path] : [];
  if (!folders.length) return { repos: [], folder: null };
  let repos = unique(found.flat(), os);
  if (sel.kind === "folder" && repos.length <= 1) return { repos: [], folder: repos[0] ?? (folders[0] as string) };
  if (!repos.length) repos = unique(folders, os);
  const kept = pick !== null ? repos.find((r) => pathKey(r, os) === pathKey(pick, os)) : undefined;
  return { repos, folder: kept ?? (repos[0] as string) };
}

/** The folders whose repositories a selection needs. */
export function selectionFolders(sel: SidebarSelection | null): string[] {
  if (!sel) return [];
  return sel.kind === "group" ? (sel.folders ?? []) : sel.path ? [sel.path] : [];
}

/** Picker labels: the folder name, or "parent/name" (this OS's separator) when two share a name. */
export function repoLabels(repos: readonly string[], sep: string): string[] {
  const counts = new Map<string, number>();
  for (const r of repos) counts.set(leaf(r).toLowerCase(), (counts.get(leaf(r).toLowerCase()) ?? 0) + 1);
  return repos.map((r) => {
    const name = leaf(r);
    if ((counts.get(name.toLowerCase()) ?? 0) < 2) return name;
    const parent = r.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
    return `${leaf(parent)}${sep}${name}`;
  });
}
