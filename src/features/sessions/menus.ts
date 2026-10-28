// Menus of the sessions view: a session's right-click menu, the New Session arrow menu and the Open menu.

import type { Session } from "../../bindings/Session";
import { isMac } from "../../core/platform";
import { profiles } from "../../core/profiles";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { type MenuItem, type MenuPosition, showMenu } from "../../ui/menu";
import { webMenuItem } from "../git/api";
import { copyText, openFolder, openInCode, reveal, revealLabel, terminalHere } from "../os/api";
import { profileAvatar } from "../profiles/api";
import { archiveSelected, deleteSelected, doNew, doResume, isArchived, startNew } from "./actions";
import { renameSession } from "./api";
import { archiveIcon, pencilIcon } from "./icons";

/** Delete is Del on Windows and Cmd+Backspace on macOS (a Mac keyboard's delete key is Backspace). */
export function deleteKeys(mac = isMac()): string {
  return mac ? "Cmd+Backspace" : "Delete";
}

export function sessionMenuItems(s: Session): MenuItem[] {
  const archived = isArchived(s.id);
  return [
    { label: "Resume", icon: "history", shortcut: "Enter", run: () => void doResume(s) },
    { label: "Resume in new window", icon: "popout", run: () => void doResume(s, { mode: "external" }) },
    { label: "Resume inside app", icon: "terminal", run: () => void doResume(s, { mode: "embed" }) },
    { label: "Fork as a new session", icon: "fork", run: () => void doResume(s, { fork: true }) },
    { kind: "separator" },
    { label: "Rename…", icon: pencilIcon(), run: () => void renameSession(s) },
    { label: "Copy session ID", icon: "copy", run: () => void copyText(s.id) },
    {
      label: "Open folder in VS Code",
      icon: "vscode",
      disabled: !s.cwd,
      run: () => void (s.cwd && openInCode([s.cwd])),
    },
    { label: revealLabel(), icon: "folder", run: () => void reveal(s.file) },
    { kind: "separator" },
    { label: archived ? "Unarchive" : "Archive", icon: archiveIcon(), run: () => archiveSelected(!archived) },
    { label: "Delete", icon: "trash", danger: true, shortcut: deleteKeys(), run: deleteSelected },
  ];
}

export function showSessionMenu(s: Session, at: MenuPosition): void {
  void showMenu(sessionMenuItems(s), { at, label: "Session" });
}

function profileItems(): MenuItem[] {
  const scope = store.get().sessionsScope;
  const folder = scope?.kind === "folder" ? scope.path : null;
  return profiles().map((p) => ({
    label: p.name,
    icon: profileAvatar(p.dir, 16),
    detail: p.email ?? undefined,
    // like the Windows app, only for a folder: a project would first need its folder picked
    disabled: folder === null,
    run: () => folder && startNew(folder, undefined, p.dir),
  }));
}

export function newSessionMenuItems(anchor?: HTMLElement): MenuItem[] {
  const at = anchor ? { anchor } : undefined;
  const embed = settings().openIn === "embed";
  return [
    { label: "New session in new window", icon: "popout", run: () => doNew("external", at) },
    { label: "New session inside app", icon: "terminal", run: () => doNew("embed", at) },
    { label: "New session with profile", icon: "plus", submenu: profileItems() },
    { kind: "separator" },
    {
      label: "New Session opens in a new window",
      checked: !embed,
      run: () => void updateSettings({ openIn: "external" }),
    },
    {
      label: "New Session opens inside the app",
      checked: embed,
      run: () => void updateSettings({ openIn: "embed" }),
    },
  ];
}

/** The folder the Open menu acts on: the selected folder, or a project's first folder. */
export function openTarget(): { path: string | null; folders: string[]; isFolder: boolean } {
  const scope = store.get().sessionsScope;
  if (scope?.kind === "folder") return { path: scope.path, folders: [scope.path], isFolder: true };
  if (scope?.kind === "group") return { path: scope.folders[0] ?? null, folders: scope.folders, isFolder: false };
  return { path: null, folders: [], isFolder: false };
}

/** `web`: the page of the folder's repository (repoWebUrl), listed when there is one. */
export function openMenuItems(web: string | null = null): MenuItem[] {
  const t = openTarget();
  const mac = isMac();
  const folderOnly = !t.isFolder || t.path === null;
  return [
    { label: "VS Code", icon: "vscode", disabled: !t.folders.length, run: () => void openInCode(t.folders) },
    {
      label: mac ? "Finder" : "Explorer",
      icon: "folder",
      disabled: t.path === null,
      run: () => void (t.path && openFolder(t.path)),
    },
    {
      label: mac ? "Terminal here" : "PowerShell here",
      icon: "terminal",
      disabled: folderOnly,
      run: () => void (t.path && terminalHere(t.path)),
    },
    ...(web ? [webMenuItem(web)] : []),
    { kind: "separator" },
    { label: "Copy path", icon: "copy", disabled: folderOnly, run: () => void (t.path && copyText(t.path)) },
  ];
}
