// Virtualized keyed list with a selection model, used for the sidebar tree, the sessions table and git lists.
//
// Selection (SelectionModel, no DOM): click selects one row; Ctrl-click (Cmd on macOS) toggles; Shift
// extends a range from the anchor; Ctrl/Cmd+A selects all; arrows, Home/End and PageUp/PageDown move,
// skipping rows that cannot be selected (headings, hints); Shift with them extends. A right-click on an
// unselected row selects just it, on a selected row it keeps the selection. Selection is kept by key when
// the rows are replaced, so a data refresh never loses it.
//
// The list renders only the rows in view (plus some overscan) and reuses row elements by key.

import { h } from "../core/dom";
import { isMac } from "../core/platform";
import "./list.css";

export interface SelRow {
  key: string;
  selectable: boolean;
}

export interface ClickMods {
  /** Ctrl (Windows) / Cmd (macOS): add or remove one row. */
  toggle?: boolean;
  /** Shift: select the range from the anchor. */
  range?: boolean;
}

export type Move = "next" | "prev" | "first" | "last" | { page: number };

export class SelectionModel {
  private rows: SelRow[] = [];
  private pos = new Map<string, number>();
  private sel = new Set<string>();
  anchor: string | null = null;
  focus: string | null = null;

  constructor(readonly multi = true) {}

  /** Replaces the rows; keeps selection, focus and anchor for keys that are still there. Returns whether the selection changed. */
  setRows(rows: SelRow[]): boolean {
    this.rows = rows;
    this.pos = new Map(rows.map((r, i) => [r.key, i]));
    const before = this.selected.join("\n");
    for (const k of [...this.sel]) if (!this.canSelect(k)) this.sel.delete(k);
    if (this.focus !== null && !this.pos.has(this.focus)) this.focus = this.selected[0] ?? null;
    if (this.anchor !== null && !this.pos.has(this.anchor)) this.anchor = this.focus;
    return before !== this.selected.join("\n");
  }

  /** Selected keys in row order. */
  get selected(): string[] {
    return [...this.sel].sort((a, b) => (this.pos.get(a) ?? 0) - (this.pos.get(b) ?? 0));
  }

  isSelected(key: string): boolean {
    return this.sel.has(key);
  }

  private canSelect(key: string): boolean {
    const i = this.pos.get(key);
    return i !== undefined && !!this.rows[i]?.selectable;
  }

  private replace(keys: Iterable<string>): boolean {
    const next = new Set([...keys].filter((k) => this.canSelect(k)));
    const changed = next.size !== this.sel.size || [...next].some((k) => !this.sel.has(k));
    this.sel = next;
    return changed;
  }

  private range(from: string, to: string): string[] {
    const a = this.pos.get(from) ?? 0;
    const b = this.pos.get(to) ?? 0;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return this.rows
      .slice(lo, hi + 1)
      .filter((r) => r.selectable)
      .map((r) => r.key);
  }

  /** A mouse click (or Space) on a row. Returns whether the selection changed. */
  click(key: string, mods: ClickMods = {}): boolean {
    if (!this.canSelect(key)) return false;
    this.focus = key;
    if (this.multi && mods.range && this.anchor !== null && this.pos.has(this.anchor)) {
      const span = this.range(this.anchor, key);
      return this.replace(mods.toggle ? [...this.sel, ...span] : span);
    }
    this.anchor = key;
    if (this.multi && mods.toggle) {
      const next = new Set(this.sel);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return this.replace(next);
    }
    return this.replace([key]);
  }

  /** Right-click: an unselected row becomes the selection; a selected one keeps the current selection. */
  contextClick(key: string): boolean {
    if (this.sel.has(key)) {
      this.focus = key;
      return false;
    }
    return this.click(key);
  }

  selectAll(): boolean {
    if (!this.multi) return false;
    return this.replace(this.rows.filter((r) => r.selectable).map((r) => r.key));
  }

  /** Keyboard movement. `extend` (Shift) grows the range from the anchor instead of moving the selection. */
  move(to: Move, extend = false): boolean {
    const target = this.target(to);
    if (target === null) return false;
    this.focus = target;
    if (extend && this.multi && this.anchor !== null) return this.replace(this.range(this.anchor, target));
    this.anchor = target;
    return this.replace([target]);
  }

