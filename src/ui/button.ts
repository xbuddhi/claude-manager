// Push button in four kinds: primary (accent fill), secondary (control fill + border), danger (red text),
// plain (transparent until hovered). Optional icon before the label, or icon only (give a `title` then).

import { h } from "../core/dom";
import { type IconSpec, iconNode } from "../core/icons";
import "./button.css";

export type ButtonKind = "primary" | "secondary" | "danger" | "plain";

export interface ButtonOptions {
  label?: string;
  icon?: IconSpec;
  kind?: ButtonKind;
  /** Tooltip (themed, see tooltip.ts) and accessible name for icon-only buttons. */
  title?: string;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
}

export function button(opts: ButtonOptions): HTMLButtonElement {
  const kind = opts.kind ?? "secondary";
  const b = h("button", {
    type: "button",
    class: `btn btn-${kind}${opts.label ? "" : " btn-icon"}`,
    disabled: opts.disabled ?? false,
  });
  if (opts.icon) b.append(iconNode(opts.icon));
  if (opts.label) b.append(h("span", { class: "btn-label" }, opts.label));
  if (opts.title) {
    b.dataset.tip = opts.title;
    if (!opts.label) b.setAttribute("aria-label", opts.title);
  }
  if (opts.onClick) b.addEventListener("click", opts.onClick);
  return b;
}

/** Changes a button's label text in place. */
export function setButtonLabel(b: HTMLButtonElement, label: string): void {
  const span = b.querySelector(".btn-label");
  if (span) span.textContent = label;
}
