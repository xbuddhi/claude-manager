// The STAGED CHANGES / CHANGES list: file name coloured by status, muted folder, status letter, and action
// buttons that show on hover and on keyboard focus. Selection is kept by section + path across refreshes.

import type { GitChange } from "../../bindings/GitChange";
import type { GitStatus } from "../../bindings/GitStatus";
import { h } from "../../core/dom";
import { type IconName, iconNode } from "../../core/icons";
import { createList } from "../../ui/list";
import { TEXT } from "./strings";

export type Section = "staged" | "changes";
export type Action = "open" | "discard" | "stage" | "unstage" | "stageAll" | "discardAll" | "unstageAll";

export type ChangeRow =
  | { kind: "section"; section: Section; count: number }
  | { kind: "file"; section: Section; change: GitChange };

const ACTIONS: Record<Action, { title: string; icon: IconName }> = {
  open: { title: "Open file", icon: "file" },
  discard: { title: "Discard changes", icon: "undo" },
  discardAll: { title: "Discard all changes", icon: "undo" },
  stage: { title: "Stage", icon: "plus" },
  stageAll: { title: "Stage all", icon: "plus" },
  unstage: { title: "Unstage", icon: "minus" },
  unstageAll: { title: "Unstage all", icon: "minus" },
};

export function actionsFor(row: ChangeRow): Action[] {
  if (row.kind === "section") return row.section === "staged" ? ["unstageAll"] : ["discardAll", "stageAll"];
  return row.section === "staged" ? ["open", "unstage"] : ["open", "discard", "stage"];
}

/** CSS class for a status letter's colour. */
export function statusClass(status: string): string {
  switch (status) {
    case "M":
      return "git-st-mod";
    case "A":
    case "U":
      return "git-st-add";
    case "D":
      return "git-st-del";
    case "R":
    case "C":
      return "git-st-ren";
    case "!":
      return "git-st-conf";
    default:
      return "git-st-other";
  }
}

/** Rows for a status: STAGED CHANGES only when something is staged, CHANGES always. */
export function changeRows(status: GitStatus | null): ChangeRow[] {
  if (!status) return [];
  const rows: ChangeRow[] = [];
  const add = (section: Section, list: GitChange[]) => {
    rows.push({ kind: "section", section, count: list.length });
    for (const change of list) rows.push({ kind: "file", section, change });
  };
  if (status.staged.length) add("staged", status.staged);
  add("changes", status.changes);
  return rows;
}

export function rowKey(row: ChangeRow): string {
  return row.kind === "section" ? `#${row.section}` : `${row.section}|${row.change.path}`;
}

export interface ChangesOptions {
  onSelect(row: Extract<ChangeRow, { kind: "file" }> | null): void;
  onOpen(row: Extract<ChangeRow, { kind: "file" }>): void;
  onAction(row: ChangeRow, action: Action): void;
}

export interface Changes {
  el: HTMLElement;
  set(status: GitStatus | null): void;
  selected(): Extract<ChangeRow, { kind: "file" }> | null;
  clearSelection(): void;
}

export function createChanges(opts: ChangesOptions): Changes {
  const fileOf = (key: string | undefined) => {
    const row = list.rows().find((r) => rowKey(r) === key);
    return row?.kind === "file" ? row : null;
  };
  const list = createList<ChangeRow>({
    label: "Changes",
    key: rowKey,
    height: (r) => (r.kind === "section" ? 30 : 26),
    selectable: (r) => r.kind === "file",
    create(row) {
      const acts = h("span", { class: "git-acts" });
      for (const a of actionsFor(row)) {
        const b = h("button", {
          type: "button",
          class: "git-act",
          dataset: { act: a, tip: ACTIONS[a].title },
          attrs: { "aria-label": ACTIONS[a].title },
        });
        b.append(iconNode(ACTIONS[a].icon));
        // an action never selects or opens the row
        b.addEventListener("mousedown", (e) => e.stopPropagation());
        b.addEventListener("dblclick", (e) => e.stopPropagation());
        acts.append(b);
      }
      if (row.kind === "section") {
        return h(
          "div",
          { class: "git-row git-sec" },
          h("span", { class: "git-sec-title" }, row.section === "staged" ? "STAGED CHANGES" : "CHANGES"),
          acts,
          h("span", { class: "git-badge" }),
        );
      }
      return h(
        "div",
        { class: "git-row git-file" },
        h("span", { class: "git-name" }),
        h("span", { class: "git-dir" }),
        acts,
        h("span", { class: "git-letter" }),
      );
    },
    update(el, row) {
      if (row.kind === "section") {
        (el.lastElementChild as HTMLElement).textContent = String(row.count);
        return;
      }
      const { name, dir, status, path } = row.change;
      const [nameEl, dirEl, , letterEl] = [...el.children] as HTMLElement[];
      if (!nameEl || !dirEl || !letterEl) return;
      nameEl.textContent = name;
      nameEl.className = `git-name ${status === "D" ? "git-st-gone" : statusClass(status)}`;
      dirEl.textContent = dir;
      letterEl.textContent = status;
      letterEl.className = `git-letter ${statusClass(status)}`;
      el.dataset.tip = path;
    },
    onSelectionChange: (keys) => opts.onSelect(fileOf(keys[0])),
    onActivate: (row) => {
      if (row.kind === "file") opts.onOpen(row);
    },
  });
  const empty = h("div", { class: "git-empty" }, TEXT.noChanges);
  const el = h("div", { class: "git-changes" }, list.el, empty);

  list.el.addEventListener("click", (e) => {
    const b = (e.target as Element | null)?.closest<HTMLElement>(".git-act");
    const key = b?.closest<HTMLElement>(".list-row")?.dataset.key;
    const row = list.rows().find((r) => rowKey(r) === key);
    if (b && row) opts.onAction(row, b.dataset.act as Action);
  });

  return {
    el,
    set(status) {
      const rows = changeRows(status);
      empty.hidden = rows.length > 0;
      list.setRows(rows);
    },
    selected: () => fileOf(list.selection.selected[0]),
    clearSelection() {
      if (list.selection.clear()) opts.onSelect(null);
      list.refresh();
    },
  };
}
