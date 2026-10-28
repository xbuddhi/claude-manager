// The branch menu (local branches, the current one checked, then "Create new branch..."), the checks
// before switching (merge conflicts, uncommitted changes, Claude working there), and the repository picker.

import { call } from "../../core/api";
import { pathKey } from "../../core/paths";
import { isWindows } from "../../core/platform";
import { store } from "../../core/store";
import { choose, input, message } from "../../ui/dialog";
import { type MenuItem, showMenu } from "../../ui/menu";
import { folderLevel } from "../live/api";
import { git } from "./backend";
import { repoLabels } from "./repos";
import { branchName, stashMessage, switchAsk, TEXT } from "./strings";

/** `git branch --format=%(HEAD)%09%(refname:short)` as [name, current]. */
export function parseBranches(out: string): Array<{ name: string; current: boolean }> {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter(Boolean)
    .map((line) => {
      const [cur = "", name = ""] = line.split("\t", 2);
      return { name, current: cur === "*" };
    })
    .filter((b) => b.name);
}

export interface BranchActions {
  switchTo(name: string): void;
  create(name: string): void;
  error(text: string): void;
}

export async function showBranchMenu(anchor: HTMLElement, repo: string, actions: BranchActions): Promise<void> {
  const out = await git(repo, ["branch", "--format=%(HEAD)%09%(refname:short)"]);
  const items: MenuItem[] = parseBranches(out.code === 0 ? out.stdout : "").map((b) => ({
    label: b.name,
    icon: "branch",
    checked: b.current,
    // already on it: nothing to do
    run: b.current ? undefined : () => actions.switchTo(b.name),
  }));
  if (items.length) items.push({ kind: "separator" });
  // what was typed in the search field becomes the suggested name of a new branch
  let query = "";
  items.push({
    label: TEXT.createBranch,
    icon: "plus",
    keep: true,
    run: async () => {
      const typed = await input(TEXT.newBranch, { value: query.trim() });
      const name = typed === null ? "" : branchName(typed);
      if (!name) return;
      if (name.startsWith("-")) actions.error(TEXT.badBranch);
      else actions.create(name);
    },
  });
  await showMenu(items, {
    at: { anchor },
    label: "Branches",
    filter: { placeholder: TEXT.findBranch, onInput: (q) => (query = q) },
  });
}

/**
 * The git commands that switch `repo` to `name`, after checking it is safe: none (null) with merge
 * conflicts or when the user cancels. Uncommitted changes either come along (git itself stops, changing
 * nothing, when they clash with the other branch) or are stashed first; Claude working in the folder is
 * said too, since its files change under it.
 */
export async function planSwitch(repo: string, name: string): Promise<string[][] | null> {
  const switchArgs = ["switch", name];
  const res = await call("git_status", { repo }, { quiet: true });
  // status unknown: let git decide (it refuses on its own when the switch would lose anything)
  if (!res.ok) return [switchArgs];
  const files = [...res.value.staged, ...res.value.changes];
  if (files.some((f) => f.status === "!")) {
    await message(TEXT.switchConflicts, "warning");
    return null;
  }
  const working = folderLevel(repo) === 2;
  if (!files.length && !working) return [switchArgs];
  const text = switchAsk(name, files.length, working);
  if (!files.length) {
    const go = await choose(
      text,
      [
        { id: "cancel", label: "Cancel" },
        { id: "go", label: "Switch", kind: "primary" },
      ],
      {
        cancel: "cancel",
        primary: "go",
        kind: "warning",
      },
    );
    return go === "go" ? [switchArgs] : null;
  }
  const pick = await choose(
    text,
    [
      { id: "cancel", label: "Cancel" },
      { id: "stash", label: "Stash and switch" },
      { id: "bring", label: "Bring changes", kind: "primary" },
    ],
    { cancel: "cancel", primary: "bring", kind: "warning" },
  );
  if (pick === "cancel") return null;
  return pick === "stash" ? [["stash", "push", "-u", "-m", stashMessage()], switchArgs] : [switchArgs];
}

export function showRepoMenu(
  anchor: HTMLElement,
  repos: string[],
  current: string | null,
  pick: (repo: string) => void,
): void {
  const os = store.get().platform.os;
  const labels = repoLabels(repos, isWindows() ? "\\" : "/");
  const items: MenuItem[] = repos.map((repo, i) => ({
    label: labels[i] ?? repo,
    icon: "folder",
    checked: current !== null && pathKey(repo, os) === pathKey(current, os),
    run: () => pick(repo),
  }));
  void showMenu(items, { at: { anchor }, label: "Repositories" });
}
