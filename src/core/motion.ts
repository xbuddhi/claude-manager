// Apple's spring model (response + damping fraction, as in SwiftUI), the same one the Windows app uses
// (MacUI.cs Spring). response = seconds for one oscillation; damping 1 = no overshoot, < 1 = a little bounce.
// With "reduce motion" on, every animation jumps to its end.

import { isMac } from "./platform";

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  private k: number;
  private c: number;
  constructor(
    response: number,
    damping: number,
    public epsilon = 0.01,
    initial = 0,
  ) {
    this.k = ((2 * Math.PI) / response) ** 2;
    this.c = (4 * Math.PI * damping) / response;
    this.value = this.target = initial;
  }
  get moving() {
    return Math.abs(this.value - this.target) > this.epsilon || Math.abs(this.velocity) > this.epsilon * 10;
  }
  // semi-implicit Euler with small sub-steps; returns true while still moving
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt / 0.004));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    if (!this.moving) {
      this.snap(this.target);
      return false;
    }
    return true;
  }
  snap(v: number) {
    this.value = this.target = v;
    this.velocity = 0;
  }
}

// one shared frame clock for every running spring
type Anim = { frame: (v: number) => void; done?: () => void };
const running = new Map<Spring, Anim>();
let last = 0;
let raf = 0;

function tick(now: number) {
  const dt = Math.min(1 / 30, (now - last) / 1000);
  last = now;
  for (const [s, a] of [...running]) {
    const moving = s.step(dt);
    a.frame(s.value);
    if (!moving) {
      running.delete(s);
      a.done?.();
    }
  }
  raf = running.size ? requestAnimationFrame(tick) : 0;
}

/** Moves a spring to `target`, calling `frame` with each value; a running animation of the same spring is retargeted, keeping its velocity. */
export function animate(s: Spring, target: number, frame: (v: number) => void, done?: () => void) {
  s.target = target;
  if (reduceMotion.matches) {
    s.snap(target);
    running.delete(s);
    frame(target);
    done?.();
    return;
  }
  running.set(s, { frame, done });
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
}

/** Content that appears: fades in and settles up a few pixels. */
export function settleIn(node: HTMLElement | null | undefined, dy = 6) {
  if (!node) return;
  const s = new Spring(0.28, 0.9, 0.003);
  node.style.opacity = "0";
  animate(s, 1, (v) => {
    node.style.opacity = String(Math.min(1, v));
    node.style.transform = v >= 1 ? "" : `translateY(${(1 - v) * dy}px)`;
  });
}

/**
 * Spring-smoothed wheel scrolling for a scroll container (Windows). macOS scrolls natively: trackpad
 * momentum and rubber-banding must not be fought.
 */
export function smoothScroll(el: HTMLElement) {
  const s = new Spring(0.36, 1, 0.5, el.scrollTop);
  let animating = false;
  el.addEventListener(
    "wheel",
    (e) => {
      if (isMac() || e.ctrlKey || reduceMotion.matches || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (!animating) s.snap(el.scrollTop);
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      const max = el.scrollHeight - el.clientHeight;
      animating = true;
      animate(
        s,
        Math.max(0, Math.min(max, s.target + step)),
        (v) => {
          el.scrollTop = v;
        },
        () => {
          animating = false;
        },
      );
    },
    { passive: false },
  );
}

/** Shows the thin scrollbar thumb while scrolling and hides it a second after (see base.css). */
export function autoHideScrollbar(el: HTMLElement) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  el.addEventListener(
    "scroll",
    () => {
      el.classList.add("scrolling");
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove("scrolling"), 1000);
    },
    { passive: true },
  );
}

/** A scroll container with the app's scrolling: smooth wheel on Windows and an auto-hiding thumb. */
export function scroller(el: HTMLElement) {
  smoothScroll(el);
  autoHideScrollbar(el);
}
