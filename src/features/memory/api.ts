// Public API of the memory feature: the backend commands it uses (src-tauri/src/memory.rs).

import type { MemoryFile } from "../../bindings/MemoryFile";

/** Markdown as a document element (class `mem-doc`); links go to `onLink`. */
export { renderMarkdown } from "./markdown";

declare module "../../core/api" {
  interface Commands {
    /** Claude Code's memory files for `folder` under the profile `profile`, broadest first. */
    memory_files: { args: { profile: string; folder: string }; result: MemoryFile[] };
    /** The text of one existing file from memory_files. */
    memory_read: { args: { profile: string; folder: string; path: string }; result: string };
    /** Creates one missing user, project or local CLAUDE.md from memory_files. */
    memory_create: { args: { profile: string; folder: string; path: string }; result: null };
  }
}
