// The title-bar usage meter: two labelled bars, "Session" (the 5-hour window) and "Week", each with its
// percent, coloured by level and spring-animated. Loading: a pulsing bar. Failed: "Usage unavailable".
// The week bar hides when no weekly limit is known (e.g. local counts only).

import { h } from "../../core/dom";
import { levelColor } from "../../core/format";
import { animate, Spring } from "../../core/motion";
import type { RingState } from "./model";

export interface Ring {
  el: HTMLButtonElement;
  /** `session` 0..1; `week` 0..1, or -1 when unknown. */
  set(state: RingState, session: number, week: number): void;
}

interface Meter {
  el: HTMLElement;
  set(fraction: number): void;
}

function meter(label: string): Meter {
  const el = h("span", { class: "use-m" });
  el.innerHTML = `<span class="use-m-label">${label}</span><span class="use-m-bar"><i></i></span><span class="use-m-pct"></span>`;
  const fill = el.querySelector("i") as HTMLElement;
  const pct = el.querySelector(".use-m-pct") as HTMLElement;
  const spring = new Spring(0.6, 1, 0.002);
  const draw = (v: number) => {
    fill.style.width = `${Math.max(0, Math.min(1, v)) * 100}%`;
  };
  return {
    el,
    set(f) {
      pct.textContent = `${Math.round(f * 100)}%`;
      fill.style.background = levelColor(f * 100);
      animate(spring, f, draw);
    },
  };
}

export function createRing(): Ring {
  // a button: anything clickable in the title bar must be one, or the drag region swallows the click
  const el = h("button", {
    class: "use-ring",
    type: "button",
    attrs: { "aria-label": "Usage", "aria-haspopup": "dialog", "aria-expanded": "false" },
  });
  const session = meter("Session");
  const week = meter("Week");
  const note = h("span", { class: "use-note" });
  el.append(session.el, week.el, note);

  return {
    el,
    set(state, s, w) {
      el.dataset.state = state;
      note.textContent = state === "loading" ? "Usage" : state === "failed" ? "Usage unavailable" : "";
      if (state === "ok") {
        session.set(s);
        week.el.hidden = w < 0;
        if (w >= 0) week.set(w);
      }
      el.setAttribute(
        "aria-label",
        state === "ok"
          ? `Usage: session ${Math.round(s * 100)}%${w >= 0 ? `, week ${Math.round(w * 100)}%` : ""}`
          : state === "loading"
            ? "Usage, loading"
            : "Usage unavailable",
      );
    },
  };
}
