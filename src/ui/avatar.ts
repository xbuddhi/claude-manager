// Round profile picture: initial(s) on a coloured circle, accent ring on hover (or always with `ring`).
// Colours and initials per profile come from the profiles feature; this only draws them.

import { h } from "../core/dom";
import "./avatar.css";

export interface AvatarOptions {
  /** One or two characters. */
  text: string;
  /** Fill colour (CSS). Text is white. */
  color: string;
  /** Diameter in px. Default 34. */
  size?: number;
  ring?: boolean;
  /** Accessible name; without it the avatar is decorative. */
  label?: string;
}

export function avatar(opts: AvatarOptions): HTMLElement {
  const size = opts.size ?? 34;
  // the Windows app sizes one character at 42% of the circle and two or more at 30%
  const font = Math.round(size * ([...opts.text].length > 1 ? 0.3 : 0.42));
  const el = h(
    "span",
    {
      class: `avatar${opts.ring ? " ring" : ""}`,
      style: { width: `${size}px`, height: `${size}px`, fontSize: `${font}px`, background: opts.color },
    },
    opts.text,
  );
  if (opts.label) {
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", opts.label);
  } else el.setAttribute("aria-hidden", "true");
  return el;
}
