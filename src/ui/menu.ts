// Context and dropdown menus: icon column, checkmarks, right-aligned shortcut (per-OS labels), submenus,
// separators, red danger items, disabled section labels. Keyboard: Up/Down, Home/End, Enter/Space, Esc,
// Right opens a submenu, Left closes it. Closes on a click outside, window blur or resize.
//
//   showMenu([{ label: "Copy path", icon: "folder", run: copy }, { kind: "separator" },
//             { label: "Close terminal", danger: true, shortcut: "CmdOrCtrl+W", run: close }],
//            { at: { x: e.clientX, y: e.clientY } });

import { h } from "../core/dom";
import { type IconSpec, iconNode, icons } from "../core/icons";
import { shortcutLabel } from "../core/platform";
import "./menu.css";

export interface MenuAction {
  kind?: "item";
  label: string;
  icon?: IconSpec;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Key binding in keyboard-registry syntax ("CmdOrCtrl+W"), shown in this OS's notation. */
  shortcut?: string;
  /** Muted text in the shortcut column (e.g. a terminal's folder). */
  detail?: string;
  run?: () => void;
  submenu?: MenuItem[];
}
export type MenuItem = MenuAction | { kind: "separator" } | { kind: "section"; label: string };

export type MenuPosition = { x: number; y: number } | { anchor: HTMLElement; align?: "start" | "end" };

export interface MenuOptions {
  at: MenuPosition;
  /** Accessible name. */
  label?: string;
}

export function isActionable(item: MenuItem | undefined): item is MenuAction {
  return !!item && (item.kind === undefined || item.kind === "item") && !item.disabled;
}

/** Next actionable index from `from` going `delta` (±1), wrapping around; -1 when nothing is actionable. */
export function nextIndex(items: readonly MenuItem[], from: number, delta: 1 | -1): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + delta * step) % n) + n) % n;
    if (isActionable(items[i])) return i;
  }
  return -1;
}

export function firstIndex(items: readonly MenuItem[]): number {
  return nextIndex(items, -1, 1);
}

export function lastIndex(items: readonly MenuItem[]): number {
  return nextIndex(items, items.length, -1);
}

const MARGIN = 4;

/** Keeps a w×h box at (x, y) inside the window; a box that would run off the bottom opens upward from `flipY`. */
export function clampToWindow(x: number, y: number, w: number, hgt: number, flipY = y): { x: number; y: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cx = Math.max(MARGIN, Math.min(x, vw - w - MARGIN));
  const cy = y + hgt <= vh - MARGIN ? y : Math.max(MARGIN, Math.min(flipY - hgt, vh - hgt - MARGIN));
  return { x: cx, y: cy };
}

let idSeq = 0;

class Level {
  readonly el: HTMLElement;
  private rows: Array<HTMLElement | null> = [];
  active = -1;
  child: Level | null = null;

  constructor(
    readonly items: MenuItem[],
    private readonly root: MenuSession,
    readonly parent: Level | null,
    label?: string,
  ) {
    this.el = h("div", { class: "menu", tabIndex: -1, attrs: { role: "menu", "aria-label": label ?? "" } });
    items.forEach((item, i) => {
      this.rows.push(this.renderItem(item, i));
    });
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("pointerleave", () => {
      if (!this.child) this.setActive(-1);
    });
  }

  private renderItem(item: MenuItem, i: number): HTMLElement | null {
    if (item.kind === "separator") {
      this.el.append(h("div", { class: "menu-sep", attrs: { role: "separator" } }));
      return null;
    }
    if (item.kind === "section") {
      this.el.append(h("div", { class: "menu-section", attrs: { role: "presentation" } }, item.label));
      return null;
    }
    const row = h("div", {
      class: `menu-item${item.danger ? " danger" : ""}${item.disabled ? " disabled" : ""}`,
      id: `menu-item-${++idSeq}`,
      attrs: {
        role: item.checked === undefined ? "menuitem" : "menuitemcheckbox",
        "aria-disabled": item.disabled ? "true" : false,
        "aria-checked": item.checked === undefined ? false : String(item.checked),
        "aria-haspopup": item.submenu ? "menu" : false,
      },
    });
    const iconCell = h("span", { class: "mi-icon" });
    if (item.checked) iconCell.innerHTML = icons.check;
    else if (item.icon) iconCell.append(iconNode(item.icon));
    const side = h("span", { class: "mi-side" });
    if (item.submenu) side.innerHTML = icons.chevron;
    else if (item.shortcut) side.textContent = shortcutLabel(item.shortcut);
    else if (item.detail) side.textContent = item.detail;
    row.append(iconCell, h("span", { class: "mi-label" }, item.label), side);
    row.addEventListener("pointerenter", () => {
      this.setActive(i);
      if (item.submenu && !item.disabled) this.openChild(false);
      else this.closeChild();
    });
    row.addEventListener("click", () => this.activate(i));
    this.el.append(row);
    return row;
  }

  setActive(i: number) {
    this.rows[this.active]?.classList.remove("active");
    this.active = i;
    const row = this.rows[i];
    if (row) {
      row.classList.add("active");
      row.scrollIntoView({ block: "nearest" });
      this.el.setAttribute("aria-activedescendant", row.id);
    } else this.el.removeAttribute("aria-activedescendant");
  }

