// The bar above the terminal in front: a button showing or hiding the files panel, the session's folder
// (its full path; a click copies it), the git branch there with how many files changed (a click lists the
// branches to switch to), and buttons to open the folder in VS Code or in Explorer / Finder, and to show or
// hide the terminal panel (the user's shell) and the source control panel.

import { call } from "../../core/api";
import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { button } from "../../ui/button";
import { toast } from "../../ui/toast";
import { showBranchSwitcher } from "../git/api";
import { copyText, folderLabel, openFolder, openInCode } from "../os/api";

/** How often the branch and changes are read again while a terminal is in front. */
const GIT_POLL_MS = 10_000;

export class SessionBar {
  readonly el: HTMLElement;
  private path: HTMLButtonElement;
  private git: HTMLButtonElement;
  private files: HTMLButtonElement;
  private source: HTMLButtonElement;
  private shell: HTMLButtonElement;
  private gitText: HTMLSpanElement;
  private dir: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;

  /** The files, source control and terminal panel buttons were pressed. */
  constructor(toggleFiles: () => void, toggleSource: () => void, toggleShell: () => void) {
    this.files = button({ icon: "sidebar", kind: "plain", title: "Files", onClick: toggleFiles });
    this.gitText = h("span", { class: "ses-git-text" });
    this.path = h("button", { type: "button", class: "ses-path" });
    this.path.addEventListener("click", () => void this.copyPath());
    this.git = h("button", { type: "button", class: "ses-git", hidden: true }, iconNode("branch"), this.gitText);
    this.git.setAttribute("aria-haspopup", "menu");
    this.git.addEventListener("click", () => {
      if (this.dir) void showBranchSwitcher(this.git, this.dir, () => void this.readGit());
    });
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
    this.shell = button({ icon: "terminal", kind: "plain", title: "Terminal", onClick: toggleShell });
    this.source = button({ icon: "branch", kind: "plain", title: "Source control", onClick: toggleSource });
    this.el = h(
      "div",
      { class: "ses-bar" },
      this.files,
      iconNode("folder"),
      this.path,
      this.git,
      h("span", { class: "ses-gap" }),
      code,
      folder,
      this.shell,
      this.source,
    );
    window.addEventListener("focus", () => void this.readGit());
  }

  /** Marks the files panel button as on or off. */
  setFilesOpen(open: boolean): void {
    this.files.setAttribute("aria-pressed", String(open));
    this.files.dataset.tip = open ? "Hide files" : "Show files";
  }

  /** Marks the source control panel button as on or off. */
  setSourceOpen(open: boolean): void {
    this.source.setAttribute("aria-pressed", String(open));
    this.source.dataset.tip = open ? "Hide source control" : "Show source control";
  }

  /** Marks the terminal panel button as on or off. */
  setShellOpen(open: boolean): void {
    this.shell.setAttribute("aria-pressed", String(open));
    this.shell.dataset.tip = `${open ? "Minimize terminal" : "Show terminal"} (Ctrl+\`)`;
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
    this.git.dataset.tip = "Switch branch";
    this.git.hidden = false;
  }

  private async copyPath() {
    if (this.dir && (await copyText(this.dir))) toast("Folder path copied");
  }
}
