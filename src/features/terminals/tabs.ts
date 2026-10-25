// The tab strip (the Windows app's TabStrip): a pinned Home tab, then terminal tabs that share the width
// (150-250 px, never under 110), a gliding pill behind the active tab, pop-out and close buttons on the
// hovered and the active tab, and a "more" button listing every tab when they do not all fit (the active
// tab is always shown). Middle-click closes a tab; right-click opens its menu.
//
// Everything clickable is a button or has role="tab": the strip is a window drag region (README).

import { html, setHtml } from "../../core/dom";
import { plural } from "../../core/format";
import { icon } from "../../core/icons";
import { animate, Spring } from "../../core/motion";
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
  popOut(id: number): void;
  menu(id: number, at: { x: number; y: number }): void;
}

/** Extra space after the pinned Home tab. */
const HOME_GAP = 10;

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
    new ResizeObserver(() => {
      // a different width can change how many tabs fit
      if (this.layoutKey() !== this.lastLayout) this.render(this.tabs, this.active);
      else this.placePill(false);
    }).observe(this.root);
  }

  /** Redraws the strip; hidden while there are no terminals. */
  render(tabs: StripTab[], active: number | null): void {
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
          <button class="term-btn" type="button" data-act="pop" aria-label="Pop out" data-tip="Pop out to its own window"${t.exited ? " disabled" : ""}>${icon("popout")}</button>
          <button class="term-btn" type="button" data-act="close" aria-label="Close terminal" data-tip="Close terminal">${icon("close")}</button>
        </div>`,
      )}
      ${layout.overflow ? html`<button class="term-more" type="button" aria-label="All open terminals" data-tip="All open terminals">${icon("chevronDown")}<span>${hidden}</span></button>` : ""}`,
    );
    for (const t of shown) {
      if (!this.seen.has(t.id)) this.enter(t.id);
    }
    this.seen = new Set(tabs.map((t) => t.id));
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
    return this.node(0)?.offsetWidth || 96;
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

  private onClick(e: MouseEvent) {
    const target = e.target as Element;
    if (target.closest(".term-more")) {
      this.showMore(target.closest<HTMLElement>(".term-more") as HTMLElement);
      return;
    }
    const id = this.tabId(target);
    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (id !== null && act === "close") return this.h.close(id);
    if (id !== null && act === "pop") return this.h.popOut(id);
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
