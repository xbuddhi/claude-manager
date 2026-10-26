// The terminal feature's backend commands and events (src-tauri/src/pty, src-tauri/src/launch).

import type { Channel } from "@tauri-apps/api/core";
import type { Point } from "../../bindings/Point";
import type { PtyExit } from "../../bindings/PtyExit";
import type { PtyInfo } from "../../bindings/PtyInfo";
import type { WindowInfo } from "../../bindings/WindowInfo";

/** A terminal's output: raw bytes, then one PtyExit message after the last output. */
export type PtyOutput = {
  onOutput: Channel<ArrayBuffer | PtyExit>;
};

type Size = {
  cols: number;
  rows: number;
};

declare module "../../core/api" {
  interface Commands {
    pty_new: { args: { dir: string; profile: string; title: string } & Size & PtyOutput; result: PtyInfo };
    pty_resume: {
      args: { sessionId: string; profile: string; fork: boolean; dir: string; title: string } & Size & PtyOutput;
      result: PtyInfo;
    };
    /** Text as UTF-8, a number array as raw bytes. Queued; returns at once. */
    pty_write: { args: { id: number; data: string | number[] }; result: null };
    pty_resize: { args: { id: number } & Size; result: null };
    /** Ends the terminal's whole process tree; an already ended terminal is fine. */
    pty_kill: { args: { id: number }; result: null };
    /** Running terminals, oldest first. */
    pty_list: { args: undefined; result: PtyInfo[] };
    /** Takes the terminal's output over (replaying its recent output first). */
    pty_attach: { args: { id: number } & PtyOutput; result: PtyInfo };
    pty_pause: { args: { id: number; seq: number }; result: null };
    pty_resume_output: { args: { id: number; seq: number }; result: null };
    pty_set_title: { args: { id: number; title: string }; result: null };
    pty_clipboard_text: { args: undefined; result: string };
    /**
     * Moves this window's terminals to window `to`, else the window under the screen point `at`, else a new
     * window. Returns the label of the window they went to; the caller removes their tabs.
     */
    pty_move: { args: { ids: number[]; to?: string; at?: Point }; result: string };
    /** Brings terminal `id`'s tab forward in whichever window shows it. */
    pty_focus: { args: { id: number }; result: boolean };
    /** Brings session `sessionId`'s tab forward when another window shows it; false when none does. */
    pty_focus_session: { args: { sessionId: string }; result: boolean };
    /** The app windows on screen, the main window first. */
    window_list: { args: undefined; result: WindowInfo[] };
    launch_external: {
      args: { dir: string; profile?: string; sessionId?: string; fork?: boolean; shellOnly?: boolean };
      result: null;
    };
  }
  interface BackendEvents {
    /** Terminals moved to this window; take them over with pty_attach. */
    "pty-moved": number[];
    /** Bring this terminal's tab forward. */
    "pty-focus": number;
  }
}
