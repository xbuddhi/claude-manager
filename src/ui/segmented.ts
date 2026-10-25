// Segmented control (radio group) with a pill that glides to the chosen segment (spring 0.34 / 0.8).
// Arrow keys, Home and End move the choice.

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import "./segmented.css";

export interface SegmentItem<T extends string> {
  id: T;
  label: string;
}

export interface SegmentedOptions<T extends string> {
  items: SegmentItem<T>[];
  value: T;
  onChange?: (id: T) => void;
  /** Accessible name of the group. */
  label?: string;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  readonly value: T;
  /** Selects without calling onChange; `animated` false snaps the pill. */
  set(id: T, animated?: boolean): void;
}

export function segmented<T extends string>(opts: SegmentedOptions<T>): Segmented<T> {
  let value = opts.value;
  const pill = h("div", { class: "seg-pill" });
  const el = h("div", { class: "seg", attrs: { role: "radiogroup", "aria-label": opts.label ?? "" } }, pill);
  const buttons = opts.items.map((item) =>
    h("button", {
      type: "button",
      class: "seg-item",
      textContent: item.label,
      dataset: { id: item.id },
      attrs: { role: "radio" },
      onclick: () => choose(item.id),
    }),
  );
  el.append(...buttons);

  const x = new Spring(0.34, 0.8, 0.1);
  const w = new Spring(0.34, 0.8, 0.1);
  let placed = false;
  const draw = () => {
    pill.style.transform = `translateX(${x.value}px)`;
    pill.style.width = `${w.value}px`;
  };

  function place(animated: boolean) {
    const target = buttons[opts.items.findIndex((i) => i.id === value)];
    if (!target?.offsetWidth) return; // not laid out yet; the resize observer places it
    if (!animated || !placed) {
      x.snap(target.offsetLeft);
      w.snap(target.offsetWidth);
      draw();
      placed = true;
      return;
    }
    animate(x, target.offsetLeft, draw);
    animate(w, target.offsetWidth, draw);
  }

  function mark() {
    for (const b of buttons) {
      const on = b.dataset.id === value;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  function choose(id: T) {
    if (id === value) return;
    api.set(id);
    opts.onChange?.(id);
  }

  el.addEventListener("keydown", (e) => {
    const i = opts.items.findIndex((it) => it.id === value);
    const last = opts.items.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? Math.min(last, i + 1)
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? Math.max(0, i - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    const item = opts.items[next];
    if (!item) return;
    e.preventDefault();
    choose(item.id);
    buttons[next]?.focus();
  });

  new ResizeObserver(() => place(false)).observe(el);

  const api: Segmented<T> = {
    el,
    get value() {
      return value;
    },
    set(id, animated = true) {
      value = id;
      mark();
      place(animated);
    },
  };
  mark();
  return api;
}
