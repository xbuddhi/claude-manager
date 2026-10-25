// Public API of the sessions feature (WP5). Other features may import this file only.
// Stubs provided by WP5, which replaces their bodies only (and adds the backend commands declared here).

import type { Session } from "../../bindings/Session";
import { toast } from "../../ui/toast";

declare module "../../core/api" {
  interface Commands {
    /** Moves `path`, which must lie inside the existing folder `root`, to the Recycle Bin / Trash. */
    trash_path: { args: { path: string; root: string }; result: null };
  }
}

export interface DeleteOptions {
  /** Also unpin this folder once its sessions are gone (sidebar "Delete all sessions"). */
  unpinFolder?: string;
}

/**
 * Asks first, then moves the sessions' transcripts (and their side folders) to the Recycle Bin / Trash.
 * Resolves true when they were deleted. Stub provided by WP5.
 */
export async function deleteSessions(_sessions: readonly Session[], _opts: DeleteOptions = {}): Promise<boolean> {
  toast("Deleting sessions is not available yet.");
  return false;
}

/** Moves `path` (inside the existing folder `root`, e.g. a repository) to the trash. Stub provided by WP5. */
export async function trashPath(_path: string, _root: string): Promise<boolean> {
  toast("Moving files to the trash is not available yet.");
  return false;
}
