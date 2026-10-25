// Public API of the sessions feature (WP5). Other features may import this file only.

import type { Session } from "../../bindings/Session";
import type { TrashItem } from "../../bindings/TrashItem";
import type { TrashReport } from "../../bindings/TrashReport";
import { call } from "../../core/api";
import { leaf, plural } from "../../core/format";
import { samePath } from "../../core/paths";
import { isMac } from "../../core/platform";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { ask } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import { refreshIndex } from "../index-data/api";
import "./state";
import { deleteConfirm, folderWhat } from "./strings";

declare module "../../core/api" {
  interface Commands {
    /**
     * Moves `path` (absolute, or relative to `root`) to the Recycle Bin / Trash. `root` must be an existing
     * repository folder (it has `.git`); `path` must exist inside it, outside `.git`.
     */
    trash_path: { args: { path: string; root: string }; result: null };
    /** Moves sessions (transcript and side folders) to the Recycle Bin / Trash; errors are per session. */
    trash_sessions: { args: { items: TrashItem[] }; result: TrashReport };
  }
}

export interface DeleteOptions {
  /** Also unpin this folder once its sessions are gone (sidebar "Delete all sessions"). */
  unpinFolder?: string;
}

async function unpin(folder: string): Promise<void> {
  const os = store.get().platform.os;
  const pinned = settings().pinned;
  const kept = pinned.filter((p) => !samePath(p, folder, os));
  if (kept.length !== pinned.length) await updateSettings({ pinned: kept });
}

/**
 * Asks first, then moves the sessions' transcripts (and their side folders) to the Recycle Bin / Trash.
 * With `unpinFolder` (a folder's "Delete all sessions") the question names the folder, and the folder is
 * unpinned afterwards, also when it has no sessions (then nothing is asked). Resolves true when done.
 */
export async function deleteSessions(sessions: readonly Session[], opts: DeleteOptions = {}): Promise<boolean> {
  const folder = opts.unpinFolder;
  if (sessions.length) {
    const what = folder === undefined ? undefined : folderWhat(sessions.length, leaf(folder));
    const text = deleteConfirm(
      sessions.map((s) => s.label),
      isMac(),
      what,
    );
    if (!(await ask(text, "Delete", "warning"))) return false;
    const res = await call("trash_sessions", {
      items: sessions.map((s) => ({ profile: s.profile, sessionId: s.id })),
    });
    if (!res.ok) return false;
    const { trashed, failed } = res.value;
    if (failed.length) {
      const first = failed[0]?.message ?? "";
      toast(`${plural(failed.length, "session")} could not be deleted: ${first}`, { kind: "error" });
    }
    if (trashed.length) void refreshIndex();
    if (!trashed.length) return false;
  }
  if (folder !== undefined) await unpin(folder);
  return true;
}

/** Moves `path` (inside the repository folder `root`) to the Recycle Bin / Trash. Resolves true when done. */
export async function trashPath(path: string, root: string): Promise<boolean> {
  return (await call("trash_path", { path, root })).ok;
}

/** Continues the newest of `sessions` (or starts a new session in `dir` when there are none). */
export { continueLast, doResume as resumeSession } from "./actions";

/** Selects the session's row in the sessions table once it is listed (after the sidebar selected its folder). */
export function selectSession(sessionId: string): void {
  store.set({ sessionsWanted: sessionId });
}

/** The speech-bubble icon of a session row, for lists of sessions elsewhere (search). */
export { chatIcon } from "./icons";
