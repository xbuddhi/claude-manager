// The tab strip (the Windows app's TabStrip): a pinned Home tab, then terminal tabs that share the width
// (150-250 px, never under 110), a gliding pill behind the active tab, move-to-new-window and close buttons
// on the hovered and the active tab, and a "more" button listing every tab when they do not all fit (the
// active tab is always shown). Middle-click closes a tab; right-click opens its menu. Dragging a tab moves
// it along the strip; dragging it well away from the strip moves it to another window (the one it is
// dropped on, else a new one), like a browser tab.
//
// Everything clickable is a button or has role="tab": the strip is a window drag region (README).

import { html, setHtml } from "../../core/dom";
import { plural } from "../../core/format";
import { icon } from "../../core/icons";
import { animate, reduceMotion, Spring } from "../../core/motion";
import { showMenu } from "../../ui/menu";
import { layoutTabs, TAB_GAP } from "./logic";

export interface StripTab {
  id: number;
  title: string;
  sub: string;
  exited: boolean;
}

export interface StripHandlers {
  /** null = Home. */
  select(id: number | null): void;
  close(id: number): void;
  /** To a new window. */
  moveOut(id: number): void;
  /** Dragged along the strip: put it before tab `before` (null = at the end). */
  reorder(id: number, before: number | null): void;
  /** Dragged off the strip and dropped at screen point `at` (CSS screen pixels). */
  tearOff(id: number, at: { x: number; y: number }): Promise<unknown> | undefined;
  menu(id: number, at: { x: number; y: number }): void;
}

/** Extra space after the pinned Home tab. */
const HOME_GAP = 10;
/** Pointer travel before a press on a tab becomes a drag. */
const DRAG_START = 6;
/** How far above or below the strip a dragged tab must go to leave it (for another window). */
const TEAR_DISTANCE = 48;
/** How long tabs take to glide to new places. */
const SLIDE_MS = 220;

interface Drag {
  id: number;
  pointer: number;
  node: HTMLElement;
  startX: number;
  startY: number;
  /** Where in the tab it was grabbed. */
  grabX: number;
  grabY: number;
  dragging: boolean;
  /** Let go; waiting for the tab to leave for another window. */
  released: boolean;
  /** Off the strip: dropping it moves the tab to another window. */
  torn: boolean;
  /** The floating copy that follows the pointer while it is off the strip. */
  ghost: HTMLElement | null;
  /** Left edges and widths of the shown tabs (ids in order) when the drag started. */
  slots: Array<{ id: number; left: number; width: number }>;
  /** Where it would land: before this tab id, null = at the end. */
  before: number | null;
}

export class Strip {
  private root: HTMLElement;
  private list: HTMLElement;
  private pill: HTMLElement;
  private tabs: StripTab[] = [];
  private active: number | null = null;
  private seen = new Set<number>();
  private pillX = new Spring(0.3, 0.86, 0.1);
  private pillW = new Spring(0.3, 0.9, 0.1);
  private pillShown = false;
  private lastLayout = "";
  private drag: Drag | null = null;
  /** The click that ends a drag is not a tab click. */
  private swallowClick = false;

