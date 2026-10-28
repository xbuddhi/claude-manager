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
  undoCommit:
    "Undo the last commit? Its changes stay in your working tree, staged, and its message goes back into the message box.",
  discardAll: "Discard ALL changes to tracked files?\n\nNew (untracked) files are kept. This cannot be undone.",
  newBranch: "New branch\nName for the new branch (created from the current one):",
  createBranch: "Create new branch...",
  findBranch: "Find a branch",
  generateTip: "Write a commit message with Claude (Sonnet) from the changes",
  generating: "Claude is writing a commit message...",
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

export const NOT_PUBLISHED_TIP = "Not published yet\nPush (↑) publishes this branch to the remote.";

export function syncLabel({ hasUpstream, ahead, behind }: Sync): string {
  if (!hasUpstream) return "not published";
  return ahead || behind ? `↑${ahead}  ↓${behind}` : "up to date";
}

/** Lines of `git log --format=%h HEAD --not --remotes`: commits of an unpublished branch no remote has. */
export function unpublishedCount(stdout: string): number {
  return stdout.split("\n").filter((l) => l.trim()).length;
}

export function pushTip({ hasUpstream, ahead }: Sync): string {
  if (!hasUpstream) return ahead ? `Publish branch with ${ahead} commit(s)` : "Publish branch";
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

export type CommitAction = "commit" | "sync" | "publish";

/**
 * What the commit button does, like VS Code: Commit while there are changes; with none, Sync Changes when
 * the branch is behind or ahead of its upstream ("Sync Changes 3↓ 2↑"), Publish Branch when it has none.
 * `branch` null (no repository) or detached ("HEAD ...") keeps Commit.
 */
export function commitAction(
  staged: number,
  changes: number,
  branch: string | null,
  sync: Sync,
): { action: CommitAction; label: string } {
  const detached = branch === null || branch.startsWith("HEAD");
  if (staged + changes > 0 || detached) return { action: "commit", label: commitLabel(staged) };
  if (!sync.hasUpstream) return { action: "publish", label: "Publish Branch" };
  if (!sync.ahead && !sync.behind) return { action: "commit", label: commitLabel(0) };
  const counts = [sync.behind ? `${sync.behind}↓` : "", sync.ahead ? `${sync.ahead}↑` : ""].filter(Boolean);
  return { action: "sync", label: `Sync Changes ${counts.join(" ")}` };
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
  // a merge sits right above the commits it brought in (VS Code's order)
  "--topo-order",
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

// ---------- commit hover card ----------

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY],
];

/** "15 minutes ago", "yesterday", "3 months ago" for a commit time in seconds. */
export function longAge(at: number, nowMs = Date.now()): string {
  let n = Math.max(0, Math.floor(nowMs / 1000) - at);
  for (const [unit, size] of STEPS) {
    if (n < size) return RELATIVE.format(-Math.round(n), unit);
    n /= size;
  }
  return "";
}

/** "October 28, 2026 at 9:13 PM" (the user's locale). */
export function fullDate(at: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(new Date(at * 1000));
}

export interface CommitStats {
  files: number;
  insertions: number;
  deletions: number;
}

/** `git show --shortstat`'s " 14 files changed, 141 insertions(+), 22 deletions(-)"; null for none (merges). */
export function parseShortstat(text: string): CommitStats | null {
  const num = (re: RegExp) => Number(text.match(re)?.[1] ?? 0);
  const files = num(/(\d+) files? changed/);
  if (!files) return null;
  return { files, insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
}

/**
 * A commit body as paragraphs for the card: hard-wrapped lines of a paragraph join into one; bullet lists
 * keep one line per bullet (a wrapped bullet's next lines join it).
 */
export function bodyParagraphs(body: string): string[] {
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s/;
  return body
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((para) => {
      const lines = para.split("\n").filter((l) => l.trim());
      const out: string[] = [];
      for (const line of lines) {
        const last = out.length - 1;
        if (last >= 0 && !bullet.test(line)) out[last] = `${out[last]} ${line.trim()}`;
        else out.push(line.trim());
      }
      return out.join("\n");
    })
    .filter(Boolean);
}

/** The page of `hash` on the repository's site (GitLab spells it /-/commit/). */
export function commitUrl(web: string, hash: string): string {
  const gitlab = new URL(web).hostname.replace(/^www\./, "") === "gitlab.com";
  return `${web}/${gitlab ? "-/commit" : "commit"}/${hash}`;
}

/** `git show` for the card: the full message, a 0x1E, then the short stat. */
export function commitDetailArgs(hash: string): string[] {
  return ["show", "--shortstat", "--format=%B%x1e", hash];
}
