// The live dot shown next to running sessions and folders (sidebar, sessions table, search).
// Decorative: the row it sits in says in words whether the session runs.

import { h, raw, type SafeHtml } from "../../core/dom";
import "./live.css";

/** 0 = not running, 1 = open and idle, 2 = working. */
export type LiveLevel = 0 | 1 | 2;

/** Keeps markup safe even if an untyped caller passes something else. */
function clamp(level: LiveLevel): LiveLevel {
  return level === 1 || level === 2 ? level : 0;
}

export function liveDot(level: LiveLevel): HTMLElement {
  return h("span", { class: "live-dot", dataset: { level: String(clamp(level)) }, attrs: { "aria-hidden": "true" } });
}

export function liveDotHtml(level: LiveLevel): SafeHtml {
  return raw(`<span class="live-dot" data-level="${clamp(level)}" aria-hidden="true"></span>`);
}
