// A draggable divider that resizes the panel before it (vertical divider, horizontal drag), or with axis
// "y" a horizontal divider dragged up and down. Pointer drag, or the arrow keys of its axis when focused
// (Shift for bigger steps). The size is reported live
// through onResize and once more through onCommit when the drag ends (save it then).

import "./splitter.css";

export interface SplitterOptions {
  /** The divider element (already in the layout). */
  el: HTMLElement;
  /** Current size of the panel in px. */
  get(): number;
  min: number;
  /** Largest allowed size, evaluated on each move (it usually depends on the window width). */
  max(): number;
  onResize(px: number): void;
  onCommit?(px: number): void;
  label?: string;
  /** "y": a horizontal divider; the size grows downwards (pass a negated size for a panel below it). */
  axis?: "x" | "y";
}

export function splitter(opts: SplitterOptions): void {
  const { el } = opts;
  el.classList.add("splitter");
  el.tabIndex = 0;
  el.setAttribute("role", "separator");
  const y = opts.axis === "y";
  if (y) el.classList.add("splitter-y");
  el.setAttribute("aria-orientation", y ? "horizontal" : "vertical");
  el.setAttribute("aria-label", opts.label ?? "Resize");
  const clamp = (px: number) => Math.round(Math.max(opts.min, Math.min(opts.max(), px)));
  const aria = (px: number) => {
    el.setAttribute("aria-valuenow", String(px));
    el.setAttribute("aria-valuemin", String(opts.min));
    el.setAttribute("aria-valuemax", String(Math.round(opts.max())));
  };
  aria(clamp(opts.get()));

  const at = (e: PointerEvent) => (y ? e.clientY : e.clientX);
  let start = 0;
  let startSize = 0;
  let size = 0;

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    start = at(e);
    // whole pixels from the start: a click without a move commits this value, and layout sizes are fractional
    startSize = size = clamp(opts.get());
    document.documentElement.classList.add("resizing");
    if (y) document.documentElement.classList.add("resizing-y");
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    size = clamp(startSize + at(e) - start);
    aria(size);
    opts.onResize(size);
  });
  const end = (e: PointerEvent) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    document.documentElement.classList.remove("resizing", "resizing-y");
    opts.onCommit?.(size);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);

  el.addEventListener("keydown", (e) => {
    const [back, forward] = y ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (e.key !== back && e.key !== forward) return;
    e.preventDefault();
    const step = (e.shiftKey ? 64 : 16) * (e.key === back ? -1 : 1);
    const next = clamp(opts.get() + step);
    aria(next);
    opts.onResize(next);
    opts.onCommit?.(next);
  });
}
