// The tab strip (the Windows app's TabStrip): a pinned Home tab, then terminal tabs that share the width
// (150-250 px, never under 110), a gliding pill behind the active tab, move-to-new-window and close buttons
// on the hovered and the active tab, and a "more" button listing every tab when they do not all fit (the
// active tab is always shown). Middle-click closes a tab; right-click opens its menu. Dragging a tab moves
// it along the strip; dragging it well away from the strip moves it to another window (the one it is
// dropped on, else a new one), like a browser tab.
//
// Tabs of one folder sit together (terminals/index.ts keeps them so). From two tabs on, a folder gets a chip
// with its name in front of its tabs and a colour line under them (each open folder its own colour), like a
// browser tab group; pressing the chip folds its tabs away (a tab of a folded folder that comes to the front
// unfolds it).
//
// Everything clickable is a button or has role="tab": the strip is a window drag region (README).

import { $, h, html, setHtml } from "../../core/dom";
import { leaf, plural } from "../../core/format";
import { icon, iconNode } from "../../core/icons";
import { animate, reduceMotion, Spring } from "../../core/motion";
import { showMenu } from "../../ui/menu";
import { assignColors, GROUP_COLORS, layoutTabs, TAB_GAP } from "./logic";

export interface StripTab {
  id: number;
  title: string;
  sub: string;
  exited: boolean;
  /** The tab's folder. */
  dir: string;
  /** Its folder as compared (paths.ts pathKey): tabs with the same key form a group. */
  group: string;
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
  /**
   * Dragged off the strip with the pointer at screen point `at` (null: the drag ended). Resolves with the
   * number of the window a drop there goes to, null for a new window.
   */
  dragOver(id: number, at: { x: number; y: number } | null): Promise<number | null>;
  menu(id: number, at: { x: number; y: number }): void;
}

/** Extra space after the pinned Home tab. */
const HOME_GAP = 10;
/** Pointer travel before a press on a tab becomes a drag. */
const DRAG_START = 6;
/** How far above or below the strip a dragged tab must go to leave it (for another window). */
const TEAR_DISTANCE = 48;
/** While a torn-off tab rests over another window, its place there is sent again this often (the other
 * window drops its placeholder when it stops hearing about it). */
const PROBE_KEEPALIVE_MS = 400;
/** How long tabs take to glide to new places. */
const SLIDE_MS = 220;
/** A folder chip's width for laying out the tabs (it is drawn at its own width, up to CHIP_MAX). */
const CHIP_MAX = 140;
const chipWidth = (name: string, folded: boolean) =>
  Math.min(CHIP_MAX, 30 + name.length * 7) + (folded ? 22 : 0) + TAB_GAP;

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
  /** Pointer screen point waiting to be sent to `dragOver` while one is under way. */
  probe: { x: number; y: number } | null;
  probing: boolean;
  keepAlive: ReturnType<typeof setTimeout> | undefined;
}

const signature = (tabs: readonly StripTab[]) =>
  tabs.map((t) => `${t.id}\u0000${t.title}\u0000${t.sub}\u0000${t.exited}\u0000${t.group}`).join("\u0001");

