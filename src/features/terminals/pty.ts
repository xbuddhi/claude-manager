// The terminal feature's backend commands and events (src-tauri/src/pty, src-tauri/src/launch).

import type { Channel } from "@tauri-apps/api/core";
import type { PtyExit } from "../../bindings/PtyExit";
import type { PtyInfo } from "../../bindings/PtyInfo";

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
    /** Opens the terminal in its own window; the caller removes its tab. */
    pty_popout: { args: { id: number }; result: null };
    /** From a pop-out window: give the terminal back to the main window and close this window. */
    pty_return: { args: undefined; result: null };
    /** From a pop-out window: close it, ending its terminal when `kill` is set. */
    pty_close_window: { args: { kill: boolean }; result: null };
    launch_external: {
      args: { dir: string; profile?: string; sessionId?: string; fork?: boolean; shellOnly?: boolean };
      result: null;
    };
  }
  interface BackendEvents {
    /** A pop-out window gave terminal `id` back to the main window. */
    "pty-returned": number;
  }
}
