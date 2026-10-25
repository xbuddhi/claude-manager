// Apple's spring model (response + damping fraction, as in SwiftUI), the same one the Windows app uses (MacUI.cs Spring).
// response = seconds for one oscillation; damping 1 = no overshoot, < 1 = a little bounce.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

export class Spring {
  value: number;
  target: number;
  velocity = 0;
  private k: number;
  private c: number;
  constructor(response: number, damping: number, public epsilon = 0.01, initial = 0) {
    this.k = Math.pow((2 * Math.PI) / response, 2);
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

/** move a spring to `target`, calling `frame` with each value; a running animation of the same spring is retargeted, keeping its velocity */
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

/** spring-smoothed wheel scrolling for a scroll container */
export function smoothScroll(el: HTMLElement) {
  const s = new Spring(0.36, 1, 0.5, el.scrollTop);
  let animating = false;
  el.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || reduceMotion.matches || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      if (!animating) s.snap(el.scrollTop);
      const step = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      const max = el.scrollHeight - el.clientHeight;
      animating = true;
      animate(s, Math.max(0, Math.min(max, s.target + step)), (v) => (el.scrollTop = v), () => (animating = false));
    },
    { passive: false },
  );
}
