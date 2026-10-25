// The git feature's backend commands (src-tauri/src/git) and a runner that never throws.

import type { GitOutput } from "../../bindings/GitOutput";
import type { GitStatus } from "../../bindings/GitStatus";
import type { NewFile } from "../../bindings/NewFile";
import { call } from "../../core/api";

declare module "../../core/api" {
  interface Commands {
    /** Runs `git <args>` in the existing folder `dir` (allowed subcommands only). */
    git_run: { args: { dir: string; args: string[]; stdin?: string | null; poll?: boolean }; result: GitOutput };
    git_status: { args: { repo: string; poll?: boolean }; result: GitStatus };
    /** Repositories at or under a folder (itself, then sub-folders two levels deep); cached 30 s. */
    find_repos: { args: { path: string }; result: string[] };
    /** An untracked file of `repo` for the diff view. */
    read_new_file: { args: { repo: string; path: string }; result: NewFile };
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
