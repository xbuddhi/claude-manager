// The diff viewer: virtualized monospace rows with an old/new line-number gutter that stays put while the
// text scrolls sideways (Shift+wheel too). Ctrl/Cmd+C with nothing selected copies the whole diff.

import { h } from "../../core/dom";
import { isMac } from "../../core/platform";
import { copyText } from "../os/api";
import { type DiffLine, diffToText, displayText, widestLine } from "./diffparse";

const LINE = 18;
const OVERSCAN = 20;
/** Width of the number gutter (two 38px columns and a gap); the text starts after it. */
const GUTTER = 82;

export interface DiffView {
  el: HTMLElement;
  /** Shows `lines`. The same `sig` as the diff on screen keeps the scroll position (a refresh). */
  show(lines: DiffLine[], sig: string): void;
  /** No diff: a centered message. */
  clear(message: string): void;
}

function rowEl(d: DiffLine, top: number): HTMLElement {
  const el = h("div", { class: `git-dl git-dl-${d.kind}`, style: { top: `${top}px` } });
  if (d.kind === "file" || d.kind === "meta") {
    el.append(h("span", { class: "git-dl-text" }, displayText(d.text)));
  } else if (d.kind === "hunk") {
    el.append(h("span", { class: "git-dl-gutter" }), h("span", { class: "git-dl-text" }, displayText(d.text)));
  } else {
    const sign = d.kind === "add" ? "+" : d.kind === "del" ? "-" : " ";
    el.append(
      h(
        "span",
        { class: "git-dl-gutter" },
        h("span", {}, d.old > 0 ? String(d.old) : ""),
        h("span", {}, d.new > 0 ? String(d.new) : ""),
      ),
      h("span", { class: "git-dl-text" }, sign + displayText(d.text)),
    );
  }
  return el;
}

export function createDiff(): DiffView {
  const inner = h("div", { class: "git-diff-inner" });
  const empty = h("div", { class: "git-diff-empty" });
  const el = h(
    "div",
    { class: "git-diff", tabIndex: 0, attrs: { role: "document", "aria-label": "Changes" } },
    inner,
    empty,
  );
  let lines: DiffLine[] = [];
  let sig: string | null = null;
  let frame = 0;

  function render() {
    const first = Math.max(0, Math.floor(el.scrollTop / LINE) - OVERSCAN);
    const last = Math.min(lines.length, Math.ceil((el.scrollTop + el.clientHeight) / LINE) + OVERSCAN);
    const rows: HTMLElement[] = [];
    for (let i = first; i < last; i++) rows.push(rowEl(lines[i] as DiffLine, i * LINE));
    inner.replaceChildren(...rows);
  }
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }
  };
  el.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(el);

  // Shift+wheel scrolls sideways where the OS does not already turn it into a horizontal scroll
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.shiftKey || e.deltaX !== 0 || e.deltaY === 0) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  el.addEventListener("keydown", (e) => {
    const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "c" || !lines.length) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && el.contains(sel.anchorNode)) return; // the browser copies it
    e.preventDefault();
    void copyText(diffToText(lines));
  });

  function set(next: DiffLine[]) {
    lines = next;
    inner.style.height = `${lines.length * LINE + 8}px`;
    inner.style.width = `calc(${GUTTER + 24}px + ${widestLine(lines)}ch)`;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    render();
  }

  return {
    el,
    show(next, nextSig) {
      empty.hidden = true;
      if (nextSig === sig) return;
      sig = nextSig;
      set(next);
    },
    clear(message) {
      sig = null;
      empty.textContent = message;
      empty.hidden = false;
      set([]);
    },
  };
}
