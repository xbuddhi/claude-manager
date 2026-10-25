// Text tabs ("Changes 3 | History") with a 2px underline that glides to the chosen tab
// (springs 0.3 / 0.86 for position, 0.3 / 0.9 for width). Arrow keys move between tabs.

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import "./texttabs.css";

export interface TextTab<T extends string> {
  id: T;
  label: string;
}

export interface TextTabsOptions<T extends string> {
  items: TextTab<T>[];
  value: T;
  onChange?: (id: T) => void;
  label?: string;
}

export interface TextTabs<T extends string> {
  el: HTMLElement;
  readonly value: T;
  set(id: T, animated?: boolean): void;
  /** Replaces the labels (e.g. a count changed); the underline snaps to the new size. */
  setItems(items: TextTab<T>[]): void;
}

export function textTabs<T extends string>(opts: TextTabsOptions<T>): TextTabs<T> {
  let value = opts.value;
  let items = opts.items;
  const line = h("div", { class: "ttabs-line" });
  const el = h("div", { class: "ttabs", attrs: { role: "tablist", "aria-label": opts.label ?? "" } });
  const x = new Spring(0.3, 0.86, 0.1);
  const w = new Spring(0.3, 0.9, 0.1);
  let placed = false;
  const draw = () => {
    line.style.transform = `translateX(${x.value}px)`;
    line.style.width = `${w.value}px`;
  };

  function tabs(): HTMLButtonElement[] {
    return [...el.querySelectorAll<HTMLButtonElement>(".ttab")];
  }

  function render() {
    el.replaceChildren(
      ...items.map((it) =>
        h("button", {
          type: "button",
          class: "ttab",
          textContent: it.label,
          dataset: { id: it.id },
          attrs: { role: "tab" },
          onclick: () => choose(it.id),
        }),
      ),
      line,
    );
    mark();
  }

  function mark() {
    for (const t of tabs()) {
      const on = t.dataset.id === value;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
  }

  function place(animated: boolean) {
    const t = tabs().find((b) => b.dataset.id === value);
    if (!t?.offsetWidth) return;
    if (!animated || !placed) {
      x.snap(t.offsetLeft);
      w.snap(t.offsetWidth);
      draw();
      placed = true;
      return;
    }
    animate(x, t.offsetLeft, draw);
    animate(w, t.offsetWidth, draw);
  }

  function choose(id: T) {
    if (id === value) return;
    api.set(id);
    opts.onChange?.(id);
  }

  el.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const i = items.findIndex((it) => it.id === value);
    const next = items[e.key === "ArrowRight" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
    if (!next) return;
    e.preventDefault();
    choose(next.id);
    tabs()
      .find((b) => b.dataset.id === next.id)
      ?.focus();
  });
  new ResizeObserver(() => place(false)).observe(el);

  const api: TextTabs<T> = {
    el,
    get value() {
      return value;
    },
    set(id, animated = true) {
      value = id;
      mark();
      place(animated);
    },
    setItems(next) {
      items = next;
      render();
      place(false);
    },
  };
  render();
  return api;
}
