// Source control controls in the card head: change count, repository picker (several repositories only),
// branch pill, sync state, and Fetch / Pull / Push / Refresh with counts and tooltips.

import { h } from "../../core/dom";
import type { IconName } from "../../core/icons";
import { button, setButtonLabel } from "../../ui/button";
import { setTip } from "../../ui/tooltip";
import { pullTip, pushTip, type Sync, syncLabel } from "./strings";

export interface HeaderOptions {
  onRepoMenu(anchor: HTMLElement): void;
  onBranchMenu(anchor: HTMLElement): void;
  onFetch(): void;
  onPull(): void;
  onPush(): void;
  onRefresh(): void;
}

export interface Header {
  setCount(text: string): void;
  /** null hides the picker. */
  setRepo(label: string | null, path?: string): void;
  /** null hides the branch pill and clears the sync state. */
  setBranch(branch: string | null, sync?: Sync): void;
  setBusy(busy: boolean): void;
}

function iconButton(icon: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = button({ icon, kind: "plain", title, onClick });
  b.classList.add("git-hbtn");
  b.append(h("span", { class: "git-num" }));
  return b;
}

function setCount(b: HTMLButtonElement, n: number, tip: string) {
  const num = b.querySelector(".git-num");
  if (num) num.textContent = n ? String(n) : "";
  setTip(b, tip);
  b.setAttribute("aria-label", tip);
}

export function createHeader(el: HTMLElement, opts: HeaderOptions): Header {
  const count = h("span", { class: "git-count" });
  const repo = button({ label: "folder", icon: "folder", kind: "plain", onClick: () => opts.onRepoMenu(repo) });
  repo.classList.add("git-repo");
  repo.setAttribute("aria-haspopup", "menu");
  const branch = button({ label: "main", icon: "branch", kind: "secondary", onClick: () => opts.onBranchMenu(branch) });
  branch.classList.add("git-branch");
  branch.setAttribute("aria-haspopup", "menu");
  setTip(branch, "Switch or create a branch");
  const sync = h("span", { class: "git-sync" });
  const fetch = iconButton("fetch", "Fetch from remote", opts.onFetch);
  const pull = iconButton("pull", "Pull", opts.onPull);
  const push = iconButton("push", "Push", opts.onPush);
  const refresh = iconButton("refresh", "Refresh", opts.onRefresh);
  repo.hidden = branch.hidden = true;
  el.append(count, repo, branch, sync, h("span", { class: "git-hbtns" }, fetch, pull, push, refresh));

  return {
    setCount: (text) => {
      count.textContent = text;
    },
    setRepo(label, path) {
      repo.hidden = label === null;
      setButtonLabel(repo, label ?? "");
      setTip(repo, path ?? null);
    },
    setBranch(name, s) {
      branch.hidden = name === null;
      setButtonLabel(branch, name ?? "");
      sync.textContent = name !== null && s ? syncLabel(s) : "";
      const state = s ?? { hasUpstream: true, ahead: 0, behind: 0 };
      setCount(push, name !== null ? state.ahead : 0, name !== null ? pushTip(state) : "Push");
      setCount(pull, name !== null ? state.behind : 0, name !== null ? pullTip(state) : "Pull");
    },
    setBusy(busy) {
      fetch.disabled = pull.disabled = push.disabled = busy;
    },
  };
}
