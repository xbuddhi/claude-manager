// What the sidebar's rows do: start or continue sessions, and the right-click menus for folders, projects
// and the empty area (ClaudeManager.ps1 folderMenu, groupMenu, ungroupedMenu, Show-FolderPicker).

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { Session } from "../../bindings/Session";
import { emit, type LaunchMode } from "../../core/bus";
import { describeError, log } from "../../core/log";
import { settings } from "../../core/settings";
import { store } from "../../core/store";
import { type MenuItem, type MenuPosition, showMenu } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { webMenuItem } from "../git/api";
import { copyText, folderLabel, openFolder, openInCode, terminalHere, terminalHereLabel } from "../os/api";
import { profileAvatar, startProfile } from "../profiles/api";
import { continueLast as continueSession, deleteSessions } from "../sessions/api";
import {
  deleteProject,
  groupOf,
  hide,
  isPinned,
  moveFolder,
  newProject,
  pin,
  renameProject,
  togglePin,
  unhide,
  unpin,
} from "./groups";
import { S } from "./strings";
import type { FolderInfo, GroupInfo } from "./tree";

// ---------- actions ----------

/** Starts claude in `dir` with the start profile (or `profile`); `mode` absent = settings.openIn. */
export function newSession(dir: string, mode?: LaunchMode, profile?: string): void {
  emit("launch", { dir, profile: profile ?? startProfile() ?? undefined, mode });
}

/**
 * Continues the newest of `sessions` through the sessions feature, which switches to it when it runs and
 * asks before starting a second copy of one that runs elsewhere; without one starts a new session in `dir`.
 */
export function continueLast(sessions: readonly Session[], dir: string | null, mode?: LaunchMode): void {
  if (!sessions[0]) {
    if (dir) newSession(dir, mode);
    return;
  }
  void continueSession(sessions, dir, mode);
}

/** Trashes the folder's sessions (asking first) and unpins it; a folder without sessions is only unpinned. */
export async function deleteAllSessions(f: FolderInfo): Promise<void> {
  if (f.sessions.length) await deleteSessions(f.sessions, { unpinFolder: f.path });
  else await unpin(f.path);
}

/** Native folder picker; the folder chosen is pinned. */
export async function addFolder(): Promise<void> {
  try {
    const dir = await openDialog({ directory: true, multiple: false, title: S.pickFolder });
    if (typeof dir === "string" && dir) await pin([dir]);
  } catch (e) {
    log.error(`folder picker: ${describeError(e)}`);
    toast("Could not open the folder picker.", { kind: "error" });
  }
}

/** Every existing folder of a project in one VS Code window (multi-root). */
function openGroupInCode(g: GroupInfo) {
  const paths = g.folders.filter((f) => !f.missing).map((f) => f.path);
  if (paths.length) void openInCode(paths);
}

// ---------- menus ----------

const sep: MenuItem = { kind: "separator" };

/** Hide / show in sidebar (only this menu uses them). */
function eye(off: boolean): Element {
  const t = document.createElement("template");
  const slash = off ? `<path d="M2.5 2.5l11 11"/>` : "";
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>${slash}</svg>`;
  return t.content.firstElementChild as Element;
}

/** Rename (only this menu uses it). */
function pencil(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3"/></svg>`;
  return t.content.firstElementChild as Element;
}

function profileItems(dir: string): MenuItem[] {
  const list = store.get().profiles;
  if (!list.length) return [{ label: "No profiles found", disabled: true }];
  return list.map((p) => ({
    label: p.name,
    icon: profileAvatar(p.dir, 16),
    run: () => newSession(dir, undefined, p.dir),
  }));
}

function moveItems(f: FolderInfo, current: string | undefined): MenuItem[] {
  const groups = settings().groups;
  const items: MenuItem[] = groups.map((g) => ({
    label: g.name,
    icon: "group",
    checked: g.name === current,
    run: () => void moveFolder(f.path, g.name),
  }));
  if (groups.length) items.push(sep);
  items.push({ label: S.newProject, icon: "plus", run: () => void newProject(f.path) });
  return items;
}

