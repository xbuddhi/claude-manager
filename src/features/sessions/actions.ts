// What the sessions view does: start a new session, continue the newest one, resume or fork one, delete.
// Ported from Do-New, Do-Continue, Do-Resume and Do-DeleteSession. Sessions start through the bus `launch`
// event (terminals feature); a running session is switched to instead of being started twice.

import type { Session } from "../../bindings/Session";
import { emit, type LaunchMode } from "../../core/bus";
import { leaf } from "../../core/format";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { ask } from "../../ui/dialog";
import { type MenuItem, type MenuPosition, showMenu } from "../../ui/menu";
import { focusLive, sessionLevel } from "../live/api";
import { deleteSessions } from "./api";
import { sessionDir } from "./model";
import "./state";

const RUNNING_ELSEWHERE =
  "This session is running elsewhere\nIt's active but its window couldn't be found. Resume anyway? This starts a second copy of the session.";

/** The selected sessions, in row order. */
export function selectedSessions(): Session[] {
  const { sessionsSelected, sessionsScope } = store.get();
  const byId = new Map((sessionsScope?.sessions ?? []).map((s) => [s.id, s]));
  return sessionsSelected.flatMap((id) => byId.get(id) ?? []);
}

/** The session the single-session actions work on: the first selected one. */
export function selectedSession(): Session | null {
  return selectedSessions()[0] ?? null;
}

// where the pointer last went down: the group folder picker opens there, like a context menu
let pointer = { x: 0, y: 0 };
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => (pointer = { x: e.clientX, y: e.clientY }), { capture: true });
}

/** Starts a new session in `dir`; without `profile` the terminals feature picks the start profile. */
export function startNew(dir: string, mode?: LaunchMode, profile?: string): void {
  emit("launch", { dir, ...(mode ? { mode } : {}), ...(profile ? { profile } : {}) });
}

/** The menu that asks which folder of a project to start in. */
export function folderPickerItems(name: string, folders: readonly string[], pick: (dir: string) => void): MenuItem[] {
  const items: MenuItem[] = [{ kind: "section", label: `Start in which folder of '${name}'?` }];
  for (const dir of folders) {
    // the full path tells same-named folders apart; long ones keep their end
    const detail = dir.length > 44 ? `…${dir.slice(-43)}` : dir;
    items.push({ label: leaf(dir), icon: "folder", detail, run: () => pick(dir) });
  }
  if (!folders.length) items.push({ label: "(no folders yet - drag some in)", disabled: true });
  return items;
}

/**
 * New session in the selected folder. For a project: in the selected session's folder, else in a folder
 * picked from a menu (at `at`, or where the pointer last went down).
 */
export function doNew(mode?: LaunchMode, at?: MenuPosition): void {
  const scope = store.get().sessionsScope;
  if (!scope) return;
  const s = selectedSession();
  const dir = scope.kind === "folder" ? scope.path : s?.cwd;
  if (dir) {
    startNew(dir, mode);
    return;
  }
  if (scope.kind === "folder") return;
  void showMenu(
    folderPickerItems(scope.name, scope.folders, (path) => startNew(path, mode)),
    { at: at ?? pointer, label: "Start in which folder" },
  );
}

/**
 * Resumes a session in its own profile and folder, or switches to it when it is already running.
 * A fork always starts a new copy: `claude --resume <id> --fork-session`, titled "Fork of <label>".
 */
export async function doResume(s: Session, opts: { fork?: boolean; mode?: LaunchMode } = {}): Promise<void> {
  const fork = opts.fork ?? false;
  if (!fork && sessionLevel(s.id) > 0 && (await focusLive(s.id))) return;
  const scope = store.get().sessionsScope;
  const dir = sessionDir(s, store.get().index.projects, scope?.kind === "folder" ? scope.path : null);
  if (!dir) return;
  emit("launch", {
    dir,
    profile: s.profile,
    ...(opts.mode ? { mode: opts.mode } : {}),
    resume: { sessionId: s.id, fork },
    label: fork ? `Fork of ${s.label}` : s.label,
  });
}

/**
 * Continues the newest of `sessions` (newest first): switches to it when it runs, asks first when it runs
 * but its window cannot be found. Without sessions it starts a new one in `dir`.
 */
export async function continueLast(sessions: readonly Session[], dir: string | null, mode?: LaunchMode) {
  const s = sessions[0];
  if (!s) {
    if (dir) startNew(dir, mode);
    return;
  }
  if (sessionLevel(s.id) > 0) {
    if (await focusLive(s.id)) return;
    if (!(await ask(RUNNING_ELSEWHERE, "Resume anyway"))) return;
  }
  const projects = store.get().index.projects;
  const target = sessionDir(s, projects, dir);
  if (!target) return;
  emit("launch", {
    dir: target,
    profile: s.profile,
    ...(mode ? { mode } : {}),
    resume: { sessionId: s.id, fork: false },
    label: s.label,
  });
}

/** Continue for the selected folder or project. */
export function doContinue(mode?: LaunchMode): void {
  const scope = store.get().sessionsScope;
  if (!scope) return;
  if (scope.kind === "group" && !scope.sessions.length) doNew(mode);
  else void continueLast(scope.sessions, scope.kind === "folder" ? scope.path : null, mode);
}

export function resumeSelected(opts: { fork?: boolean; mode?: LaunchMode } = {}): void {
  const s = selectedSession();
  if (s) void doResume(s, opts);
}

export const isArchived = (id: string) => settings().archived.includes(id);

/** Archives (or unarchives) the selected sessions. Only the app's list changes; the transcripts stay. */
export function archiveSelected(archive: boolean): void {
  const ids = selectedSessions().map((s) => s.id);
  if (!ids.length) return;
  const rest = settings().archived.filter((id) => !ids.includes(id));
  void updateSettings({ archived: archive ? [...rest, ...ids] : rest });
}

export function deleteSelected(): void {
  const list = selectedSessions();
  if (list.length) void deleteSessions(list);
}
