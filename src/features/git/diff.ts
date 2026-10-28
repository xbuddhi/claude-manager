// The diff viewer: virtualized monospace rows, inline (one column, old/new line numbers) or side by side
// (old left, new right, a hatched filler where a side has no line). Inline, the line-number gutter stays put
// while the text scrolls sideways; side by side, both sides scroll sideways together. Shift+wheel scrolls
// sideways too. Ctrl/Cmd+C with nothing selected copies the whole diff. Code is shown plain at once and
// coloured when its language's parser has run (highlight.ts); the words that changed inside a replaced line
// are marked (diffparse.ts markWords).

import { h } from "../../core/dom";
import { isMac } from "../../core/platform";
import { segmented } from "../../ui/segmented";
import { copyText } from "../os/api";
import { type DiffLine, diffToText, displayText, markWords, type SplitRow, splitRows, widestLine } from "./diffparse";
import { highlightDiff, type Token } from "./highlight";
import { createRowWindow } from "./rowwindow";

const LINE = 18;
const OVERSCAN = 20;
/** Width of the inline number gutter (two 38px columns and a gap); the text starts after it. */
const GUTTER = 82;
/** Width of one side's number gutter, side by side. */
const SPLIT_GUTTER = 50;

type Mode = "inline" | "split";
const MODE_KEY = "git.diffMode";

function savedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "inline";
  } catch {
    return "inline";
  }
}

export interface DiffView {
  el: HTMLElement;
  /** Shows `lines`. The same `sig` as the diff on screen keeps the scroll position (a refresh). */
  show(lines: DiffLine[], sig: string): void;
  /** No diff: a centered message. */
  clear(message: string): void;
}

const signOf = (d: DiffLine) => (d.kind === "add" ? "+" : d.kind === "del" ? "-" : " ");

/**
 * A code line's text after its sign: the syntax pieces (or the plain text), cut where a changed-word mark
 * starts or ends so the marked parts get `git-chg`.
 */
function codeEl(sign: string, d: DiffLine, tokens: Token[] | undefined): HTMLElement {
  const parts: Token[] = tokens ?? [[d.text, ""]];
  const marks = d.marks ?? [];
  const out: Array<Node | string> = [sign];
  let pos = 0;
  let mi = 0;
  for (const [text, cls] of parts) {
    let start = 0;
    while (start < text.length) {
      const at = pos + start;
      while (mi < marks.length && (marks[mi] as [number, number])[1] <= at) mi++;
      const mark = marks[mi];
      const inMark = mark !== undefined && at >= mark[0];
      const end = mark === undefined ? text.length : Math.min(text.length, (inMark ? mark[1] : mark[0]) - pos);
      const piece = displayText(text.slice(start, end));
      const c = inMark ? (cls ? `${cls} git-chg` : "git-chg") : cls;
      out.push(c ? h("span", { class: c }, piece) : piece);
      start = end;
    }
    pos += text.length;
  }
  return h("span", { class: "git-dl-text" }, ...out);
}

/** A row across the whole width: a file bar, a hunk header or a meta line. */
function spanEl(d: DiffLine, top: number): HTMLElement {
  const el = h("div", { class: `git-dl git-dl-${d.kind}`, style: { top: `${top}px` } });
  if (d.kind === "hunk") el.append(h("span", { class: "git-dl-gutter" }));
  el.append(h("span", { class: "git-dl-text" }, displayText(d.text)));
  return el;
}

function rowEl(d: DiffLine, top: number, tokens: Token[] | undefined): HTMLElement {
  if (d.kind === "file" || d.kind === "meta" || d.kind === "hunk") return spanEl(d, top);
  return h(
    "div",
    { class: `git-dl git-dl-${d.kind}`, style: { top: `${top}px` } },
    h(
      "span",
      { class: "git-dl-gutter" },
      h("span", {}, d.old > 0 ? String(d.old) : ""),
      h("span", {}, d.new > 0 ? String(d.new) : ""),
    ),
    codeEl(signOf(d), d, tokens),
  );
}

/** One side of a side-by-side row; no line = the hatched filler. */
function halfEl(d: DiffLine | undefined, side: "old" | "new", tokens: Token[] | undefined): HTMLElement {
  if (!d) return h("div", { class: "git-half git-half-filler" });
  const n = side === "old" ? d.old : d.new;
  return h(
    "div",
    { class: `git-half git-half-${d.kind}` },
    h("span", { class: "git-dl-gutter" }, h("span", {}, n > 0 ? String(n) : "")),
    codeEl(d.kind === "context" ? " " : signOf(d), d, tokens),
  );
}

