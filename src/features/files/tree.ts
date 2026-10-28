// The file tree as rows: the loaded folder listings flattened in order, the open folders' entries under
// them. Paths are relative to the root folder and always use "/" ("" is the root itself).

import type { FileEntry } from "../../bindings/FileEntry";
import type { FolderListing } from "../../bindings/FolderListing";

export type TreeRow =
  | { kind: "entry"; key: string; entry: FileEntry; depth: number; open: boolean }
  /** "N more" under a folder listed only in part. */
  | { kind: "more"; key: string; count: number; depth: number };

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function nameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** True when `rel` is `dir` or lies under it. */
export function isUnder(rel: string, dir: string): boolean {
  return dir === "" || rel === dir || rel.startsWith(`${dir}/`);
}

/** Whether `from` may move into the folder `dir`: somewhere else, and not into itself. */
export function canMoveInto(from: string, dir: string): boolean {
  return parentRel(from) !== dir && !isUnder(dir, from);
}

/** `rel` after `from` was renamed to `to` (unchanged when it is not under `from`). */
export function renamed(rel: string, from: string, to: string): string {
  return isUnder(rel, from) ? to + rel.slice(from.length) : rel;
}

/** The rows of `dir` and, below each open folder, its own (folders whose listing is not loaded show closed). */
export function flatten(
  listings: ReadonlyMap<string, FolderListing>,
  expanded: ReadonlySet<string>,
  dir = "",
  depth = 0,
): TreeRow[] {
  const listing = listings.get(dir);
  if (!listing) return [];
  const out: TreeRow[] = [];
  for (const entry of listing.entries) {
    const key = joinRel(dir, entry.name);
    const open = entry.dir && expanded.has(key) && listings.has(key);
    out.push({ kind: "entry", key, entry, depth, open });
    if (open) out.push(...flatten(listings, expanded, key, depth + 1));
  }
  if (listing.more > 0) out.push({ kind: "more", key: `${dir}/\0more`, count: listing.more, depth });
  return out;
}

/** The absolute path of `rel` under `root`, in the root's separators. */
export function absPath(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${sep}${rel.split("/").join(sep)}`;
}
