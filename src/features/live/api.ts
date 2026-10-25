// Public API of the live-session feature (WP3). Other features may import this file only.
// sessionLevel() and folderLevel() read store.live / store.liveCwd and already work (empty until WP3 fills
// them). focusLive() and liveDot() are stubs provided by WP3, which replaces their bodies only.

import { h, raw, type SafeHtml } from "../../core/dom";
import { pathKey } from "../../core/paths";
import { store } from "../../core/store";

/** 0 = not running, 1 = open and idle, 2 = working. */
export type LiveLevel = 0 | 1 | 2;

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
 * Stub provided by WP3: always false until then.
 */
export async function focusLive(_sessionId: string): Promise<boolean> {
  return false;
}

/** The live dot for `level` (nothing visible for 0). Stub provided by WP3: an unstyled marker until then. */
export function liveDot(level: LiveLevel): HTMLElement {
  return h("span", { class: "live-dot", dataset: { level: String(level) }, attrs: { "aria-hidden": "true" } });
}

/** The same dot as markup, for html`` templates. Stub provided by WP3. */
export function liveDotHtml(level: LiveLevel): SafeHtml {
  return raw(`<span class="live-dot" data-level="${level}" aria-hidden="true"></span>`);
}
