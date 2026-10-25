// The title-bar usage ring (Windows app: UsageRing). Loading: a 70° arc going round. Ok: an arc from 12
// o'clock for the fraction, coloured by level and spring-animated. Failed: a muted ring with a 40° red arc.

import { h } from "../../core/dom";
import { levelColor } from "../../core/format";
import { animate, Spring } from "../../core/motion";
import type { RingState } from "./model";

export interface Ring {
  el: HTMLButtonElement;
  set(state: RingState, fraction: number): void;
}

const SVG = `<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true">
  <circle class="use-track" cx="11" cy="11" r="8.5"/>
  <g class="use-turn"><circle class="use-arc" cx="11" cy="11" r="8.5" pathLength="360" transform="rotate(-90 11 11)"/></g>
</svg>`;

export function createRing(): Ring {
  // a button: anything clickable in the title bar must be one, or the drag region swallows the click
  const el = h("button", {
    class: "use-ring",
    type: "button",
    attrs: { "aria-label": "Usage", "aria-haspopup": "dialog", "aria-expanded": "false" },
  });
  el.innerHTML = SVG;
  const arc = el.querySelector<SVGCircleElement>(".use-arc");
  const fill = new Spring(0.6, 1, 0.002);
  let state: RingState | null = null;

  const draw = (v: number) => {
    if (!arc || state !== "ok") return;
    arc.style.strokeDasharray = `${v > 0.003 ? 360 * v : 0} 360`;
    arc.style.stroke = levelColor(v * 100);
  };

  return {
    el,
    set(next, fraction) {
      if (next !== state) {
        state = next;
        el.dataset.state = next;
        if (arc && next !== "ok") {
          arc.style.strokeDasharray = next === "loading" ? "70 360" : "40 360";
          arc.style.stroke = "";
        }
      }
      if (next === "ok") {
        draw(fill.value);
        animate(fill, fraction, draw);
      }
      el.setAttribute(
        "aria-label",
        next === "ok"
          ? `Usage ${Math.round(fraction * 100)}%`
          : next === "loading"
            ? "Usage, loading"
            : "Usage unavailable",
      );
    },
  };
}