  constructor(
    private slot: HTMLElement,
    private h: StripHandlers,
  ) {
    setHtml(
      slot,
      html`<div class="term-tabs"><div class="term-pill"></div><div class="term-tablist" role="tablist" aria-label="Terminals"></div></div>`,
    );
    this.root = slot.querySelector<HTMLElement>(".term-tabs") as HTMLElement;
    this.list = slot.querySelector<HTMLElement>(".term-tablist") as HTMLElement;
    this.pill = slot.querySelector<HTMLElement>(".term-pill") as HTMLElement;
    this.root.addEventListener("click", (e) => this.onClick(e));
    // middle button: no autoscroll, and close on release
    this.root.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.root.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const id = this.tabId(e.target);
      if (id !== null) this.h.close(id);
    });
    this.root.addEventListener("contextmenu", (e) => {
      const id = this.tabId(e.target);
      if (id === null) return;
      e.preventDefault();
      this.h.menu(id, { x: e.clientX, y: e.clientY });
    });
    this.root.addEventListener("keydown", (e) => this.onKey(e));
    this.root.addEventListener("pointerdown", (e) => this.onDown(e));
    this.root.addEventListener("pointermove", (e) => this.onMove(e));
    this.root.addEventListener("pointerup", (e) => this.onUp(e));
    // a drag let go off the strip ends when its tab has moved, not when the capture goes with the release
    const cancel = () => {
      if (!this.drag?.released) this.endDrag();
    };
    this.root.addEventListener("pointercancel", cancel);
    this.root.addEventListener("lostpointercapture", cancel);
    new ResizeObserver(() => {
      // a different width can change how many tabs fit
      if (this.layoutKey() !== this.lastLayout) this.render(this.tabs, this.active);
      else this.placePill(false);
    }).observe(this.root);
  }

  /** Redraws the strip; hidden while there are no terminals. */
  render(tabs: StripTab[], active: number | null): void {
    const from = this.lefts();
    this.endDrag();
    this.tabs = tabs;
    this.active = active;
    this.slot.hidden = tabs.length === 0;
    document.documentElement.classList.toggle("has-tabs", tabs.length > 0);
    if (!tabs.length) {
      this.pillShown = false;
      this.seen.clear();
      this.lastLayout = "";
      setHtml(this.list, html``);
      return;
    }
    const activeIndex = tabs.findIndex((t) => t.id === active);
    const homeW = this.homeWidth();
    const avail = this.root.clientWidth - homeW - HOME_GAP - TAB_GAP;
    const layout = layoutTabs(tabs.length, activeIndex, avail);
    this.lastLayout = this.layoutKey();
    const shown = layout.shown.map((i) => tabs[i]).filter((t): t is StripTab => !!t);
    const hidden = tabs.length - shown.length;
    setHtml(
      this.list,
      html`<div class="term-tab term-home${active === null ? " active" : ""}" data-key="0" role="tab" tabindex="${active === null ? 0 : -1}" aria-selected="${String(active === null)}">${icon("home")}<span class="term-title">Home</span></div>
      ${shown.map(
        (
          t,
        ) => html`<div class="term-tab${t.id === active ? " active" : ""}${t.exited ? " exited" : ""}" data-key="${t.id}" role="tab" tabindex="${t.id === active ? 0 : -1}" aria-selected="${String(t.id === active)}" style="width:${layout.width}px" data-tip="${t.sub ? `${t.title}\n${t.sub}` : t.title}">
          ${icon("terminal")}<span class="term-title">${t.title}</span><span class="term-sub">${t.sub}</span>
          <button class="term-btn" type="button" data-act="pop" aria-label="Move to new window" data-tip="Move to new window"${t.exited ? " disabled" : ""}>${icon("popout")}</button>
          <button class="term-btn" type="button" data-act="close" aria-label="Close terminal" data-tip="Close terminal">${icon("close")}</button>
        </div>`,
      )}
      ${layout.overflow ? html`<button class="term-more" type="button" aria-label="All open terminals" data-tip="All open terminals">${icon("chevronDown")}<span>${hidden}</span></button>` : ""}`,
    );
    for (const t of shown) {
      if (!this.seen.has(t.id)) this.enter(t.id);
    }
    this.seen = new Set(tabs.map((t) => t.id));
    this.slide(from);
    this.placePill(true);
  }

  /** Changes one tab's title in place (claude animates its title; a full redraw per change is wasted). */
  setTitle(id: number, title: string): void {
    const t = this.tabs.find((x) => x.id === id);
    if (t) t.title = title;
    const node = this.node(id);
    if (!node) return;
    const label = node.querySelector(".term-title");
    if (label) label.textContent = title;
    node.dataset.tip = t?.sub ? `${title}\n${t.sub}` : title;
  }

  private layoutKey(): string {
    return `${this.root.clientWidth}:${this.tabs.length}:${this.active}`;
  }

  private homeWidth(): number {
    // 0 when the Home tab is hidden (docked style)
    return this.node(0)?.offsetWidth ?? 96;
  }

  private node(id: number): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.term-tab[data-key="${id}"]`);
  }

  private tabId(target: EventTarget | null): number | null {
    const key = (target as Element | null)?.closest<HTMLElement>(".term-tab")?.dataset.key;
    return key === undefined || key === "0" ? null : Number(key);
  }

  private placePill(animated: boolean) {
    const cur = this.node(this.active ?? 0) ?? this.node(0);
    if (!cur) return;
    const x = cur.offsetLeft;
    const w = cur.offsetWidth;
    this.pill.classList.toggle("at-start", x < 1);
    // the panel under a tab at the left edge loses its rounded corner there, so the two join
    document.documentElement.classList.toggle("tab-at-start", x < 1);
    const draw = () => {
      this.pill.style.transform = `translateX(${this.pillX.value}px)`;
      this.pill.style.width = `${this.pillW.value}px`;
    };
    if (!this.pillShown || !animated) {
      this.pillX.snap(x);
      this.pillW.snap(w);
      draw();
      this.pillShown = true;
      return;
    }
    animate(this.pillX, x, draw);
    animate(this.pillW, w, draw);
  }

  /** A new tab fades and scales in. */
  private enter(id: number) {
    const s = new Spring(0.32, 0.78, 0.002);
    const style = (v: number) => {
      const node = this.node(id);
      if (!node) return;
      node.style.opacity = String(Math.min(1, v));
      node.style.transform = v >= 1 ? "" : `scale(${0.88 + 0.12 * v})`;
    };
    style(0);
    animate(s, 1, style, () => style(1));
  }

  // ---- dragging ----

  private onDown(e: PointerEvent) {
    if (e.button !== 0 || this.drag) return;
    const target = e.target as Element;
    if (target.closest("[data-act]")) return;
    const id = this.tabId(target);
    const node = id === null ? null : this.node(id);
    if (id === null || !node) return;
    const r = node.getBoundingClientRect();
    this.drag = {
      id,
      pointer: e.pointerId,
      node,
      startX: e.clientX,
      startY: e.clientY,
      grabX: e.clientX - r.left,
      grabY: e.clientY - r.top,
      dragging: false,
      released: false,
      torn: false,
      ghost: null,
      slots: [],
      before: null,
    };
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.released || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.dragging) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      d.dragging = true;
      // keeps the moves (also outside the window) and the release coming here
      try {
        this.root.setPointerCapture(e.pointerId);
      } catch {
        // a pointer that is already gone: the drag ends with it
      }
      d.slots = [...this.list.querySelectorAll<HTMLElement>(".term-tab:not(.term-home)")].map((n) => ({
        id: Number(n.dataset.key),
        left: n.offsetLeft,
        width: n.offsetWidth,
      }));
      d.node.classList.add("dragging");
      this.root.classList.add("dragging-tab");
      for (const s of d.slots) if (s.id !== d.id) this.node(s.id)?.classList.add("making-room");
    }
    const strip = this.root.getBoundingClientRect();
    const off =
      e.clientY < strip.top - TEAR_DISTANCE ||
      e.clientY > strip.bottom + TEAR_DISTANCE ||
      e.clientX < 0 ||
      e.clientX > window.innerWidth;
    // only a tab that can move (a running terminal) leaves the strip
    const torn = off && !this.tabs.find((t) => t.id === d.id)?.exited;
    if (torn !== d.torn) this.setTorn(d, torn);
    if (d.ghost) {
      // the strip clips what leaves it: a floating copy follows the pointer instead
      d.ghost.style.transform = `translate(${e.clientX - d.grabX}px, ${e.clientY - d.grabY}px)`;
    }
    if (d.torn) return;
    // along the strip: kept inside it, the others make room
    const me = d.slots.find((s) => s.id === d.id);
    if (!me) return;
    const first = d.slots[0];
    const last = d.slots[d.slots.length - 1];
    const min = (first?.left ?? me.left) - me.left;
    const max = (last ? last.left + last.width : me.left + me.width) - (me.left + me.width);
    const x = Math.max(min, Math.min(max, dx));
    d.node.style.transform = `translateX(${x}px)`;
    if (d.id === this.active) this.pillAt(me.left + x, false);
    const center = me.left + x + me.width / 2;
    const others = d.slots.filter((s) => s.id !== d.id);
    const next = others.find((s) => center < s.left + s.width / 2);
    this.shiftOthers(d, next?.id ?? null);
  }

  /** Off the strip (a floating copy follows the pointer, the gap closes) or back on it. */
  private setTorn(d: Drag, torn: boolean) {
    d.torn = torn;
    d.node.classList.toggle("torn", torn);
    this.root.classList.toggle("tearing-active", torn && d.id === this.active);
    if (torn && !d.ghost) {
      const ghost = d.node.cloneNode(true) as HTMLElement;
      ghost.className = "term-tab term-ghost";
      ghost.removeAttribute("data-key");
      ghost.removeAttribute("data-tip");
      ghost.style.width = `${d.node.offsetWidth}px`;
      ghost.style.transform = "";
      document.body.append(ghost);
      d.ghost = ghost;
    } else if (!torn && d.ghost) {
      d.ghost.remove();
      d.ghost = null;
    }
    this.shiftOthers(d, torn ? null : d.before);
  }

  /**
   * Slides the other tabs to show where the dragged one lands (before tab `before`, null = at the end);
   * while it is off the strip, the tabs after it close its gap.
   */
  private shiftOthers(d: Drag, before: number | null) {
    d.before = before;
    const me = d.slots.findIndex((s) => s.id === d.id);
    const width = (d.slots[me]?.width ?? 0) + TAB_GAP;
    const others = d.slots.filter((s) => s.id !== d.id);
    const landing = d.torn ? others.length : before === null ? others.length : others.findIndex((s) => s.id === before);
    others.forEach((s, i) => {
      const node = this.node(s.id);
      if (!node) return;
      // index among the others vs. among all: tabs past the dragged one shift left, then back right
      const was = i >= me ? i + 1 : i;
      const now = i >= landing ? i + 1 : i;
      const shift = (d.torn ? i - was : now - was) * width;
      node.style.transform = shift ? `translateX(${shift}px)` : "";
      if (s.id === this.active) this.pillAt(s.left + shift, true);
    });
  }

  /** Moves the pill under the active tab while it (or the tabs around it) slide during a drag. */
  private pillAt(x: number, animated: boolean) {
    const draw = () => {
      this.pill.style.transform = `translateX(${this.pillX.value}px)`;
    };
    if (animated) animate(this.pillX, x, draw);
    else {
      this.pillX.snap(x);
      draw();
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    if (!d || d.released || e.pointerId !== d.pointer) return;
    if (!d.dragging) {
      this.drag = null;
      return;
    }
    this.swallowClick = true;
    d.released = true;
    const { id, torn, before, ghost } = d;
    d.ghost = null;
    // nothing re-rendered (same place, or the move failed): the tabs slide back into place
    const settle = () => {
      if (this.drag !== d) return;
      const from = this.lefts();
      this.endDrag();
      this.slide(from);
      this.placePill(true);
    };
    if (torn) {
      // the strip stays as it is (gap closed, tab hidden) until the tab has gone to the other window
      this.dropGhost(ghost);
      if (this.root.hasPointerCapture?.(d.pointer)) this.root.releasePointerCapture(d.pointer);
      void Promise.resolve(this.h.tearOff(id, { x: e.screenX, y: e.screenY })).finally(settle);
      return;
    }
    ghost?.remove();
    this.h.reorder(id, before);
    settle();
  }

  /** The floating copy of a tab dropped off the strip shrinks and fades where it was let go. */
  private dropGhost(ghost: HTMLElement | null) {
    if (!ghost) return;
    if (reduceMotion.matches) {
      ghost.remove();
      return;
    }
    ghost.classList.add("dropped");
    const done = () => ghost.remove();
    ghost.addEventListener("transitionend", done, { once: true });
    setTimeout(done, 400);
  }

  private endDrag() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    d.ghost?.remove();
    if (this.root.hasPointerCapture?.(d.pointer)) this.root.releasePointerCapture(d.pointer);
    this.root.classList.remove("dragging-tab", "tearing-active");
    for (const n of this.list.querySelectorAll<HTMLElement>(".term-tab")) {
      n.classList.remove("dragging", "torn", "making-room");
      n.style.transform = "";
    }
  }

  /** Where each tab is on screen now (left edge, transforms included), by id. */
  private lefts(): Map<number, number> {
    const out = new Map<number, number>();
    for (const n of this.list.querySelectorAll<HTMLElement>(".term-tab:not(.term-home)")) {
      out.set(Number(n.dataset.key), n.getBoundingClientRect().left);
    }
    return out;
  }

  /** Tabs that were on screen at `from` glide to where they are now (a reorder, a close, a tab moved away). */
  private slide(from: Map<number, number>) {
    if (reduceMotion.matches || !from.size) return;
    for (const n of this.list.querySelectorAll<HTMLElement>(".term-tab:not(.term-home)")) {
      const was = from.get(Number(n.dataset.key));
      if (was === undefined) continue;
      const dx = was - n.getBoundingClientRect().left;
      if (Math.abs(dx) < 1) continue;
      n.style.transition = "none";
      n.style.transform = `translateX(${dx}px)`;
      // the start position must be painted before the transition back to none begins
      void n.offsetWidth;
      n.style.transition = `transform ${SLIDE_MS}ms var(--ease)`;
      n.style.transform = "";
      const clear = () => {
        n.style.transition = "";
      };
      n.addEventListener("transitionend", clear, { once: true });
      setTimeout(clear, SLIDE_MS + 60);
    }
  }

  private onClick(e: MouseEvent) {
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    const target = e.target as Element;
    if (target.closest(".term-more")) {
      this.showMore(target.closest<HTMLElement>(".term-more") as HTMLElement);
      return;
    }
    const id = this.tabId(target);
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (id !== null && act === "close") return this.h.close(id);
    if (id !== null && act === "pop") return this.h.moveOut(id);
    if (target.closest(".term-tab")) this.h.select(id);
  }

  private showMore(anchor: HTMLElement) {
    void showMenu(
      [
        { kind: "section", label: plural(this.tabs.length, "open terminal") },
        ...this.tabs.map((t) => ({
          label: t.title,
          icon: "terminal" as const,
          checked: t.id === this.active,
          detail: t.sub,
          run: () => this.h.select(t.id),
        })),
      ],
      { at: { anchor, align: "end" }, label: "Open terminals" },
    );
  }

  /** Left/Right move between tabs, Home/End to the ends; the tab comes to the front at once. */
  private onKey(e: KeyboardEvent) {
    if (!(e.target as Element).closest(".term-tab")) return;
    const order: Array<number | null> = [null, ...this.tabs.map((t) => t.id)];
    const i = order.indexOf(this.active);
    let next: number | null | undefined;
    if (e.key === "ArrowRight") next = order[(i + 1) % order.length];
    else if (e.key === "ArrowLeft") next = order[(i - 1 + order.length) % order.length];
    else if (e.key === "Home") next = order[0];
    else if (e.key === "End") next = order[order.length - 1];
    else if (e.key === "Delete" && this.active !== null) {
      e.preventDefault();
      this.h.close(this.active);
      return;
    } else return;
    e.preventDefault();
    if (next === undefined) return;
    this.h.select(next);
    this.node(next ?? 0)?.focus();
  }
}
