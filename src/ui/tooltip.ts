// Themed tooltips for every element with a `data-tip` attribute (use it instead of `title`).
// Shows after 450 ms of hovering, hides after 12 s, on leave, click, key press or scroll.
// The text may have several lines ("\n").

import { h } from "../core/dom";
import "./tooltip.css";

const SHOW_DELAY = 450;
const HIDE_AFTER = 12_000;
const GAP = 6;

let tip: HTMLElement | null = null;
let target: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function element(): HTMLElement {
  if (!tip) {
    tip = h("div", { class: "tooltip", attrs: { role: "tooltip" } });
    tip.id = "app-tooltip";
    (document.getElementById("overlay-root") ?? document.body).append(tip);
  }
  return tip;
}

function hide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  target?.removeAttribute("aria-describedby");
  target = null;
  tip?.classList.remove("on");
}

/** Where a tooltip of size w×h goes for an anchor rect: below and centred, above when there is no room, inside the window. */
export function placeTooltip(anchor: DOMRect, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const x = Math.max(GAP, Math.min(vw - w - GAP, anchor.left + anchor.width / 2 - w / 2));
  const below = anchor.bottom + GAP;
  const y = below + h <= vh - GAP ? below : Math.max(GAP, anchor.top - GAP - h);
  return { x, y };
}

function show(el: HTMLElement) {
  const text = el.dataset.tip;
  if (!text || !el.isConnected) return;
  const t = element();
  t.textContent = text;
  t.classList.add("on");
  const { x, y } = placeTooltip(el.getBoundingClientRect(), t.offsetWidth, t.offsetHeight, innerWidth, innerHeight);
  t.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.setAttribute("aria-describedby", t.id);
  hideTimer = setTimeout(hide, HIDE_AFTER);
}

export function installTooltips(): void {
  document.addEventListener("pointerover", (e) => {
    const el = (e.target as Element | null)?.closest<HTMLElement>("[data-tip]") ?? null;
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    showTimer = setTimeout(() => show(el), SHOW_DELAY);
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}

/** Sets or clears an element's tooltip text. */
export function setTip(el: HTMLElement, text: string | null): void {
  if (text) el.dataset.tip = text;
  else delete el.dataset.tip;
  if (el === target && tip?.classList.contains("on")) {
    if (text) tip.textContent = text;
    else hide();
  }
}
