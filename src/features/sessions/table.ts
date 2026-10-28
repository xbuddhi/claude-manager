// The sessions table: a virtualized list (ui/list.ts) with a fixed header row, zebra stripes and one
// rounded selection block over adjacent selected rows. A folder shows Session, Messages, Last active,
// Profile, Size; a project (group) shows Session, Folder, Messages, Last active, Profile.

import type { Session } from "../../bindings/Session";
import { h } from "../../core/dom";
import { leaf, size } from "../../core/format";
import { isMac } from "../../core/platform";
import { profileName } from "../../core/profiles";
import { createList, type List } from "../../ui/list";
import { type LiveLevel, liveDot, sessionLevel } from "../live/api";
import { chatIcon } from "./icons";
import { lastActive } from "./strings";

export const COLUMNS = {
  folder: ["Session", "Messages", "Last active", "Profile", "Size"],
  group: ["Session", "Folder", "Messages", "Last active", "Profile"],
} as const;

const TEMPLATE = {
  folder: "minmax(120px, 1fr) 90px 105px 85px 75px",
  group: "minmax(120px, 1fr) 150px 90px 105px 85px",
};
/** The same without the Profile column, for when one profile is in view (it would repeat on every row). */
const TEMPLATE_ONE = {
  folder: "minmax(120px, 1fr) 90px 105px 75px",
  group: "minmax(120px, 1fr) 150px 90px 105px",
};

export type Mode = keyof typeof COLUMNS;

/** The text of a row's cells, in column order. */
export function cells(s: Session, mode: Mode, level: number, profile: string, now = Date.now()): string[] {
  const when = lastActive(level, s.modified, now);
  return mode === "group"
    ? [s.label, s.cwd ? leaf(s.cwd) : "", String(s.count), when, profile]
    : [s.label, String(s.count), when, profile, size(s.sizeKb)];
}

export interface TableOptions {
  onSelect(ids: string[]): void;
  onActivate(s: Session): void;
  onMenu(s: Session, e: MouseEvent): void;
  onDelete(): void;
}

export interface Table {
  el: HTMLElement;
  list: List<Session>;
  setRows(rows: Session[], mode: Mode, oneProfile?: boolean): void;
  /** The count badge after the Session column's title (null hides it); `tip` says what it counts. */
  setCount(n: number | null, tip?: string): void;
  /** Redraws the visible rows (live levels or the clock changed). */
  refresh(): void;
}

export function createTable(opts: TableOptions): Table {
  let mode: Mode = "folder";
  const head = h("div", { class: "ses-head", attrs: { role: "row" } });
  const count = h("span", { class: "ses-badge", hidden: true });

  // a row's cells, kept when it is created (update() runs for every visible row on each refresh)
  const parts = new WeakMap<HTMLElement, { ico: HTMLElement; label: HTMLElement; rest: HTMLElement[] }>();

  const selectedAt = (i: number) => {
    const row = list.rows()[i];
    return row !== undefined && list.selection.isSelected(row.id);
  };

  const list: List<Session> = createList<Session>({
    label: "Sessions",
    role: "grid",
    multi: true,
    key: (s) => s.id,
    height: () => 36,
    create() {
      const ico = h("span", { class: "ses-ico" });
      const label = h("span", { class: "ses-label" });
      const first = h("span", { class: "ses-cell ses-first", attrs: { role: "gridcell" } }, ico, label);
      const rest = [1, 2, 3, 4].map(() => h("span", { class: "ses-cell", attrs: { role: "gridcell" } }));
      const el = h("div", { class: "ses-row" }, first, ...rest);
      parts.set(el, { ico, label, rest });
      return el;
    },
    update(el, s, state) {
      const level = sessionLevel(s.id) as LiveLevel;
      const text = cells(s, mode, level, profileName(s.profile));
      const p = parts.get(el);
      if (!p) return;
      const { ico, label, rest } = p;
      if (ico.dataset.level !== String(level)) {
        ico.dataset.level = String(level);
        ico.replaceChildren(level ? liveDot(level) : chatIcon());
      }
      // text is set only when it changed: a click re-renders the rows, and WebKit drops the click (and the
      // double-click) when the text node pressed on was replaced before the button came up
      if (label.textContent !== (text[0] ?? "")) label.textContent = text[0] ?? "";
      rest.forEach((c, i) => {
        const t = text[i + 1] ?? "";
        if (c.textContent !== t) c.textContent = t;
      });
      el.classList.toggle("zebra", state.index % 2 === 1);
      // adjacent selected rows merge into one block
      el.classList.toggle("sel-prev", state.selected && selectedAt(state.index - 1));
      el.classList.toggle("sel-next", state.selected && selectedAt(state.index + 1));
    },
    // the list has already updated every visible row (neighbours of a changed row change their corners)
    onSelectionChange: (ids) => opts.onSelect(ids),
    onActivate: (s) => opts.onActivate(s),
    onContextMenu: (s, e) => opts.onMenu(s, e),
  });
  list.el.classList.add("ses-list");
  // Delete, or Cmd+Backspace on macOS (a Mac's delete key is Backspace)
  list.el.addEventListener("keydown", (e) => {
    if (e.key === "Delete" || (isMac() && e.metaKey && e.key === "Backspace")) {
      e.preventDefault();
      opts.onDelete();
    }
  });
  // the header lines up with the rows: leave room for the list's scrollbar
  new ResizeObserver(() => {
    head.style.paddingRight = `${list.el.offsetWidth - list.el.clientWidth}px`;
  }).observe(list.el);

  const el = h("div", { class: "ses-table" }, head, list.el);

  let one = false;
  function setMode(next: Mode, oneProfile: boolean) {
    if (next === mode && oneProfile === one && head.childElementCount) return;
    mode = next;
    one = oneProfile;
    el.dataset.mode = mode;
    el.classList.toggle("one-profile", one);
    el.style.setProperty("--ses-cols", (one ? TEMPLATE_ONE : TEMPLATE)[mode]);
    head.replaceChildren(
      ...COLUMNS[mode].map((t) => h("span", { class: "ses-cell", attrs: { role: "columnheader" } }, t)),
    );
    head.firstElementChild?.append(count);
  }
  setMode("folder", false);

  return {
    el,
    list,
    setRows(rows, next, oneProfile = false) {
      const modeChanged = next !== mode || oneProfile !== one;
      setMode(next, oneProfile);
      list.setRows(rows);
      if (modeChanged) list.refresh();
    },
    setCount(n, tip) {
      count.hidden = n === null;
      count.textContent = String(n ?? "");
      if (tip) count.dataset.tip = tip;
      else delete count.dataset.tip;
    },
    refresh: () => list.refresh(),
  };
}
