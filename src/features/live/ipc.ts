// Backend commands and events of the live feature (src-tauri/src/live, src-tauri/src/notify).

import type { LiveChanged } from "../../bindings/LiveChanged";
import type { NotifyClicked } from "../../bindings/NotifyClicked";
import type { Orphan } from "../../bindings/Orphan";

declare module "../../core/api" {
  interface Commands {
    get_live: { args: undefined; result: LiveChanged };
    /** The session's process and its ancestors, nearest first; empty when it is not running. */
    live_ancestors: { args: { sessionId: string }; result: number[] };
    /** Brings the window the session runs in to the front; false when none was found. */
    focus_live: { args: { sessionId: string }; result: boolean };
    /** Unreachable running sessions of a profile folder, or of every profile (null). */
    find_orphans: { args: { profile: string | null }; result: Orphan[] };
    /** Ends the given orphans (checked again by the backend); returns how many were ended. */
    close_orphans: { args: { pids: number[] }; result: number };
    /** The process of the terminal tab in front, or null: notifications for it are skipped. */
    set_active_terminal_pid: { args: { pid: number | null }; result: null };
  }
  interface BackendEvents {
    "live-changed": LiveChanged;
    /** A finish notification was clicked; the window is already shown. */
    "notify:clicked": NotifyClicked;
  }
}
