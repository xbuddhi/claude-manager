// Sidebar projects (named groups of folder references; nothing on disk moves) and pinned folders, kept in
// settings.groups / settings.pinned. The pure helpers return new arrays; the flows ask the user first with
// the Windows app's texts (ClaudeManager.ps1 New-ProjectGroup, Rename-ProjectGroup, Remove-ProjectGroup).

import type { Group } from "../../bindings/Group";
import { normPath, pathKey } from "../../core/paths";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { ask, input, message } from "../../ui/dialog";
import { S } from "./strings";

const os = () => store.get().platform.os;
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// ---------- pure helpers ----------

/** The group holding `path`, if any. */
export function groupOf(groups: readonly Group[], path: string, osName: string): Group | undefined {
  const key = pathKey(path, osName);
  return groups.find((g) => g.folders.some((f) => pathKey(f, osName) === key));
}

/** Names compare without case (as the Windows app's -eq did). */
export function nameTaken(groups: readonly Group[], name: string, except?: string): boolean {
  return groups.some((g) => sameName(g.name, name) && g.name !== except);
}

/** Moves `path` into the group `name` (null = out of every group). One project per folder; the path is trimmed. */
export function moveToGroup(groups: readonly Group[], path: string, name: string | null, osName: string): Group[] {
  const key = pathKey(path, osName);
  const trimmed = normPath(path);
  return groups.map((g) => {
    const folders = g.folders.filter((f) => pathKey(f, osName) !== key);
    if (name !== null && g.name === name) folders.push(trimmed);
    return { ...g, folders };
  });
}

export function addGroup(groups: readonly Group[], name: string): Group[] {
  return [...groups, { name, folders: [], collapsed: false }];
}

export function renameGroup(groups: readonly Group[], from: string, to: string): Group[] {
  return groups.map((g) => (g.name === from ? { ...g, name: to } : g));
}

export function removeGroup(groups: readonly Group[], name: string): Group[] {
  return groups.filter((g) => g.name !== name);
}

/** Opens or closes a group (`collapsed` undefined = toggle). */
export function setCollapsed(groups: readonly Group[], name: string, collapsed?: boolean): Group[] {
  return groups.map((g) => (g.name === name ? { ...g, collapsed: collapsed ?? !g.collapsed } : g));
}

export function isPinned(pinned: readonly string[], path: string, osName: string): boolean {
  const key = pathKey(path, osName);
  return pinned.some((p) => pathKey(p, osName) === key);
}

/** Adds the paths not pinned yet (trailing separators trimmed). */
export function withPins(pinned: readonly string[], paths: readonly string[], osName: string): string[] {
  const out = [...pinned];
  for (const p of paths) if (p.trim() && !isPinned(out, p, osName)) out.push(normPath(p));
  return out;
}

export function withoutPin(pinned: readonly string[], path: string, osName: string): string[] {
  const key = pathKey(path, osName);
  return pinned.filter((p) => pathKey(p, osName) !== key);
}

// ---------- flows ----------

const groups = () => settings().groups;
const saveGroups = (next: Group[]) => updateSettings({ groups: next });

/** Asks for a name and creates the project; with `withPath`, moves that folder into it. Resolves with the name. */
export async function newProject(withPath?: string): Promise<string | null> {
  const name = (await input(S.newProjectPrompt))?.trim();
  if (!name) return null;
  if (nameTaken(groups(), name)) {
    await message(S.exists(name));
    return null;
  }
  let next = addGroup(groups(), name);
  if (withPath) next = moveToGroup(next, withPath, name, os());
  await saveGroups(next);
  return name;
}

export async function renameProject(name: string): Promise<void> {
  const to = (await input(S.renamePrompt, { value: name }))?.trim();
  if (!to || to === name) return;
  if (nameTaken(groups(), to, name)) {
    await message(S.exists(to));
    return;
  }
  await saveGroups(renameGroup(groups(), name, to));
}

export async function deleteProject(name: string): Promise<void> {
  const g = groups().find((x) => x.name === name);
  if (!g) return;
  const n = g.folders.filter((f) => f.trim()).length;
  if (!(await ask(S.deleteAsk(name, n), S.deleteCaption, "warning"))) return;
  await saveGroups(removeGroup(groups(), name));
}

/** Moves a folder into a project, or out of every project with null. */
export async function moveFolder(path: string, name: string | null): Promise<void> {
  await saveGroups(moveToGroup(groups(), path, name, os()));
}

export async function toggleGroup(name: string, collapsed?: boolean): Promise<void> {
  await saveGroups(setCollapsed(groups(), name, collapsed));
}

export async function toggleFolders(): Promise<void> {
  await updateSettings({ ungroupedCollapsed: !settings().ungroupedCollapsed });
}

export async function pin(paths: readonly string[]): Promise<void> {
  const next = withPins(settings().pinned, paths, os());
  if (next.length !== settings().pinned.length) await updateSettings({ pinned: next });
}

export async function unpin(path: string): Promise<void> {
  await updateSettings({ pinned: withoutPin(settings().pinned, path, os()) });
}

export async function togglePin(path: string): Promise<void> {
  if (isPinned(settings().pinned, path, os())) await unpin(path);
  else await pin([path]);
}