  private target(to: Move): string | null {
    const selectable = (i: number) => !!this.rows[i]?.selectable;
    const scan = (start: number, dir: 1 | -1): number => {
      for (let i = start; i >= 0 && i < this.rows.length; i += dir) if (selectable(i)) return i;
      return -1;
    };
    const first = scan(0, 1);
    const last = scan(this.rows.length - 1, -1);
    const cur = this.focus === null ? -1 : (this.pos.get(this.focus) ?? -1);
    let i: number;
    if (to === "first") i = first;
    else if (to === "last") i = last;
    else if (cur < 0) i = to === "prev" || (typeof to === "object" && to.page < 0) ? last : first;
    else {
      const delta = to === "next" ? 1 : to === "prev" ? -1 : to.page;
      const dir: 1 | -1 = delta < 0 ? -1 : 1;
      const want = Math.max(0, Math.min(this.rows.length - 1, cur + delta));
      // land on a selectable row in the direction of travel, else the nearest one back towards the start
      i = scan(want, dir);
      if (i < 0) i = scan(want, dir === 1 ? -1 : 1);
    }
    return i < 0 ? null : (this.rows[i]?.key ?? null);
  }

  set(keys: string[]): boolean {
    const changed = this.replace(keys);
    this.focus = this.anchor = this.selected[0] ?? null;
    return changed;
  }

  clear(): boolean {
    this.focus = this.anchor = null;
    return this.replace([]);
  }
}

// ---------- the list view ----------

export interface RowState {
  index: number;
  selected: boolean;
  focused: boolean;
}

export interface ListOptions<T> {
  /** Accessible name. */
  label: string;
  role?: "listbox" | "tree" | "grid";
  key(row: T): string;
  /** Row height in px (rows may differ). */
  height(row: T): number;
  selectable?(row: T): boolean;
  multi?: boolean;
  /** Builds a row element's fixed structure; update() fills it. */
  create(row: T): HTMLElement;
  update(el: HTMLElement, row: T, state: RowState): void;
  /** Extra px rendered above and below the visible area. Default 240. */
  overscan?: number;
  onSelectionChange?(keys: string[]): void;
  /** Enter or double-click. */
  onActivate?(row: T, e: Event): void;
  onContextMenu?(row: T, e: MouseEvent): void;
}

export interface List<T> {
  /** The scroll container; give it a size with CSS. */
  el: HTMLElement;
  selection: SelectionModel;
  setRows(rows: T[]): void;
  rows(): readonly T[];
  /** Replaces the selection by key (does not call onSelectionChange). */
  select(keys: string[]): void;
  scrollToKey(key: string): void;
  /** Re-runs update() for the rendered rows (e.g. a clock tick changed their text). */
  refresh(): void;
  focus(): void;
}

let listSeq = 0;

