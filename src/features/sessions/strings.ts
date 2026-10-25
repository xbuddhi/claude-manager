// Texts of the sessions view, as the Windows app words them (Fill-Sessions, Show-Details, Confirm-Delete).
// Pure functions: the view passes in names, live levels and the time.

import type { Session } from "../../bindings/Session";
import { ago } from "../../core/format";

export const TIP_NEW = "Start a Claude session in the selected folder";
export const TIP_FORK = "Continue in a new copy of this session";

/** "Resume this session  (Enter)"; Return on macOS. */
export function resumeTip(mac: boolean): string {
  return `Resume this session  (${mac ? "Return" : "Enter"})`;
}

/** "Delete this session  (Del)"; ⌘⌫ on macOS, and "these N sessions" for several. */
export function deleteTip(n: number, mac: boolean): string {
  return `Delete ${n > 1 ? `these ${n} sessions` : "this session"}  (${mac ? "⌘⌫" : "Del"})`;
}

export const HINT_DEFAULT =
  "Double-click a project to start a session, or a session to resume it. Drop a folder on the window to start there. Right-click for more.";
export const HINT_NO_SESSIONS = "No sessions yet. Double-click the folder (or press New Session) to start one.";

export function groupHint(name: string, folders: number): string {
  return `${name} has ${folders} folder${folders === 1 ? "" : "s"}. Drag folders onto it in the sidebar to add more; folders on disk are never moved.`;
}

/** The muted count beside the view title: "12 sessions in app". */
export function countText(n: number, name: string): string {
  return `${n} session${n === 1 ? "" : "s"} in ${name}`;
}

/** "Working..." / "Open now" while the session runs (live level 2 / 1), else how long ago it was used. */
export function lastActive(level: number, modified: number, now = Date.now()): string {
  if (level === 2) return "Working...";
  if (level === 1) return "Open now";
  return ago(modified, now);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** "Sat, Oct 25 2026  14:05" in local time (.NET 'ddd, MMM d yyyy  HH:mm'). */
export function longDate(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}  ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The details pane text for a session: its full prompt, said to be running first when it is. */
export function detailText(full: string, level: number): string {
  if (!level) return full;
  const state = level === 2 ? "Claude is working in this session." : "This session is open.";
  return `${state} Double-click to switch to it.\n${full}`;
}

/** "Sat, Oct 25 2026  14:05     12 messages     profile: work     <id>". */
export function detailMeta(s: Pick<Session, "modified" | "count" | "id">, profile: string): string {
  return `${longDate(s.modified)}     ${s.count} messages     profile: ${profile}     ${s.id}`;
}

/**
 * The delete question. `what` names the sessions ("this session", "these 3 sessions", or for a folder
 * "all 3 sessions of 'app'"); up to five labels are listed.
 */
export function deleteConfirm(labels: readonly string[], mac: boolean, what?: string): string {
  const n = labels.length;
  const subject = what ?? (n === 1 ? "this session" : `these ${n} sessions`);
  let names = labels
    .slice(0, 5)
    .map((l) => `  - ${l}`)
    .join("\n");
  if (n > 5) names += `\n  ... and ${n - 5} more`;
  return `Move ${subject} to the ${mac ? "Trash" : "Recycle Bin"}?\n\n${names}\n\nIf one is open in a terminal, close it first.`;
}

/** The question for a folder's "Delete all sessions": "all 3 sessions of 'app'". */
export function folderWhat(n: number, folderName: string): string {
  return `all ${n} sessions of '${folderName}'`;
}

/** The delete button: an icon alone for one session, "Delete N" for several. */
export function deleteLabel(n: number): string {
  return n > 1 ? `Delete ${n}` : "";
}
