// The terminal panel under the chat, like VS Code's: a header with its name and actions (new terminal,
// kill, maximize, minimize), the terminals' panes, and the list of the tab's terminals on the right once it
// has more than one. Minimized, only the header stays, as a bar at the bottom of every tab naming its
// terminals; a click on it opens the panel (starting a shell when there is none). index.ts owns the terminals; this draws them and reports what was pressed.

import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { button } from "../../ui/button";

export interface ShellItem {
  id: number;
  name: string;
}

export interface ShellPanelActions {
  add(): void;
  kill(id: number): void;
  select(id: number): void;
  toggleMax(): void;
  /** Minimize, or open again from the bar. */
  toggleOpen(): void;
}

function svg(markup: string): Element {
  const t = document.createElement("template");
  t.innerHTML = markup;
  return t.content.firstElementChild as Element;
}

const maximizeIcon = () =>
  svg(
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/></svg>`,
  );
const restoreIcon = () =>
  svg(
    `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/></svg>`,
  );

/** "zsh", "zsh 2", ...: the same shell twice gets a number, so the list tells them apart. */
export function shellLabels(items: readonly ShellItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map(({ name }) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} ${n}`;
  });
}

export class ShellPanel {
  readonly el: HTMLElement;
  /** Holds each terminal's pane. */
  readonly panes: HTMLElement;
  /** The top edge, dragged to resize the panel. */
  readonly divider: HTMLElement;
  private list: HTMLElement;
  private max: HTMLButtonElement;
  private kill: HTMLButtonElement;
  private current: number | null = null;
  private minimize: HTMLButtonElement;
  private title: HTMLElement;
  private summary: HTMLElement;
  private minimized = false;

  constructor(private actions: ShellPanelActions) {
    const add = button({ icon: "plus", kind: "plain", title: "New terminal (Ctrl+Shift+`)", onClick: actions.add });
    this.kill = button({
      icon: "trash",
      kind: "plain",
      title: "Kill terminal",
      onClick: () => this.current !== null && actions.kill(this.current),
    });
    this.max = button({ icon: maximizeIcon(), kind: "plain", title: "Maximize panel", onClick: actions.toggleMax });
    this.minimize = button({ icon: "chevronDown", kind: "plain", onClick: actions.toggleOpen });
    for (const b of [add, this.kill, this.max, this.minimize]) b.classList.add("term-shell-act");
    this.summary = h("span", { class: "term-shell-summary" });
    this.title = h("span", { class: "term-shell-title" }, "Terminal");
    const head = h(
      "div",
      { class: "term-shell-head" },
      this.title,
      this.summary,
      h("span", { class: "ses-gap" }),
      add,
      this.kill,
      h("span", { class: "term-shell-sep", attrs: { "aria-hidden": "true" } }),
      this.max,
      this.minimize,
    );
    // minimized, the whole bar opens the panel again
    head.addEventListener("click", (e) => {
      if (this.minimized && !(e.target as Element).closest("button")) actions.toggleOpen();
    });
    this.panes = h("div", { class: "term-shell-panes" });
    this.list = h("div", { class: "term-shell-list", role: "tablist", attrs: { "aria-label": "Terminals" } });
    this.list.setAttribute("aria-orientation", "vertical");
    this.list.addEventListener("keydown", (e) => this.onListKey(e));
    this.divider = h("div", { class: "term-shell-divider" });
    this.el = h(
      "section",
      { class: "term-shell", attrs: { "aria-label": "Terminal panel" } },
      this.divider,
      head,
      h("div", { class: "term-shell-body" }, this.panes, this.list),
    );
    this.setMinimized(false);
  }

  /** The tab's terminals, `active` in front. The list shows from two terminals on. */
  render(items: readonly ShellItem[], active: number | null): void {
    this.current = active;
    this.kill.disabled = active === null;
    const labels = shellLabels(items);
    this.summary.textContent = labels.join(", ");
    this.list.hidden = items.length < 2;
    this.list.replaceChildren(
      ...items.map((item, i) => {
        const on = item.id === active;
        const icon = iconNode("terminal");
        icon.classList.add("term-shell-icon");
        const pick = h(
          "button",
          { type: "button", class: "term-shell-pick", role: "tab", tabIndex: on ? 0 : -1 },
          icon,
          h("span", { class: "term-shell-name" }, labels[i] ?? item.name),
        );
        pick.setAttribute("aria-selected", String(on));
        pick.addEventListener("click", () => this.actions.select(item.id));
        const kill = button({ icon: "trash", kind: "plain", title: `Kill ${labels[i] ?? item.name}` });
        kill.tabIndex = -1;
        kill.classList.add("term-shell-kill");
        kill.addEventListener("click", () => this.actions.kill(item.id));
        return h("div", { class: on ? "term-shell-row active" : "term-shell-row" }, pick, kill);
      }),
    );
  }

  /** Minimized: only the bar, naming the terminals; pressing it opens the panel again. */
  setMinimized(on: boolean): void {
    this.minimized = on;
    this.el.classList.toggle("minimized", on);
    const tip = on ? "Open the terminal panel (Ctrl+`)" : "Minimize the terminal panel (Ctrl+`)";
    this.minimize.dataset.tip = tip;
    this.minimize.setAttribute("aria-label", tip);
    this.minimize.setAttribute("aria-expanded", String(!on));
  }

  setMaximized(on: boolean): void {
    this.max.replaceChildren(iconNode(on ? restoreIcon() : maximizeIcon()));
    const tip = on ? "Restore panel size" : "Maximize panel";
    this.max.dataset.tip = tip;
    this.max.setAttribute("aria-label", tip);
    this.max.setAttribute("aria-pressed", String(on));
  }

  /** Up/Down (and Home/End) move between terminals in the list, as in a tab list. */
  private onListKey(e: KeyboardEvent) {
    const picks = [...this.list.querySelectorAll<HTMLButtonElement>(".term-shell-pick")];
    const i = picks.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const next =
      e.key === "ArrowDown"
        ? picks[(i + 1) % picks.length]
        : e.key === "ArrowUp"
          ? picks[(i - 1 + picks.length) % picks.length]
          : e.key === "Home"
            ? picks[0]
            : e.key === "End"
              ? picks[picks.length - 1]
              : undefined;
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.click();
  }
}