export function createDiff(): DiffView {
  const inner = h("div", { class: "git-diff-inner" });
  const empty = h("div", { class: "git-diff-empty" });
  // one character's width, to know how far the sides scroll
  const ruler = h("span", { class: "git-diff-ruler", attrs: { "aria-hidden": "true" } }, "0".repeat(100));
  const scroller = h(
    "div",
    { class: "git-diff", tabIndex: 0, attrs: { role: "document", "aria-label": "Changes" } },
    inner,
    empty,
    ruler,
  );
  let mode: Mode = savedMode();
  const toggle = segmented<Mode>({
    items: [
      { id: "inline", label: "Inline" },
      { id: "split", label: "Side by side" },
    ],
    value: mode,
    label: "Diff layout",
    onChange: (next) => {
      mode = next;
      try {
        localStorage.setItem(MODE_KEY, next);
      } catch {
        // not kept for next time; the layout still changes
      }
      layout();
    },
  });
  const el = h("div", { class: "git-diff-wrap" }, h("div", { class: "git-diff-bar" }, toggle.el), scroller);

  let lines: DiffLine[] = [];
  let rows: SplitRow[] = [];
  let tokens: Array<Token[] | undefined> = [];
  let sig: string | null = null;
  /** Longest line of the diff in characters (worked out once per diff). */
  let widest = 0;
  let frame = 0;
  /** How far both sides are scrolled sideways (side by side), in px. */
  let sx = 0;

  const count = () => (mode === "split" ? rows.length : lines.length);

  /** Row `i` of the current mode. */
  function build(i: number): HTMLElement {
    const top = i * LINE;
    if (mode === "inline") return rowEl(lines[i] as DiffLine, top, tokens[i]);
    const r = rows[i] as SplitRow;
    if (r.span !== undefined) return spanEl(lines[r.span] as DiffLine, top);
    const left = r.left === undefined ? undefined : lines[r.left];
    const right = r.right === undefined ? undefined : lines[r.right];
    return h(
      "div",
      { class: "git-dl git-dl-split", style: { top: `${top}px` } },
      halfEl(left, "old", r.left === undefined ? undefined : tokens[r.left]),
      halfEl(right, "new", r.right === undefined ? undefined : tokens[r.right]),
    );
  }
  const shown = createRowWindow(inner, build);

  function render() {
    const first = Math.max(0, Math.floor(scroller.scrollTop / LINE) - OVERSCAN);
    const last = Math.min(count(), Math.ceil((scroller.scrollTop + scroller.clientHeight) / LINE) + OVERSCAN);
    shown.update(first, last);
  }
  const schedule = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }
  };
  scroller.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(() => {
    scrollSides(0);
    schedule();
  }).observe(scroller);

  /** Side by side: moves both sides sideways by `dx`, within the widest line. */
  function scrollSides(dx: number) {
    const ch = ruler.offsetWidth / 100 || 7;
    const half = scroller.clientWidth / 2;
    const max = Math.max(0, SPLIT_GUTTER + 24 + widest * ch - half);
    sx = Math.max(0, Math.min(max, sx + dx));
    inner.style.setProperty("--sx", `${sx}px`);
  }

  scroller.addEventListener(
    "wheel",
    (e) => {
      const sideways = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (mode === "split") {
        if (!sideways) return;
        e.preventDefault();
        scrollSides(sideways);
        return;
      }
      // inline: Shift+wheel scrolls sideways where the OS does not already turn it into a horizontal scroll
      if (!e.shiftKey || e.deltaX !== 0 || e.deltaY === 0) return;
      e.preventDefault();
      scroller.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  scroller.addEventListener("keydown", (e) => {
    const mod = isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "c" || !lines.length) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && scroller.contains(sel.anchorNode)) return; // the browser copies it
    e.preventDefault();
    void copyText(diffToText(lines));
  });

  /** Sizes the scroll area for the mode and redraws; the vertical position stays. */
  function layout() {
    scroller.classList.toggle("split", mode === "split");
    inner.style.height = `${count() * LINE + 8}px`;
    inner.style.width = mode === "split" ? "" : `calc(${GUTTER + 24}px + ${widest}ch)`;
    sx = 0;
    scrollSides(0);
    scroller.scrollLeft = 0;
    shown.invalidate();
    render();
  }

  function set(next: DiffLine[]) {
    lines = next;
    markWords(lines);
    rows = splitRows(lines);
    widest = widestLine(lines);
    tokens = [];
    scroller.scrollTop = 0;
    layout();
  }

  return {
    el,
    show(next, nextSig) {
      empty.hidden = true;
      if (nextSig === sig) return;
      sig = nextSig;
      set(next);
      // another diff coming up meanwhile stops the colouring
      void highlightDiff(next, () => lines !== next).then((t) => {
        if (lines !== next) return;
        tokens = t;
        shown.invalidate();
        render();
      });
    },
    clear(message) {
      sig = null;
      empty.textContent = message;
      empty.hidden = false;
      set([]);
    },
  };
}
