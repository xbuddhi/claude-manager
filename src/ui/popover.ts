// A panel anchored under an element (usage details, profile menu). Esc, a click outside or the window
// losing focus closes it. Fades and slides in (spring 0.18 / 0.95, starting at 55% so the first frame shows).

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import { clampToWindow } from "./menu";
import "./popover.css";

export interface PopoverOptions {
  anchor: HTMLElement;
  content: HTMLElement;
  /** Horizontal alignment with the anchor. Default "end" (right edges line up). */
  align?: "start" | "center" | "end";
  /** Accessible name. */
  label?: string;
  /** Clicks on these elements do not count as outside (e.g. the button that toggles the popover). */
  ignore?: HTMLElement[];
  onClose?: () => void;
}

export interface Popover {
  el: HTMLElement;
  close(): void;
  /** Re-anchors after the content changed size. */
  reposition(): void;
}

export function openPopover(opts: PopoverOptions): Popover {
  const el = h("div", { class: "popover", attrs: { role: "dialog", "aria-label": opts.label ?? "" } }, opts.content);
  (document.getElementById("overlay-root") ?? document.body).append(el);
  const s = new Spring(0.18, 0.95, 0.003, 0.55);
  let x = 0;
  let y = 0;
  const draw = (v: number) => {
    el.style.opacity = String(Math.min(1, v));
    el.style.transform = `translate(${x}px, ${y + (1 - v) * -6}px)`;
  };

  function reposition() {
    const r = opts.anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const align = opts.align ?? "end";
    const left = align === "start" ? r.left : align === "center" ? r.left + r.width / 2 - w / 2 : r.right - w;
    const pos = clampToWindow(left, r.bottom + 6, w, el.offsetHeight, r.top - 6);
    x = Math.round(pos.x);
    y = Math.round(pos.y);
    draw(s.value);
  }

  let closed = false;
  const inside = (t: EventTarget | null) =>
    t instanceof Node && (el.contains(t) || opts.anchor.contains(t) || !!opts.ignore?.some((i) => i.contains(t)));
  const onPointer = (e: PointerEvent) => {
    if (!inside(e.target)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      opts.anchor.focus({ preventScroll: true });
    }
  };
  const onBlur = () => close();

  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", reposition);
    animate(s, 0, draw, () => el.remove());
    opts.onClose?.();
  }

  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", reposition);
  reposition();
  animate(s, 1, draw);
  return { el, close, reposition };
}
