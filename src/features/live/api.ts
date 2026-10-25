// Public API of the live-session feature (WP3). Other features may import this file only.
// sessionLevel() and folderLevel() read store.live / store.liveCwd, which the live feature keeps current.

import type { SafeHtml } from "../../core/dom";
import { pathKey } from "../../core/paths";
import { store } from "../../core/store";
import { liveDot as dot, liveDotHtml as dotHtml, type LiveLevel } from "./dot";
import { focusLive as focus } from "./focus";

export type { LiveLevel };

export function sessionLevel(sessionId: string): LiveLevel {
  return store.get().live[sessionId]?.level ?? 0;
}

/** The highest level of the sessions running in `path`. */
export function folderLevel(path: string): LiveLevel {
  const s = store.get();
  return s.liveCwd[pathKey(path, s.platform.os)] ?? 0;
}

/**
 * Brings the running session to the front: its tab in the app, or the terminal window it runs in.
 * Resolves false when it could not (the caller then resumes it instead).
 */
export async function focusLive(sessionId: string): Promise<boolean> {
  return focus(sessionId);
}

/** The live dot for `level` (nothing visible for 0): green when open, a breathing accent dot when working. */
export function liveDot(level: LiveLevel): HTMLElement {
  return dot(level);
}

/** The same dot as markup, for html`` templates. */
export function liveDotHtml(level: LiveLevel): SafeHtml {
  return dotHtml(level);
}
