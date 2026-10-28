// Texts of the source control view and the pure helpers that build them (wording from the Windows app).

import { leaf, plural } from "../../core/format";

export const TEXT = {
  selectFolder: "Select a folder in the sidebar",
  selectFile: "Select a file to see its changes",
  selectCommit: "Select a commit to see its changes",
  notRepoStatus: "Not a git repository",
  noTextChanges: "No text changes",
  emptyCommit: "Empty commit",
  fileNotFound: "File not found",
  noChanges: "No changes",
  typeMessage: "Type a commit message first.",
  nothingToCommit: "There is nothing to commit.",
  stageAllAndCommit: "There are no staged changes. Stage all changes and commit them?",
  undoCommit: "Undo the last commit? Its changes stay in your working tree, staged.",
  discardAll: "Discard ALL changes to tracked files?\n\nNew (untracked) files are kept. This cannot be undone.",
  newBranch: "New branch\nName for the new branch (created from the current one):",
  createBranch: "Create new branch...",
  findBranch: "Find a branch",
  switchConflicts: "This repository has merge conflicts\nResolve them, or abort the merge, before switching branches.",
  badBranch: "A branch name cannot start with '-'.",
} as const;

export function notRepo(folder: string): string {
  return `${leaf(folder)} is not a git repository, and no repositories were found in its sub-folders.\n\nRight-click it in the sidebar to open it in VS Code, or run 'git init' there.`;
}

export function discardFile(path: string): string {
  return `Discard your changes to '${path}'?\n\nThis cannot be undone.`;
}

export function deleteNewFile(path: string, trash: string): string {
  return `Delete the new file '${path}'?\n\nIt goes to the ${trash}.`;
}

export function largeFile(name: string, bytes: number): string {
  return `${name} is a large new file (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
}

export function binaryFile(name: string): string {
  return `${name} is a new binary file`;
}

export function placeholder(mac: boolean): string {
  return mac ? "Message (⌘↵ to commit)" : "Message (Ctrl+Enter to commit)";
}

export interface Sync {
  hasUpstream: boolean;
  ahead: number;
  behind: number;
}

export function syncLabel({ hasUpstream, ahead, behind }: Sync): string {
  if (!hasUpstream) return "not published";
  return ahead || behind ? `↑${ahead}  ↓${behind}` : "up to date";
}

export function pushTip({ hasUpstream, ahead }: Sync): string {
  if (!hasUpstream) return "Publish branch";
  return ahead ? `Push ${ahead} commit(s)` : "Push";
}

export function pullTip({ behind }: Sync): string {
  return behind ? `Pull ${behind} commit(s)` : "Pull";
}

/** The count next to the view title: "3 changes", "clean". */
export function changeCount(total: number): string {
  return total ? plural(total, "change") : "clean";
}

export function changesTab(total: number): string {
  return total ? `Changes  ${total}` : "Changes";
}

export function commitLabel(staged: number): string {
  return staged ? `Commit ${staged} staged` : "Commit";
}

const nonEmptyLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** A failed git: its first two non-empty lines (stderr first), or "git failed (exit N)". */
export function errorText(code: number, stdout: string, stderr: string): string {
  const lines = nonEmptyLines(`${stderr}\n${stdout}`).slice(0, 2);
  return lines.length ? lines.join("  ") : `git failed (exit ${code})`;
}

/** A successful git: its last non-empty line (stdout first), or "Done". */
export function successText(stdout: string, stderr: string): string {
  return nonEmptyLines(`${stdout}\n${stderr}`).pop() ?? "Done";
}

/** The stash message: "2026-10-25 14:05 from Claude Manager" in local time. */
export function stashMessage(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} from Claude Manager`;
}

/** The question before switching with uncommitted files (`changed`) or while Claude works in the folder. */
export function switchAsk(name: string, changed: number, working: boolean): string {
  const parts: string[] = [];
  if (working) parts.push("Claude is working in this folder: its files change under it when you switch.");
  if (changed)
    parts.push(
      `${changed} uncommitted file${changed === 1 ? "" : "s"}: bring them along (git stops, changing nothing, if they clash with ${name}), or stash them first (Pop latest stash in Source control brings them back).`,
    );
  return `Switch to ${name}?\n${parts.join("\n\n")}`;
}

/** Whitespace runs become "-" ("my feature" -> "my-feature"). */
export function branchName(typed: string): string {
  return typed.trim().replace(/\s+/g, "-");
}

/** Whether a commit's %D decorations include HEAD (checked out here). */
export function isHead(refs: string): boolean {
  return /(^|, )HEAD($| ->|,)/.test(refs);
}

/** %D as pills: "HEAD" and "<remote>/HEAD" dropped, "HEAD -> main" becomes "*main", "tag: " removed. */
export function refPills(refs: string): string[] {
  if (!refs.trim()) return [];
  return refs
    .split(", ")
    .map((r) => r.trim())
    .filter((r) => r && r !== "HEAD" && !r.endsWith("/HEAD"))
    .map((r) => {
      const head = /^HEAD -> (.+)$/.exec(r);
      return head ? `*${head[1]}` : r.replace(/^tag: /, "");
    });
}

/**
 * git's relative date (%ar) for a commit time in Unix seconds, shortened like the Windows app:
 * "45s", "5m", "2h", "3d", "1w", "2mo", "1y 2mo", "6y". Same thresholds and rounding as git.
 */
export function shortAge(at: number, nowMs = Date.now()): string {
  let diff = Math.floor(nowMs / 1000) - at;
  if (diff < 0) return "now";
  if (diff < 90) return `${diff}s`;
  diff = Math.floor((diff + 30) / 60); // minutes
  if (diff < 90) return `${diff}m`;
  diff = Math.floor((diff + 30) / 60); // hours
  if (diff < 36) return `${diff}h`;
  diff = Math.floor((diff + 12) / 24); // days
  if (diff < 14) return `${diff}d`;
  if (diff < 70) return `${Math.floor((diff + 3) / 7)}w`;
  if (diff < 365) return `${Math.floor((diff + 15) / 30)}mo`;
  if (diff < 1825) {
    const total = Math.floor((diff * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(total / 12);
    const months = total % 12;
    return months ? `${years}y ${months}mo` : `${years}y`;
  }
  return `${Math.floor((diff + 183) / 365)}y`;
}

/** One record of the history query (fields split by 0x1F, records by 0x1E). */
export interface Commit {
  hash: string;
  parents: string;
  subject: string;
  author: string;
  at: number;
  refs: string;
}

export const LOG_ARGS = [
  "log",
  "--branches",
  "--remotes",
  "--tags",
  "HEAD",
  "--date-order",
  "-n",
  "400",
  "--pretty=format:%H%x1f%P%x1f%s%x1f%an%x1f%at%x1f%D%x1e",
];

export function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash = "", parents = "", subject = "", author = "", at = "0", refs = ""] = r.split("\x1f");
      return { hash, parents, subject, author, at: Number(at) || 0, refs };
    });
}
