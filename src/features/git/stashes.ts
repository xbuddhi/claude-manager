// The Stashes list: each stash's message, the branch it was made on and its age, with Apply, Pop and Drop
// buttons that show on hover and on keyboard focus. Selecting one shows its changes in the diff.

import { h } from "../../core/dom";
import { ago } from "../../core/format";
import { type IconName, iconNode } from "../../core/icons";
import { createList } from "../../ui/list";
import { type Stash, TEXT } from "./strings";

export type StashAction = "apply" | "pop" | "drop";

const ACTIONS: Record<StashAction, { title: string; icon: IconName }> = {
  apply: { title: "Apply (keep the stash)", icon: "check" },
  pop: { title: "Pop (apply and drop it)", icon: "pull" },
  drop: { title: "Drop", icon: "trash" },
};

export interface Stashes {
  el: HTMLElement;
  set(stashes: Stash[]): void;
  selected(): Stash | null;
  clearSelection(): void;
}

export function createStashes(
  onSelect: (s: Stash | null) => void,
  onAction: (s: Stash, action: StashAction) => void,
): Stashes {
  let byRef = new Map<string, Stash>();
  const list = createList<Stash>({
    label: "Stashes",
    key: (s) => s.ref,
    height: () => 44,
    create() {
      const acts = h("span", { class: "git-acts" });
      for (const a of ["apply", "pop", "drop"] as const) {
        const b = h("button", {
          type: "button",
          class: "git-act",
          dataset: { act: a, tip: ACTIONS[a].title },
          attrs: { "aria-label": ACTIONS[a].title },
        });
        b.append(iconNode(ACTIONS[a].icon));
        b.addEventListener("mousedown", (e) => e.stopPropagation());
        b.addEventListener("dblclick", (e) => e.stopPropagation());
        acts.append(b);
      }
      return h(
        "div",
        { class: "git-row git-two" },
        h(
          "span",
          { class: "git-two-text" },
          h("span", { class: "git-two-title" }),
          h("span", { class: "git-two-meta" }),
        ),
        acts,
      );
    },
    update(el, s) {
      const title = el.querySelector<HTMLElement>(".git-two-title");
      const meta = el.querySelector<HTMLElement>(".git-two-meta");
      if (!title || !meta) return;
      title.textContent = s.message || s.ref;
      meta.textContent = [s.branch, ago(s.time), s.ref].filter(Boolean).join("  ·  ");
    },
    onSelectionChange: (keys) => onSelect(byRef.get(keys[0] ?? "") ?? null),
  });
  const empty = h("div", { class: "git-empty" }, TEXT.noStashes);
  const el = h("div", { class: "git-changes" }, list.el, empty);
  list.el.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>(".git-act");
    const s = byRef.get(b?.closest<HTMLElement>(".list-row")?.dataset.key ?? "");
    if (b && s) onAction(s, b.dataset.act as StashAction);
  });
  return {
    el,
    set(stashes) {
      empty.hidden = stashes.length > 0;
      byRef = new Map(stashes.map((s) => [s.ref, s]));
      list.setRows(stashes);
    },
    selected: () => byRef.get(list.selection.selected[0] ?? "") ?? null,
    clearSelection() {
      if (list.selection.clear()) onSelect(null);
      list.refresh();
    },
  };
}
