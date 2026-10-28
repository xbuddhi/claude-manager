// A read-only code view: virtualized monospace lines with numbers that stay put while the text scrolls
// sideways. The text shows plain at once and coloured once its language's parser has run.

import { h } from "../../core/dom";
import { highlightFile, type Token } from "../git/api";

const LINE = 18;
const OVERSCAN = 30;

export interface CodeView {
  el: HTMLElement;
  /** Shows `text` of `path`; the same path shown again keeps the scroll position. */
  show(path: string, text: string): void;
  clear(): void;
}

/** Lines of `text`, without a final empty one after a trailing newline and without CR. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function createCodeView(): CodeView {
  const inner = h("div", { class: "fm-code-inner" });
  const el = h("div", { class: "fm-code syn-code selectable", tabIndex: 0 }, inner);
  let path: string | null = null;
  let lines: string[] = [];
  let tokens: Token[][] | null = null;
  let seq = 0;
  let frame = 0;

  const lineEl = (i: number): HTMLElement => {
    const toks = tokens?.[i];
    const text = toks
      ? toks.map(([piece, cls]) => (cls ? h("span", { class: cls }, piece) : piece))
      : [lines[i] as string];
    return h(
      "div",
      { class: "fm-line", style: { top: `${i * LINE}px` } },
      h("span", { class: "fm-ln" }, String(i + 1)),
      h("span", { class: "fm-text" }, ...text),
    );
  };

  const render = () => {
    frame = 0;
    const first = Math.max(0, Math.floor(el.scrollTop / LINE) - OVERSCAN);
    const last = Math.min(lines.length, Math.ceil((el.scrollTop + el.clientHeight) / LINE) + OVERSCAN);
    const out: HTMLElement[] = [];
    for (let i = first; i < last; i++) out.push(lineEl(i));
    inner.replaceChildren(...out);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  el.addEventListener("scroll", schedule, { passive: true });
  new ResizeObserver(schedule).observe(el);

  return {
    el,
    show(next, text) {
      const same = next === path;
      path = next;
      lines = splitLines(text);
      tokens = null;
      const digits = String(lines.length).length;
      let widest = 0;
      for (const l of lines) widest = Math.max(widest, l.length + (l.match(/\t/g)?.length ?? 0) * 3);
      el.style.setProperty("--fm-digits", String(Math.max(3, digits)));
      inner.style.height = `${lines.length * LINE}px`;
      inner.style.minWidth = `calc(${widest}ch + ${Math.max(3, digits)}ch + 40px)`;
      if (!same) el.scrollTop = el.scrollLeft = 0;
      render();
      const mine = ++seq;
      void highlightFile(next, text).then((toks) => {
        if (mine !== seq || !toks) return;
        tokens = toks;
        render();
      });
    },
    clear() {
      path = null;
      lines = [];
      tokens = null;
      seq++;
      inner.style.height = "0";
      inner.replaceChildren();
    },
  };
}
