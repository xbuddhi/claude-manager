// What the sessions view shows for the sidebar selection: one folder's sessions, or the sessions of every
// folder of a group (project), newest first. Pure, so it is tested without the DOM.

import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { leaf } from "../../core/format";
import { samePath } from "../../core/paths";
import type { SidebarSelection } from "../../core/store";

/** What the list shows of a scope: `sessions` is either the active or the archived ones. */
interface Listed {
  sessions: Session[];
  /** How many of the scope's sessions are archived. */
  archived: number;
  /** `sessions` are the archived ones. */
  showingArchived: boolean;
}

export type Scope =
  | ({ kind: "folder"; name: string; path: string; project: Project | null } & Listed)
  | ({ kind: "group"; name: string; folders: string[] } & Listed);

/** Splits off the archived sessions; with none left to show, the list goes back to the active ones. */
function listed(all: readonly Session[], archived: ReadonlySet<string>, showArchived: boolean): Listed {
  const out = all.filter((s) => archived.has(s.id));
  const showing = showArchived && out.length > 0;
  return {
    sessions: showing ? out : out.length ? all.filter((s) => !archived.has(s.id)) : [...all],
    archived: out.length,
    showingArchived: showing,
  };
}

export function buildScope(
  sel: SidebarSelection | null,
  projects: readonly Project[],
  os: string,
  archived: ReadonlySet<string> = new Set(),
  showArchived = false,
): Scope | null {
  if (!sel) return null;
  if (sel.kind === "folder") {
    const path = sel.path;
    if (!path) return null;
    const project = projects.find((p) => samePath(p.path, path, os)) ?? null;
    return {
      kind: "folder",
      name: leaf(path),
      path,
      project,
      ...listed(project?.sessions ?? [], archived, showArchived),
    };
  }
  const folders = sel.folders ?? [];
  const sessions = projects
    .filter((p) => folders.some((f) => samePath(f, p.path, os)))
    .flatMap((p) => p.sessions)
    .sort((a, b) => b.modified - a.modified);
  return { kind: "group", name: sel.name ?? "", folders, ...listed(sessions, archived, showArchived) };
}

/** The folder a session starts in: where it ran, else the folder it is listed under, else `fallback`. */
export function sessionDir(s: Session, projects: readonly Project[], fallback: string | null): string | null {
  return s.cwd ?? projects.find((p) => p.sessions.some((x) => x.id === s.id))?.path ?? fallback;
}