/** How many tabs each folder has. */
function groupSizes(tabs: readonly StripTab[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tabs) out.set(t.group, (out.get(t.group) ?? 0) + 1);
  return out;
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
  /** What the strip shows (ids, titles, subtitles, exited), to tell a change of the active tab alone. */
  private shownSig = "";
  private drag: Drag | null = null;
  /** The title of a tab from another window dragged over this one: a placeholder shows where it lands. */
  private incoming: string | null = null;
  /** The click that ends a drag is not a tab click. */
  private swallowClick = false;
  /** Folders whose tabs are folded away behind their chip. */
  private folded = new Set<string>();
  /** Each folder group's colour (index into GROUP_COLORS), kept while it is open. */
  private colors = new Map<string, number>();

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
    if (this.switchActive(tabs, active)) return;
    const from = this.lefts();
    this.endDrag();
    this.tabs = tabs;
    this.active = active;
    this.slot.hidden = tabs.length === 0 && this.incoming === null;
    document.documentElement.classList.toggle("has-tabs", tabs.length > 0);
    if (!tabs.length) {
      this.pillShown = false;
      this.seen.clear();
      this.lastLayout = "";
      this.shownSig = "";
      setHtml(this.list, html``);
      this.placeIncoming();
      return;
    }
    const sizes = groupSizes(tabs);
    const grouped = (t: StripTab) => (sizes.get(t.group) ?? 0) > 1;
    // a tab that comes to the front unfolds its folder; folders that are gone are forgotten
    const front = tabs.find((t) => t.id === active);
    if (front) this.folded.delete(front.group);
    for (const g of this.folded) if ((sizes.get(g) ?? 0) < 2) this.folded.delete(g);
    const visible = tabs.filter((t) => !(grouped(t) && this.folded.has(t.group)));
    const chips = [...new Set(tabs.filter(grouped).map((t) => t.group))];
    const name = (g: string) => leaf(tabs.find((t) => t.group === g)?.dir ?? "");
    const chipsW = chips.reduce((w, g) => w + chipWidth(name(g), this.folded.has(g)), 0);
    const activeIndex = visible.findIndex((t) => t.id === active);
    const homeW = this.homeWidth();
    const avail = this.root.clientWidth - homeW - HOME_GAP - TAB_GAP - chipsW;
    const layout = layoutTabs(visible.length, activeIndex, avail);
    this.lastLayout = this.layoutKey();
    this.shownSig = signature(tabs);
    const shownIds = new Set(layout.shown.map((i) => visible[i]?.id));
    const shown = tabs.filter((t) => shownIds.has(t.id));
    const hidden = tabs.length - shown.length;
    // the strip in tab order: a folder's chip, then its tabs that are shown
    const items: Array<{ chip: string } | { tab: StripTab }> = [];
    let prev: string | null = null;
    for (const t of tabs) {
      if (grouped(t) && t.group !== prev) items.push({ chip: t.group });
      prev = t.group;
      if (shownIds.has(t.id)) items.push({ tab: t });
    }
    this.colors = assignColors(chips, this.colors);
    const color = (g: string) => `--group:var(${GROUP_COLORS[this.colors.get(g) ?? 0]})`;
    const chipHtml = (g: string) => {
      const folded = this.folded.has(g);
      const n = sizes.get(g) ?? 0;
      const dir = tabs.find((t) => t.group === g)?.dir ?? "";
      return html`<button class="term-group${folded ? " folded" : ""}" type="button" data-group="${g}" style="${color(g)}" aria-expanded="${String(!folded)}" aria-label="${`${name(g)}, ${n} terminals. ${folded ? "Show" : "Fold"} them`}" data-tip="${`${dir}\n${folded ? "Show" : "Fold"} ${n} terminals`}"><span class="term-group-name">${name(g)}</span>${folded ? html`<span class="term-group-count">${String(n)}</span>` : ""}</button>`;
    };
    const tabHtml = (
      t: StripTab,
    ) => html`<div class="term-tab${t.id === active ? " active" : ""}${t.exited ? " exited" : ""}${grouped(t) ? " grouped" : ""}" data-key="${t.id}" role="tab" tabindex="${t.id === active ? 0 : -1}" aria-selected="${String(t.id === active)}" style="width:${layout.width}px;${grouped(t) ? color(t.group) : ""}" data-tip="${t.sub ? `${t.title}\n${t.sub}` : t.title}">
          ${icon("terminal")}<span class="term-title">${t.title}</span><span class="term-sub">${t.sub}</span>
          <button class="term-btn" type="button" data-act="pop" aria-label="Move to new window" data-tip="Move to new window"${t.exited ? " disabled" : ""}>${icon("popout")}</button>
          <button class="term-btn" type="button" data-act="close" aria-label="Close terminal" data-tip="Close terminal">${icon("close")}</button>
        </div>`;
    setHtml(
      this.list,
      html`<div class="term-tab term-home${active === null ? " active" : ""}" data-key="0" role="tab" tabindex="${active === null ? 0 : -1}" aria-selected="${String(active === null)}">${icon("home")}<span class="term-title">Home</span></div>
      ${items.map((it) => ("chip" in it ? chipHtml(it.chip) : tabHtml(it.tab)))}
      ${layout.overflow ? html`<button class="term-more" type="button" aria-label="All open terminals" data-tip="All open terminals">${icon("chevronDown")}<span>${hidden}</span></button>` : ""}`,
    );
    for (const t of shown) {
      if (!this.seen.has(t.id)) this.enter(t.id);
    }
    this.seen = new Set(tabs.map((t) => t.id));
    this.placeIncoming();
    this.slide(from);
    this.placePill(true);
  }

  /**
   * Only another tab came to the front (same tabs, all shown, nothing dragged): moves the active marks and
   * the pill instead of drawing the strip again. False when the strip has to be drawn.
   */
  private switchActive(tabs: StripTab[], active: number | null): boolean {
    if (active === this.active || this.drag || !tabs.length || signature(tabs) !== this.shownSig) return false;
    if (this.folded.size) return false; // the tab coming forward may unfold its folder
    if (this.list.querySelector(".term-more")) return false; // which tabs are shown depends on the active one
    const prev = this.node(this.active ?? 0);
    const next = this.node(active ?? 0);
    if (!prev || !next) return false;
    for (const [node, on] of [
      [prev, false],
      [next, true],
    ] as const) {
      node.classList.toggle("active", on);
      node.setAttribute("aria-selected", String(on));
      node.tabIndex = on ? 0 : -1;
    }
    this.tabs = tabs;
    this.active = active;
    this.lastLayout = this.layoutKey();
    this.placePill(true);
    return true;
  }

  /** Changes one tab's title in place (claude animates its title; a full redraw per change is wasted). */
  setTitle(id: number, title: string): void {
    const t = this.tabs.find((x) => x.id === id);
    if (t) t.title = title;
    this.shownSig = signature(this.tabs);
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
      probe: null,
      probing: false,
      keepAlive: undefined,
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
    if (d.torn) {
      this.probeAt(d, { x: e.screenX, y: e.screenY });
      return;
    }
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
      ghost.append(h("span", { class: "term-ghost-dest" }, "New window"));
      document.body.append(ghost);
      d.ghost = ghost;
    } else if (!torn && d.ghost) {
      d.ghost.remove();
      d.ghost = null;
      clearTimeout(d.keepAlive);
      void this.h.dragOver(d.id, null);
    }
    this.shiftOthers(d, torn ? null : d.before);
  }

  /** A tab from another window is dragged over this one (its title), or left (null): its landing place. */
  setIncoming(title: string | null): void {
    if (title === this.incoming) return;
    this.incoming = title;
    if (!this.tabs.length) this.slot.hidden = title === null;
    this.placeIncoming();
  }

  /** The placeholder at the end of the strip, where a tab dropped from another window lands. */
  private placeIncoming() {
    const title = this.incoming;
    let node = this.list.querySelector<HTMLElement>(".term-incoming");
    if (title === null) {
      node?.remove();
      return;
    }
    if (!node) {
      const last = this.list.querySelector<HTMLElement>(".term-tab:not(.term-home):last-of-type");
      node = h(
        "div",
        { class: "term-tab term-incoming", attrs: { "aria-hidden": "true" } },
        iconNode("terminal"),
        h("span", { class: "term-title" }),
      );
      node.style.width = `${last?.offsetWidth || 180}px`;
      this.list.append(node);
    }
    $(".term-title", node).textContent = title;
  }

  /**
   * Tells the backend where the torn-off tab is, one call at a time (the latest point wins), and labels the
   * floating copy with where a drop would send it.
   */
  private probeAt(d: Drag, at: { x: number; y: number }) {
    clearTimeout(d.keepAlive);
    d.probe = at;
    if (d.probing) return;
    const next = d.probe;
    d.probe = null;
    d.probing = true;
    void this.h.dragOver(d.id, next).then((win) => {
      d.probing = false;
      if (this.drag !== d || !d.torn || d.released) {
        // the drag ended or came back while this was under way: the other window must not keep its hint
        void this.h.dragOver(d.id, null);
        return;
      }
      const dest = d.ghost?.querySelector(".term-ghost-dest");
      if (dest) dest.textContent = win === null ? "New window" : win === 1 ? "Main window" : `Window ${win}`;
      if (d.probe) this.probeAt(d, d.probe);
      else d.keepAlive = setTimeout(() => this.drag === d && d.torn && this.probeAt(d, next), PROBE_KEEPALIVE_MS);
    });
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
    clearTimeout(d.keepAlive);
    d.ghost?.remove();
    if (d.torn) void this.h.dragOver(d.id, null);
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
    // all reads first, then the writes, with one forced layout between (not one per tab)
    const moving: Array<{ n: HTMLElement; dx: number }> = [];
    for (const n of this.list.querySelectorAll<HTMLElement>(".term-tab:not(.term-home)")) {
      const was = from.get(Number(n.dataset.key));
      if (was === undefined) continue;
      const dx = was - n.getBoundingClientRect().left;
      if (Math.abs(dx) >= 1) moving.push({ n, dx });
    }
    if (!moving.length) return;
    for (const { n, dx } of moving) {
      n.style.transition = "none";
      n.style.transform = `translateX(${dx}px)`;
    }
    // the start positions must be applied before the transitions back to none begin
    void this.list.offsetWidth;
    for (const { n } of moving) {
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
    const chip = target.closest<HTMLElement>(".term-group");
    if (chip?.dataset.group !== undefined) {
      this.toggleGroup(chip.dataset.group);
      return;
    }
    const id = this.tabId(target);
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (id !== null && act === "close") return this.h.close(id);
    if (id !== null && act === "pop") return this.h.moveOut(id);
    if (target.closest(".term-tab")) this.h.select(id);
  }

  /**
   * Folds a folder's tabs away behind its chip, or shows them again. Folding the folder of the tab in front
   * brings the next tab outside it forward (else the one before it, else Home), as a browser does.
   */
  private toggleGroup(group: string) {
    if (this.folded.delete(group)) {
      this.render(this.tabs, this.active);
      this.list.querySelector<HTMLElement>(`.term-group[data-group="${CSS.escape(group)}"]`)?.focus();
      return;
    }
    this.folded.add(group);
    const i = this.tabs.findIndex((t) => t.id === this.active);
    if (i >= 0 && this.tabs[i]?.group === group) {
      const outside = (t: StripTab) => t.group !== group;
      const next = this.tabs.slice(i + 1).find(outside) ?? [...this.tabs.slice(0, i)].reverse().find(outside);
      this.h.select(next?.id ?? null);
    } else {
      // only the drawing changes: draw again even though the tabs are the same
      this.shownSig = "";
      this.render(this.tabs, this.active);
    }
    this.list.querySelector<HTMLElement>(`.term-group[data-group="${CSS.escape(group)}"]`)?.focus();
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
