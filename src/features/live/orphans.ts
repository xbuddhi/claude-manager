// "Close background sessions": claude copies with no window (left over from killed terminals).

import type { Orphan } from "../../bindings/Orphan";
import { call } from "../../core/api";
import { leaf } from "../../core/format";
import { store } from "../../core/store";
import { ask, message } from "../../ui/dialog";
import "./ipc";

/** The question shown before closing, with up to 6 of them listed. */
export function orphanQuestion(orphans: Orphan[]): string {
  const n = orphans.length;
  const names = orphans
    .slice(0, 6)
    .map((o) => `  - ${(o.cwd && leaf(o.cwd)) || "session"}  (pid ${o.pid})`)
    .join("\n");
  return `Close ${n} background session${n === 1 ? "" : "s"}?\nThese Claude copies have no window (left over from closed terminals) and are using memory. Their work is saved and can be resumed.\n${names}`;
}

/** Finds orphans of the profile in view (or of all profiles), asks, and ends them. */
export async function closeOrphans(): Promise<void> {
  const found = await call("find_orphans", { profile: store.get().currentProfile });
  if (!found.ok) return;
  if (!found.value.length) {
    await message("No background sessions to close\nEvery running session can be reached from a window.");
    return;
  }
  if (!(await ask(orphanQuestion(found.value), "Close background sessions", "warning"))) return;
  await call("close_orphans", { pids: found.value.map((o) => o.pid) });
}
