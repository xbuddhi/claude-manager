// The branch menu (local branches, the current one checked, then "Create new branch...") and the
// repository picker menu.

import { pathKey } from "../../core/paths";
import { isWindows } from "../../core/platform";
import { store } from "../../core/store";
import { input } from "../../ui/dialog";
import { type MenuItem, showMenu } from "../../ui/menu";
import { git } from "./backend";
import { repoLabels } from "./repos";
import { branchName, TEXT } from "./strings";

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
    run: () => actions.switchTo(b.name),
  }));
  if (items.length) items.push({ kind: "separator" });
  items.push({
    label: TEXT.createBranch,
    icon: "plus",
    run: async () => {
      const typed = await input(TEXT.newBranch);
      const name = typed === null ? "" : branchName(typed);
      if (!name) return;
      if (name.startsWith("-")) actions.error(TEXT.badBranch);
      else actions.create(name);
    },
  });
  await showMenu(items, { at: { anchor }, label: "Branches" });
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
