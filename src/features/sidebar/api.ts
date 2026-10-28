// Public API of the sidebar (WP4). Other features may import this file only.
// Select a row with emit("sidebar:select", { key }); these build the keys.

import { store } from "../../core/store";
import { folderKey as treeFolderKey, groupKey as treeGroupKey } from "./tree";

/** Dragging rows of a list onto other rows, with pointer events (the sidebar's folder drag). */
export { attachDrag, type DragOptions } from "./drag";

/** Row key of a folder: "f:" + its path key (case-folded on Windows and macOS). */
export function folderKey(path: string): string {
  return treeFolderKey(path, store.get().platform.os);
}

/** Row key of a project (group): "g:" + its lower-cased name. */
export function groupKey(name: string): string {
  return treeGroupKey(name);
}
