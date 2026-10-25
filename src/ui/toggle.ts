// On/off switch (role=switch). The knob springs across (0.32 / 0.72) and stretches while pressed.
// Click, Space and Enter flip it.

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import "./toggle.css";

export interface ToggleOptions {
  checked: boolean;
  /** Accessible name; shown as text after the switch when `showLabel` is set. */
  label: string;
  showLabel?: boolean;
  onChange?: (checked: boolean) => void;
}

export interface Toggle {
  el: HTMLElement;
  readonly checked: boolean;
  /** Sets the state without calling onChange. */
  set(checked: boolean, animated?: boolean): void;
}

export function toggle(opts: ToggleOptions): Toggle {
  let checked = opts.checked;
  const knob = h("span", { class: "tg-knob" });
  const sw = h("button", { type: "button", class: "tg", attrs: { role: "switch", "aria-label": opts.label } }, knob);
  const el = opts.showLabel ? h("label", { class: "tg-row" }, sw, h("span", {}, opts.label)) : sw;
  const s = new Spring(0.32, 0.72, 0.002, checked ? 1 : 0);
  const draw = (v: number) => sw.style.setProperty("--tg", String(v));

  function render(animated: boolean) {
    sw.setAttribute("aria-checked", String(checked));
    sw.classList.toggle("on", checked);
    if (animated) animate(s, checked ? 1 : 0, draw);
    else {
      s.snap(checked ? 1 : 0);
      draw(s.value);
    }
  }

  sw.addEventListener("click", () => {
    checked = !checked;
    render(true);
    opts.onChange?.(checked);
  });

  render(false);
  return {
    el,
    get checked() {
      return checked;
    },
    set(value, animated = true) {
      if (value === checked) return;
      checked = value;
      render(animated);
    },
  };
}
