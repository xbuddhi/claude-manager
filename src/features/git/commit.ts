// The commit message box (grows from one to six lines; Ctrl+Enter / Cmd+Enter commits; a sparkle button
// in its corner has Claude write the message) and the commit split button with its menu of alternatives.
// With nothing to commit the button syncs or publishes the branch instead (strings.ts commitAction).

import { h } from "../../core/dom";
import { type IconName, iconNode } from "../../core/icons";
import { isMac } from "../../core/platform";
import { button as iconButton } from "../../ui/button";
import { type MenuItem, showMenu } from "../../ui/menu";
import { splitButton } from "../../ui/splitbutton";
import { type CommitAction, commitLabel, placeholder, TEXT } from "./strings";

const LINE = 18;
const MAX_LINES = 6;
const PAD = 10;

/** Generate: sparkles (only this box uses it). */
function sparkle(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M7 2.5l1.1 3.4 3.4 1.1-3.4 1.1L7 11.5 5.9 8.1 2.5 7l3.4-1.1zM12 10l.55 1.45L14 12l-1.45.55L12 14l-.55-1.45L10 12l1.45-.55z"/></svg>`;
  return t.content.firstElementChild as Element;
}

const ACTION_ICON: Record<CommitAction, IconName> = { commit: "check", sync: "refresh", publish: "push" };

export interface CommitOptions {
  /** The button was pressed (Ctrl+Enter / Cmd+Enter always commits). */
  onAction(action: CommitAction): void;
  /** Items for the arrow's menu, built when it opens. */
  menu(): MenuItem[];
  /** Writes a message for the changes; null when it could not (the caller says why). */
  generate(): Promise<string | null>;
}

export interface CommitBox {
  /** The message box and the button row, in order. */
  els: HTMLElement[];
  message(): string;
  clear(): void;
  /** Puts `text` in the box (the box grows to fit). */
  setMessage(text: string): void;
  focus(): void;
  /** What the button does and says (strings.ts commitAction). */
  setAction(action: CommitAction, label: string): void;
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
  const gen = iconButton({ icon: sparkle(), kind: "plain", title: TEXT.generateTip });
  gen.classList.add("git-gen");
  gen.addEventListener("click", async () => {
    if (gen.classList.contains("working")) return;
    gen.classList.add("working");
    gen.disabled = true;
    const text = await opts.generate();
    gen.classList.remove("working");
    gen.disabled = false;
    if (text === null) return;
    box.value = text;
    grow();
    box.focus();
    box.setSelectionRange(0, 0);
    box.scrollTop = 0;
  });
  const wrap = h("div", { class: "git-msg" }, box, gen);
  // one to six lines (git.css: 18px lines, 5px padding above and below); it scrolls beyond that
  const grow = () => {
    box.style.height = "auto";
    box.style.height = `${Math.min(MAX_LINES * LINE, Math.max(LINE, box.scrollHeight - PAD)) + PAD}px`;
  };
  box.addEventListener("input", grow);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      opts.onAction("commit");
    }
  });

  const button = splitButton({
    label: commitLabel(0),
    icon: "check",
    kind: "primary",
    arrowTitle: "More commit actions",
    onMain: () => opts.onAction(action),
    onArrow: (anchor) => void showMenu(opts.menu(), { at: { anchor, align: "end" }, label: "Commit actions" }),
  });
  button.el.classList.add("git-commit-btn");
  const row = h("div", { class: "git-commit-row" }, button.el);
  const main = button.el.querySelector<HTMLElement>(".sbtn-main");
  const label = main?.querySelector<HTMLElement>("span:last-child");
  let action: CommitAction = "commit";

  return {
    els: [wrap, row],
    message: () => box.value,
    clear() {
      box.value = "";
      grow();
    },
    setMessage(text) {
      box.value = text;
      grow();
    },
    focus: () => box.focus(),
    setAction(next, text) {
      if (label && label.textContent !== text) label.textContent = text;
      if (next === action) return;
      action = next;
      main?.firstElementChild?.replaceWith(iconNode(ACTION_ICON[next]));
    },
    setBusy: (busy) => button.setDisabled(busy),
  };
}