export function createList<T>(opts: ListOptions<T>): List<T> {
  const id = `list-${++listSeq}`;
  const role = opts.role ?? "listbox";
  const itemRole = role === "tree" ? "treeitem" : role === "grid" ? "row" : "option";
  const multi = opts.multi ?? false;
  const overscan = opts.overscan ?? 240;
  const selection = new SelectionModel(multi);
  const inner = h("div", { class: "list-inner" });
  const el = h(
    "div",
    {
      class: "list",
      tabIndex: 0,
      attrs: { role, "aria-label": opts.label, "aria-multiselectable": multi ? "true" : false },
    },
    inner,
  );

  let rows: T[] = [];
  let keys: string[] = [];
  let tops: number[] = [];
  let total = 0;
  const rendered = new Map<string, HTMLElement>();
  let rowSeq = 0;

  function layout() {
    keys = rows.map(opts.key);
    tops = [];
    total = 0;
    for (const r of rows) {
      tops.push(total);
      total += opts.height(r);
    }
    inner.style.height = `${total}px`;
  }

  /** First row whose bottom is below y. */
  function indexAt(y: number): number {
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tops[mid] ?? 0) + opts.height(rows[mid] as T) <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function render() {
    const top = el.scrollTop - overscan;
    const bottom = el.scrollTop + el.clientHeight + overscan;
    const live = new Set<string>();
    for (let i = rows.length ? indexAt(Math.max(0, top)) : 0; i < rows.length && (tops[i] ?? 0) < bottom; i++) {
      const row = rows[i] as T;
      const k = keys[i] as string;
      live.add(k);
      let node = rendered.get(k);
      if (!node) {
        node = opts.create(row);
        node.classList.add("list-row");
        node.id = `${id}-r${++rowSeq}`;
        node.setAttribute("role", itemRole);
        node.dataset.key = k;
        rendered.set(k, node);
        inner.append(node);
      }
      node.style.transform = `translateY(${tops[i]}px)`;
      node.style.height = `${opts.height(row)}px`;
      const selectable = opts.selectable?.(row) ?? true;
      const state = { index: i, selected: selection.isSelected(k), focused: selection.focus === k };
      node.setAttribute("aria-selected", selectable ? String(state.selected) : "false");
      node.setAttribute("aria-posinset", String(i + 1));
      node.setAttribute("aria-setsize", String(rows.length));
      node.classList.toggle("selected", state.selected);
      node.classList.toggle("focused", state.focused);
      opts.update(node, row, state);
    }
    for (const [k, node] of rendered) {
      if (live.has(k)) continue;
      node.remove();
      rendered.delete(k);
    }
    const focusNode = selection.focus ? rendered.get(selection.focus) : undefined;
    if (focusNode) el.setAttribute("aria-activedescendant", focusNode.id);
    else el.removeAttribute("aria-activedescendant");
  }

  let frame = 0;
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }
  };
  el.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(el);

  function ensureVisible(key: string) {
    const i = keys.indexOf(key);
    const row = rows[i];
    if (i < 0 || row === undefined) return;
    const t = tops[i] ?? 0;
    const b = t + opts.height(row);
    if (t < el.scrollTop) el.scrollTop = t;
    else if (b > el.scrollTop + el.clientHeight) el.scrollTop = b - el.clientHeight;
  }

  function changed(didChange: boolean, reveal = true) {
    if (reveal && selection.focus) ensureVisible(selection.focus);
    render();
    if (didChange) opts.onSelectionChange?.(selection.selected);
  }

  const rowOf = (target: EventTarget | null): T | undefined => {
    const node = (target as Element | null)?.closest<HTMLElement>(".list-row");
    const i = node?.dataset.key === undefined ? -1 : keys.indexOf(node.dataset.key);
    return rows[i];
  };
  const toggleMod = (e: MouseEvent | KeyboardEvent) => (isMac() ? e.metaKey : e.ctrlKey);

  el.addEventListener("mousedown", (e) => {
    const row = rowOf(e.target);
    if (!row || e.button !== 0) return;
    changed(selection.click(opts.key(row), { toggle: toggleMod(e), range: e.shiftKey }), false);
  });
  el.addEventListener("dblclick", (e) => {
    const row = rowOf(e.target);
    if (row) opts.onActivate?.(row, e);
  });
  el.addEventListener("contextmenu", (e) => {
    const row = rowOf(e.target);
    if (!row) return;
    e.preventDefault();
    changed(selection.contextClick(opts.key(row)), false);
    opts.onContextMenu?.(row, e);
  });
  el.addEventListener("keydown", (e) => {
    const avg = rows.length ? total / rows.length : 30;
    const page = Math.max(1, Math.floor(el.clientHeight / avg) - 1);
    let moved: boolean | null = null;
    switch (e.key) {
      case "ArrowDown":
        moved = selection.move("next", e.shiftKey);
        break;
      case "ArrowUp":
        moved = selection.move("prev", e.shiftKey);
        break;
      case "Home":
        moved = selection.move("first", e.shiftKey);
        break;
      case "End":
        moved = selection.move("last", e.shiftKey);
        break;
      case "PageDown":
        moved = selection.move({ page }, e.shiftKey);
        break;
      case "PageUp":
        moved = selection.move({ page: -page }, e.shiftKey);
        break;
      case "Enter": {
        const row = rows[keys.indexOf(selection.focus ?? "")];
        if (row !== undefined) opts.onActivate?.(row, e);
        e.preventDefault();
        return;
      }
      default:
        if (e.key.toLowerCase() === "a" && toggleMod(e) && !e.altKey && multi) moved = selection.selectAll();
    }
    if (moved === null) return;
    e.preventDefault();
    changed(moved);
  });

  return {
    el,
    selection,
    setRows(next) {
      rows = next;
      layout();
      const didChange = selection.setRows(
        rows.map((r) => ({ key: opts.key(r), selectable: opts.selectable?.(r) ?? true })),
      );
      changed(didChange, false);
    },
    rows: () => rows,
    select(next) {
      selection.set(next);
      changed(false);
    },
    scrollToKey: ensureVisible,
    refresh: render,
    focus: () => el.focus({ preventScroll: true }),
  };
}
