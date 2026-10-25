// Keeps store.index current. TEMPORARY port of the prototype: polls list_projects every 15 s and when the
// window gets focus; WP1 replaces this with a file watcher and incremental scans.

import { on } from "../../core/bus";
import { refreshIndex } from "./api";

const POLL_MS = 15_000;

export function mount(): void {
  void refreshIndex();
  setInterval(() => {
    if (!document.hidden) void refreshIndex();
  }, POLL_MS);
  window.addEventListener("focus", () => void refreshIndex());
  on("refresh:full", () => void refreshIndex());
}
