// The commit message box (grows from one to six lines; Ctrl+Enter / Cmd+Enter commits) and the commit
// split button with its menu of alternatives.

import { h } from "../../core/dom";
import { isMac } from "../../core/platform";
import { type MenuItem, showMenu } from "../../ui/menu";
import { splitButton } from "../../ui/splitbutton";
import { commitLabel, placeholder } from "./strings";

const LINE = 18;
const MAX_LINES = 6;
const PAD = 10;

export interface CommitOptions {
  onCommit(): void;
  /** Items for the arrow's menu, built when it opens. */
  menu(): MenuItem[];
}

export interface CommitBox {
  /** The message box and the button row, in order. */
  els: HTMLElement[];
  message(): string;
  clear(): void;
  focus(): void;
  setStaged(n: number): void;
  setBusy(busy: boolean): void;
}

export function createCommitBox(opts: CommitOptions): CommitBox {
  const box = h("textarea", {
    class: "git-msg-input",
    rows: 1,
    spellcheck: true,
    placeholder: placeholder(isMac()),
    attrs: { "aria-label": "Commit message" },
  });
  const wrap = h("div", { class: "git-msg" }, box);
  // one to six lines (git.css: 18px lines, 5px padding above and below); it scrolls beyond that
  const grow = () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(MAX_LINES * LINE, Math.max(LINE, box.scrollHeight - PAD)) + PAD}px`;
  };
  box.addEventListener("input", grow);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      opts.onCommit();
    }
  });

  const button = splitButton({
    label: commitLabel(0),
    icon: "check",
    kind: "primary",
    arrowTitle: "More commit actions",
    onMain: opts.onCommit,
    onArrow: (anchor) => void showMenu(opts.menu(), { at: { anchor, align: "end" }, label: "Commit actions" }),
  });
  button.el.classList.add("git-commit-btn");
  const row = h("div", { class: "git-commit-row" }, button.el);
  const label = button.el.querySelector<HTMLElement>(".sbtn-main span:last-child");

  return {
    els: [wrap, row],
    message: () => box.value,
    clear() {
      box.value = "";
      grow();
    },
    focus: () => box.focus(),
    setStaged(n) {
      if (label) label.textContent = commitLabel(n);
    },
    setBusy: (busy) => button.setDisabled(busy),
  };
}
