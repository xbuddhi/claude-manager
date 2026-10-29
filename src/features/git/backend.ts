// The git feature's backend commands (src-tauri/src/git) and a runner that never throws.

import type { GitOutput } from "../../bindings/GitOutput";
import type { GitStatus } from "../../bindings/GitStatus";
import type { NewFile } from "../../bindings/NewFile";
import type { PullRequests } from "../../bindings/PullRequests";
import { call } from "../../core/api";

declare module "../../core/api" {
  interface Commands {
    /** Runs `git <args>` in the repository root `dir` (`rev-parse`: any folder). Allowed subcommands and arguments only; never the home or a profile folder. */
    git_run: { args: { dir: string; args: string[]; stdin?: string | null; poll?: boolean }; result: GitOutput };
    git_status: { args: { repo: string; poll?: boolean }; result: GitStatus };
    /** Repositories at or under a folder (itself, then sub-folders two levels deep); cached 30 s. */
    find_repos: { args: { path: string }; result: string[] };
    /** An untracked file of `repo` for the diff view. */
    read_new_file: { args: { repo: string; path: string }; result: NewFile };
    /** The https page of the repository a folder is in, from its remote; null without one. */
    git_web_url: { args: { dir: string }; result: string | null };
    /** A commit message for what a commit of `repo` would take, by `claude -p` (Sonnet) with `profile`. */
    git_commit_message: { args: { repo: string; profile: string | null }; result: string };
    /** The open pull requests of `repo`, through the user's GitHub CLI (gh). */
    git_pull_requests: { args: { repo: string }; result: PullRequests };
  }
}

export interface RunOptions {
  stdin?: string | null;
  /** The background status refresh (git takes no optional locks). */
  poll?: boolean;
}

/** Runs git; a command the backend refuses (or a missing folder) comes back as code -1 with the reason. */
export async function git(
  dir: string,
  args: string[],
  opts: RunOptions = {},
): Promise<GitOutput & { missing?: boolean }> {
  const res = await call(
    "git_run",
    { dir, args, stdin: opts.stdin ?? null, poll: opts.poll ?? false },
    { quiet: true },
  );
  if (res.ok) return res.value;
  return { code: -1, stdout: "", stderr: res.error.message, missing: res.error.code === "not_found" };
}
