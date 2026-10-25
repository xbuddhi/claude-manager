// A main action with a 30px arrow part that opens a menu of alternatives (the host shows the menu).

import { h } from "../core/dom";
import { type IconSpec, iconNode, icons } from "../core/icons";
import type { ButtonKind } from "./button";
import "./splitbutton.css";

export interface SplitButtonOptions {
  label: string;
  icon?: IconSpec;
  kind?: Extract<ButtonKind, "primary" | "secondary">;
  title?: string;
  arrowTitle?: string;
  onMain: () => void;
  /** Gets the whole control as the anchor for a menu. */
  onArrow: (anchor: HTMLElement) => void;
}

export interface SplitButton {
  el: HTMLElement;
  setDisabled(disabled: boolean): void;
}

export function splitButton(opts: SplitButtonOptions): SplitButton {
  const main = h("button", { type: "button", class: "sbtn-main" });
  if (opts.icon) main.append(iconNode(opts.icon));
  main.append(h("span", {}, opts.label));
  if (opts.title) main.dataset.tip = opts.title;
  const arrow = h("button", {
    type: "button",
    class: "sbtn-arrow",
    attrs: { "aria-label": opts.arrowTitle ?? "More options", "aria-haspopup": "menu" },
  });
  arrow.innerHTML = icons.chevronDown;
  if (opts.arrowTitle) arrow.dataset.tip = opts.arrowTitle;
  const el = h("div", { class: `sbtn sbtn-${opts.kind ?? "primary"}`, attrs: { role: "group" } }, main, arrow);
  main.addEventListener("click", () => opts.onMain());
  arrow.addEventListener("click", () => opts.onArrow(el));
  return {
    el,
    setDisabled(disabled) {
      main.disabled = arrow.disabled = disabled;
      el.classList.toggle("disabled", disabled);
    },
  };
}
