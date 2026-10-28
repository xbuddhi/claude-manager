// Public API of the Files view: the backend commands it uses (src-tauri/src/files.rs). Paths are relative to
// `root` with "/" separators; `root` is the folder selected in the sidebar.

import type { FolderListing } from "../../bindings/FolderListing";
import type { NewFile } from "../../bindings/NewFile";

/** A file tree of one folder with its file operations (the Files view's tree, e.g. beside a terminal). */
export { createExplorer, type Explorer, type ExplorerOptions } from "./explorer";

declare module "../../core/api" {
  interface Commands {
    /** The entries of the folder `dir` ("" = the root); ignored ones only with `ignored`. */
    files_list: { args: { root: string; dir: string; ignored: boolean }; result: FolderListing };
    /** A file's text for the preview. */
    files_read: { args: { root: string; path: string }; result: NewFile };
    /** An empty file, or a folder with `folder`; never replaces anything. */
    files_create: { args: { root: string; path: string; folder: boolean }; result: null };
    /** Renames or moves inside the root; never replaces anything. */
    files_rename: { args: { root: string; from: string; to: string }; result: null };
    /** Copies a file next to itself ("name copy.ext"); resolves with the copy's path. */
    files_duplicate: { args: { root: string; path: string }; result: string };
    /** Moves a file or folder to the Recycle Bin / Trash. */
    files_trash: { args: { root: string; path: string }; result: null };
  }
}