  activate(i: number) {
    const item = this.items[i];
    if (!isActionable(item)) return;
    if (item.submenu) {
      this.setActive(i);
      this.openChild(true);
      return;
    }
    this.root.choose(item);
  }

  openChild(focus: boolean) {
    const item = this.items[this.active];
    const row = this.rows[this.active];
    if (!isActionable(item) || !item.submenu || !row) return;
    if (this.child?.items !== item.submenu) {
      this.closeChild();
      this.child = new Level(item.submenu, this.root, this, item.label);
      this.root.mount(this.child, row);
    }
    if (focus) {
      this.child.setActive(firstIndex(this.child.items));
      this.child.el.focus();
    }
  }

  closeChild() {
    if (!this.child) return;
    this.child.closeChild();
    this.child.el.remove();
    this.child = null;
  }

  private onKey(e: KeyboardEvent) {
    const items = this.items;
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        this.setActive(nextIndex(items, this.active, 1));
        break;
      case "ArrowUp":
        this.setActive(nextIndex(items, this.active < 0 ? items.length : this.active, -1));
        break;
      case "Home":
        this.setActive(firstIndex(items));
        break;
      case "End":
        this.setActive(lastIndex(items));
        break;
      case "Enter":
      case " ":
        this.activate(this.active);
        break;
      case "ArrowRight":
        this.openChild(true);
        break;
      case "ArrowLeft":
      case "Escape":
        if (this.parent) {
          this.parent.closeChild();
          this.parent.el.focus();
        } else if (e.key === "Escape") this.root.close();
        break;
      case "Tab":
        this.root.close();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}

class MenuSession {
  readonly top: Level;
  private readonly restoreFocus: Element | null = document.activeElement;
  private chosen: MenuAction | null = null;
  private resolve: (ran: boolean) => void = () => {};
  readonly done = new Promise<boolean>((r) => {
    this.resolve = r;
  });
  private readonly cleanup: Array<() => void> = [];

  constructor(items: MenuItem[], opts: MenuOptions) {
    this.top = new Level(items, this, null, opts.label);
    this.mountTop(opts.at);
    const anchor = "anchor" in opts.at ? opts.at.anchor : null;
    const outside = (e: Event) => {
      if (e.target instanceof Node && this.contains(e.target)) return;
      this.close();
      // a press on the button that opened it closes it, like a toggle: its click must not open it again
      if (e.type === "pointerdown" && anchor && e.target instanceof Node && anchor.contains(e.target))
        swallowClick(anchor);
    };
    const listen = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = true) => {
      window.addEventListener(type, fn, capture);
      this.cleanup.push(() => window.removeEventListener(type, fn, capture));
    };
    listen("pointerdown", outside);
    listen("blur", () => this.close(), false);
    listen("resize", () => this.close(), false);
    listen("wheel", outside);
    // opened from a button (often by keyboard): start on the first item; at the pointer: nothing active
    this.top.setActive("anchor" in opts.at ? firstIndex(items) : -1);
    this.top.el.focus();
  }

  private contains(node: Node): boolean {
    for (let l: Level | null = this.top; l; l = l.child) if (l.el.contains(node)) return true;
    return false;
  }

  private overlay(): HTMLElement {
    return document.getElementById("overlay-root") ?? document.body;
  }

  private mountTop(at: MenuPosition) {
    const el = this.top.el;
    this.overlay().append(el);
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let pos: { x: number; y: number };
    if ("anchor" in at) {
      const r = at.anchor.getBoundingClientRect();
      const x = at.align === "end" ? r.right - w : r.left;
      pos = clampToWindow(x, r.bottom + 4, w, hgt, r.top - 4);
    } else pos = clampToWindow(at.x, at.y, w, hgt);
    el.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
  }

  /** Places a submenu beside its row: to the right, or to the left when the right side has no room. */
  mount(level: Level, row: HTMLElement) {
    const el = level.el;
    this.overlay().append(el);
    const r = row.getBoundingClientRect();
    const w = el.offsetWidth;
    const right = r.right + 2;
    const x = right + w <= window.innerWidth - MARGIN ? right : r.left - 2 - w;
    const pos = clampToWindow(x, r.top - 5, w, el.offsetHeight, r.bottom + 5);
    el.style.transform = `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px)`;
  }

  choose(item: MenuAction) {
    this.chosen = item;
    this.close();
  }

  close() {
    if (current !== this) return;
    current = null;
    for (const fn of this.cleanup) fn();
    this.top.closeChild();
    this.top.el.remove();
    if (this.restoreFocus instanceof HTMLElement) this.restoreFocus.focus({ preventScroll: true });
    // the action runs after the menu is gone, so a dialog it opens gets focus back to the right place
    this.chosen?.run?.();
    this.resolve(this.chosen !== null);
  }
}

/** Drops the next click on `el` (the one finishing a press that closed its menu); gone after a second anyway. */
function swallowClick(el: HTMLElement) {
  const drop = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !el.contains(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", drop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", drop, true), 1000);
}

let current: MenuSession | null = null;

/** Opens a menu (closing any other). Resolves when it closes: true when an item was chosen. */
export function showMenu(items: MenuItem[], opts: MenuOptions): Promise<boolean> {
  current?.close();
  const session = new MenuSession(items, opts);
  current = session;
  return session.done;
}

export function closeMenus(): void {
  current?.close();
}
