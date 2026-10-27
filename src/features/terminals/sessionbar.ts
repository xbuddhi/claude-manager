// The bar above the terminal in front: the session's folder (its full path; a click copies it), the git
// branch there with how many files changed, and buttons to open the folder in VS Code, in Explorer / Finder,
// or in Source control (Home, with that folder selected and the Source control view in front).

import { call } from "../../core/api";
import { emit } from "../../core/bus";
import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { showView } from "../../core/views";
import { button } from "../../ui/button";
import { toast } from "../../ui/toast";
import { copyText, folderLabel, openFolder, openInCode } from "../os/api";
import { folderKey } from "../sidebar/api";

/** How often the branch and changes are read again while a terminal is in front. */
const GIT_POLL_MS = 10_000;

export class SessionBar {
  readonly el: HTMLElement;
  private path: HTMLButtonElement;
  private git: HTMLButtonElement;
  private gitText: HTMLSpanElement;
  private dir: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;

  constructor() {
    this.gitText = h("span", { class: "ses-git-text" });
    this.path = h("button", { type: "button", class: "ses-path" });
    this.path.addEventListener("click", () => void this.copyPath());
    this.git = h("button", { type: "button", class: "ses-git", hidden: true }, iconNode("branch"), this.gitText);
    this.git.addEventListener("click", () => this.sourceControl());
    const code = button({
      icon: "vscode",
      kind: "plain",
      title: "Open folder in VS Code",
      onClick: () => this.dir && void openInCode([this.dir]),
    });
    const folder = button({
      icon: "folder",
      kind: "plain",
      title: folderLabel(),
      onClick: () => this.dir && void openFolder(this.dir),
    });
    const source = button({
      icon: "branch",
      label: "Source control",
      kind: "plain",
      onClick: () => this.sourceControl(),
    });
    this.el = h(
      "div",
      { class: "ses-bar" },
      iconNode("folder"),
      this.path,
      this.git,
      h("span", { class: "ses-gap" }),
      code,
      folder,
      source,
    );
    window.addEventListener("focus", () => void this.readGit());
  }

  /** Shows the bar for the session in front (null = none, e.g. Home). */
  show(dir: string | null): void {
    if (dir === this.dir && (this.timer !== undefined || !dir)) return;
    clearInterval(this.timer);
    this.timer = undefined;
    if (dir !== this.dir) {
      this.dir = dir;
      this.path.textContent = dir ?? "";
      this.path.dataset.tip = dir ? `${dir}\nClick to copy` : "";
      this.git.hidden = true;
    }
    if (!dir) return;
    void this.readGit();
    this.timer = setInterval(() => {
      if (!document.hidden) void this.readGit();
    }, GIT_POLL_MS);
  }

  private async readGit() {
    const dir = this.dir;
    if (!dir) return;
    const seq = ++this.seq;
    const res = await call("git_status", { repo: dir, poll: true }, { quiet: true });
    if (seq !== this.seq || dir !== this.dir) return;
    if (!res.ok) {
      this.git.hidden = true;
      return;
    }
    const s = res.value;
    const changed = s.staged.length + s.changes.length;
    const sync = [s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : ""].filter(Boolean).join(" ");
    this.gitText.textContent = [s.branch, changed ? `${changed} changed` : "", sync].filter(Boolean).join("  ·  ");
    this.git.dataset.tip = "Open in Source control";
    this.git.hidden = false;
  }

  private async copyPath() {
    if (this.dir && (await copyText(this.dir))) toast("Folder path copied");
  }

  /** Home, with this folder selected and Source control in front. */
  private sourceControl() {
    const dir = this.dir;
    if (!dir) return;
    emit("terminal:show", { id: null });
    emit("sidebar:select", { key: folderKey(dir) });
    showView("git");
  }
}
