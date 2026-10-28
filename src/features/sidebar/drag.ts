// Dragging folder rows onto a project or onto the FOLDERS heading, with pointer events (the webview's HTML
// drag and drop is taken by the OS file drop). As in the Windows app: the drag starts after 6 px, an accent
// pill with the folder's name follows the cursor, the row under it is tinted when it takes the drop, and the
// list scrolls by 12 px while the cursor is within 28 px of its top or bottom edge. Esc cancels.

import { h } from "../../core/dom";

export const DRAG_THRESHOLD = 6;
export const EDGE = 28;
export const EDGE_STEP = 12;
/** The pill is not drawn when less room than this is left for it. */
const PILL_MIN = 30;

export function pastThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
}

/** Scroll step for a cursor at `y` in a list spanning top..bottom: -12 near the top, 12 near the bottom. */
export function edgeStep(y: number, top: number, bottom: number): number {
  if (y < top + EDGE) return -EDGE_STEP;
  if (y > bottom - EDGE) return EDGE_STEP;
  return 0;
}

export interface DragOptions<T> {
  /** The scroll container holding the rows. */
  el: HTMLElement;
  /**
   * Where rows may be dragged beyond the list (default: the list): the pill shows up to its right edge, and
   * the list scrolls at its top or bottom edge only while the cursor is over the list.
   */
  reach?: HTMLElement;
  /** The row a DOM element belongs to. */
  rowAt(node: Element | null): T | undefined;
  title(row: T): string;
  canDrag(row: T): boolean;
  canDrop(source: T, target: T): boolean;
  /** Tints the row taking the drop (null = none). */
  setTarget(target: T | null): void;
  onDrop(source: T, target: T): void;
}

export function attachDrag<T>(opts: DragOptions<T>): void {
  const { el } = opts;
  let source: T | null = null;
  let pointer = -1;
  let startX = 0;
  let startY = 0;
  let x = 0;
  let y = 0;
  let dragging = false;
  let target: T | null = null;
  let pill: HTMLElement | null = null;
  let frame = 0;

  const retarget = () => {
    const row = opts.rowAt(document.elementFromPoint(x, y));
    const next = source !== null && row !== undefined && row !== source && opts.canDrop(source, row) ? row : null;
    if (next !== target) {
      target = next;
      opts.setTarget(target);
    }
  };

  const placePill = () => {
    if (!pill) return;
    const room = (opts.reach ?? el).getBoundingClientRect().right - x - 14;
    pill.hidden = room < PILL_MIN;
    pill.style.maxWidth = `${Math.max(0, room)}px`;
    pill.style.transform = `translate(${Math.round(x + 12)}px, ${Math.round(y - 12)}px)`;
  };

  // scrolls while the cursor rests near an edge
  const tick = () => {
    frame = 0;
    if (!dragging) return;
    const r = el.getBoundingClientRect();
    const step = opts.reach && (x < r.left || x > r.right) ? 0 : edgeStep(y, r.top, r.bottom);
    if (!step) return;
    const before = el.scrollTop;
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, before + step));
    if (el.scrollTop !== before) retarget();
    frame = requestAnimationFrame(tick);
  };

  const end = (drop: boolean) => {
    const src = source;
    const dst = target;
    const was = dragging;
    const id = pointer;
    source = null;
    pointer = -1;
    dragging = false;
    // after the reset: releasing fires lostpointercapture, which must find nothing left to end
    if (id >= 0 && el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    target = null;
    cancelAnimationFrame(frame);
    frame = 0;
    pill?.remove();
    pill = null;
    document.documentElement.classList.remove("sb-dragging");
    window.removeEventListener("keydown", onKey, true);
    if (!was) return;
    opts.setTarget(null);
    if (drop && src !== null && dst !== null) opts.onDrop(src, dst);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    end(false);
  };

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || source !== null) return;
    const row = opts.rowAt(e.target as Element);
    if (row === undefined || !opts.canDrag(row)) return;
    source = row;
    pointer = e.pointerId;
    startX = x = e.clientX;
    startY = y = e.clientY;
  });
  el.addEventListener("pointermove", (e) => {
    if (source === null || e.pointerId !== pointer) return;
    x = e.clientX;
    y = e.clientY;
    if (!dragging) {
      if (!pastThreshold(x - startX, y - startY)) return;
      dragging = true;
      el.setPointerCapture(pointer);
      document.documentElement.classList.add("sb-dragging");
      pill = h("div", { class: "sb-drag-pill", attrs: { "aria-hidden": "true" } }, opts.title(source));
      (document.getElementById("overlay-root") ?? document.body).append(pill);
      window.addEventListener("keydown", onKey, true);
    }
    placePill();
    retarget();
    if (!frame) frame = requestAnimationFrame(tick);
  });
  el.addEventListener("pointerup", (e) => {
    if (e.pointerId === pointer) end(true);
  });
  el.addEventListener("pointercancel", (e) => {
    if (e.pointerId === pointer) end(false);
  });
  el.addEventListener("lostpointercapture", (e) => {
    if (dragging && e.pointerId === pointer) end(false);
  });
}