/** `web`: the page of the folder's repository (repoWebUrl), listed when there is one. */
export function folderMenu(f: FolderInfo, web: string | null = null): MenuItem[] {
  const os = store.get().platform.os;
  const current = groupOf(settings().groups, f.path, os)?.name;
  const pinned = f.pinned || isPinned(settings().pinned, f.path, os);
  // a folder that is gone can still be copied, regrouped, unpinned or cleaned up, but nothing can start in it
  const gone = f.missing;
  const items: MenuItem[] = [
    { label: S.newSession, icon: "plus", disabled: gone, run: () => newSession(f.path) },
    { label: S.newSessionWindow, icon: "popout", disabled: gone, run: () => newSession(f.path, "external") },
    { label: S.newSessionApp, icon: "terminal", disabled: gone, run: () => newSession(f.path, "embed") },
    { label: S.newSessionProfile, icon: "plus", disabled: gone, submenu: profileItems(f.path) },
    sep,
    { label: S.continueLast, icon: "history", disabled: gone, run: () => continueLast(f.sessions, f.path) },
    sep,
    { label: terminalHereLabel(), icon: "terminal", disabled: gone, run: () => void terminalHere(f.path) },
    { label: folderLabel(), icon: "folder", disabled: gone, run: () => void openFolder(f.path) },
    { label: S.openCode, icon: "vscode", disabled: gone, run: () => void openInCode([f.path]) },
    ...(web && !gone ? [webMenuItem(web, S.openOn)] : []),
    { label: S.copyPath, icon: "copy", run: () => void copyText(f.path) },
    sep,
    { label: S.moveTo, icon: "group", submenu: moveItems(f, current) },
  ];
  if (current !== undefined)
    items.push({ label: S.removeFrom, icon: "minus", run: () => void moveFolder(f.path, null) });
  // only FOLDERS hides folders: a project's folders were put there on purpose
  const hidden = current === undefined && isPinned(settings().hidden, f.path, os);
  items.push(sep, { label: pinned ? S.unpin : S.pin, icon: "star", run: () => void togglePin(f.path) });
  if (current === undefined)
    items.push({
      label: hidden ? S.unhide : S.hide,
      icon: eye(!hidden),
      run: () => void (hidden ? unhide(f.path) : hide(f.path)),
    });
  items.push({ label: S.deleteAll, icon: "trash", danger: true, run: () => void deleteAllSessions(f) });
  return items;
}

/** The small menu listing a project's folders to start a session in. */
export function folderPicker(g: GroupInfo, at: MenuPosition, mode?: LaunchMode): void {
  const items: MenuItem[] = [{ kind: "section", label: S.startWhich(g.name) }];
  for (const f of g.folders) {
    items.push({
      label: f.name,
      icon: f.missing ? "warning" : "folder",
      disabled: f.missing,
      run: () => newSession(f.path, mode),
    });
  }
  if (!g.folders.length) items.push({ label: S.noFolders, disabled: true });
  void showMenu(items, { at, label: S.startWhich(g.name) });
}

export function groupMenu(g: GroupInfo, at: MenuPosition): MenuItem[] {
  const first = g.folders.find((f) => !f.missing);
  return [
    { label: S.newSessionIn, icon: "plus", run: () => folderPicker(g, at) },
    {
      label: S.continueLast,
      icon: "history",
      // nothing to continue yet: ask where to start a new one
      run: () => (g.sessions.length ? continueLast(g.sessions, null) : folderPicker(g, at)),
    },
    sep,
    { label: S.openCode, icon: "vscode", disabled: !first, run: () => openGroupInCode(g) },
    sep,
    { label: S.renameProject, icon: pencil(), run: () => void renameProject(g.name) },
    { label: S.deleteProject, icon: "trash", danger: true, run: () => void deleteProject(g.name) },
    sep,
    { label: S.newProject, icon: "group", run: () => void newProject() },
  ];
}

export function emptyMenu(): MenuItem[] {
  return [{ label: S.newProject, icon: "group", run: () => void newProject() }];
}

/** The header's "+" menu. */
export function addMenu(): MenuItem[] {
  return [
    { label: S.newProject, icon: "group", run: () => void newProject() },
    { label: S.addFolder, icon: "folder", run: () => void addFolder() },
  ];
}
