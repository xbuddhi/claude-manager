// Source control controls in the card head: change count, repository picker (several repositories only),
// branch pill, sync state, and Fetch / Pull / Push / Refresh with counts and tooltips.

import { h } from "../../core/dom";
import type { IconName } from "../../core/icons";
import { button, setButtonLabel } from "../../ui/button";
import { setTip } from "../../ui/tooltip";
import { NOT_PUBLISHED_TIP, pullTip, pushTip, type Sync, syncLabel } from "./strings";

export interface HeaderOptions {
  onRepoMenu(anchor: HTMLElement): void;
  onBranchMenu(anchor: HTMLElement): void;
  onFetch(): void;
  onPull(): void;
  onPush(): void;
  /** Resolves when the refresh is done: the icon spins until then. */
  onRefresh(): Promise<void> | void;
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

/** "Not published": a cloud with a slash, in place of the words (they took too much of the head). */
function unpublishedIcon(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5h7a2.75 2.75 0 0 0 .6-5.43A4 4 0 0 0 4.6 6 3.25 3.25 0 0 0 4.5 12.5zM2.5 2.5l11 11"/></svg>`;
  return t.content.firstElementChild as Element;
}

/** The longest the icon goes on turning after the refresh is done (to finish its turn; no animation: at once). */
const SPIN_END_MS = 700;

/** Spins the button's icon while `work` runs, then lets it finish the turn it is in. */
function spinWhile(b: HTMLButtonElement, work: Promise<void> | void) {
  b.classList.add("spinning");
  void Promise.resolve(work).finally(() => {
    const stop = () => {
      clearTimeout(timer);
      b.removeEventListener("animationiteration", stop);
      b.classList.remove("spinning");
    };
    const timer = setTimeout(stop, SPIN_END_MS);
    b.addEventListener("animationiteration", stop);
  });
}

/** Sets a button's count and tip, touching the DOM only when they change (the status is read every few seconds). */
function setCount(b: HTMLButtonElement, n: number, tip: string) {
  const num = b.querySelector(".git-num");
  const text = n ? String(n) : "";
  if (num && num.textContent !== text) num.textContent = text;
  if (b.getAttribute("aria-label") === tip) return;
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
  const refresh = iconButton("refresh", "Refresh", () => {
    if (!refresh.classList.contains("spinning")) spinWhile(refresh, opts.onRefresh());
  });
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
      if (branch.textContent !== (name ?? "")) setButtonLabel(branch, name ?? "");
      const label = name !== null && s ? syncLabel(s) : "";
      const unpublished = name !== null && !!s && !s.hasUpstream;
      if (unpublished !== sync.classList.contains("unpublished")) {
        sync.classList.toggle("unpublished", unpublished);
        sync.replaceChildren(...(unpublished ? [unpublishedIcon()] : []));
        setTip(sync, unpublished ? NOT_PUBLISHED_TIP : null);
        if (unpublished) sync.setAttribute("aria-label", label);
        else sync.removeAttribute("aria-label");
      }
      // the ahead/behind counts are on the commit button (Sync Changes) and the Pull / Push badges
      if (!unpublished && sync.textContent) sync.textContent = "";
      const state = s ?? { hasUpstream: true, ahead: 0, behind: 0 };
      setCount(push, name !== null ? state.ahead : 0, name !== null ? pushTip(state) : "Push");
      setCount(pull, name !== null ? state.behind : 0, name !== null ? pullTip(state) : "Pull");
    },
    setBusy(busy) {
      fetch.disabled = pull.disabled = push.disabled = busy;
    },
  };
}
