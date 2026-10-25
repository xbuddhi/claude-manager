// What the sessions view shows for the sidebar selection: one folder's sessions, or the sessions of every
// folder of a group (project), newest first. Pure, so it is tested without the DOM.

import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { leaf } from "../../core/format";
import { samePath } from "../../core/paths";
import type { SidebarSelection } from "../../core/store";

export type Scope =
  | { kind: "folder"; name: string; path: string; project: Project | null; sessions: Session[] }
  | { kind: "group"; name: string; folders: string[]; sessions: Session[] };

export function buildScope(sel: SidebarSelection | null, projects: readonly Project[], os: string): Scope | null {
  if (!sel) return null;
  if (sel.kind === "folder") {
    const path = sel.path;
    if (!path) return null;
    const project = projects.find((p) => samePath(p.path, path, os)) ?? null;
    return { kind: "folder", name: leaf(path), path, project, sessions: project?.sessions ?? [] };
  }
  const folders = sel.folders ?? [];
  const sessions = projects
    .filter((p) => folders.some((f) => samePath(f, p.path, os)))
    .flatMap((p) => p.sessions)
    .sort((a, b) => b.modified - a.modified);
  return { kind: "group", name: sel.name ?? "", folders, sessions };
}

/** The folder a session starts in: where it ran, else the folder it is listed under, else `fallback`. */
export function sessionDir(s: Session, projects: readonly Project[], fallback: string | null): string | null {
  return s.cwd ?? projects.find((p) => p.sessions.some((x) => x.id === s.id))?.path ?? fallback;
}
