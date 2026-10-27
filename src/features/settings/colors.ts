// The terminal colour scheme picker in Settings: a small preview of each scheme (in the terminal theme in
// use), the chosen one ringed. Arrow keys move the choice.

import type { TerminalColors } from "../../bindings/TerminalColors";
import { h } from "../../core/dom";
import { TERM_COLORS, termPalette } from "../../core/termColors";
import { onThemeChange, termDark } from "../../core/theme";

export interface ColorPicker {
  el: HTMLElement;
  set(id: TerminalColors): void;
  /** Stops following theme changes. */
  dispose(): void;
}

/** The colours a preview shows: the scheme's, or the app's own tokens for "default". */
function swatch(id: TerminalColors): { bg: string; fg: string; dots: string[] } {
  const pal = termPalette(id, termDark() ? "dark" : "light");
  if (pal) return { bg: pal.bg, fg: pal.fg, dots: pal.ansi.slice(1, 7) };
  // another scheme's tokens can be inline on <html>: lifted for the read (no paint happens in between)
  const root = document.documentElement;
  const inline = root.getAttribute("style");
  root.removeAttribute("style");
  const css = getComputedStyle(root);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const out = {
    bg: v("--term-bg"),
    fg: v("--term-fg"),
    dots: ["red", "green", "yellow", "blue", "magenta", "cyan"].map((c) => v(`--term-${c}`)),
  };
  if (inline !== null) root.setAttribute("style", inline);
  return out;
}

export function colorPicker(value: TerminalColors, onChange: (id: TerminalColors) => void): ColorPicker {
  let current = value;
  const el = h("div", { class: "set-colors", attrs: { role: "radiogroup", "aria-label": "Terminal colours" } });
  const items = TERM_COLORS.map((c) => {
    const preview = h("span", { class: "set-color-preview" });
    const item = h(
      "button",
      {
        type: "button",
        class: "set-color",
        dataset: { id: c.id },
        attrs: { role: "radio" },
        onclick: () => choose(c.id),
      },
      preview,
      h("span", { class: "set-color-name" }, c.label),
    );
    return { id: c.id, item, preview };
  });
  el.append(...items.map((i) => i.item));

  const paint = () => {
    for (const { id, preview } of items) {
      const s = swatch(id);
      preview.replaceChildren(
        h("span", { class: "set-color-text", textContent: "~ $ claude" }),
        h("span", { class: "set-color-dots" }, ...s.dots.map((d) => h("i", { style: { background: d } }))),
      );
      preview.style.background = s.bg;
      preview.style.color = s.fg;
    }
  };
  const mark = () => {
    for (const { id, item } of items) {
      const on = id === current;
      item.classList.toggle("selected", on);
      item.setAttribute("aria-checked", String(on));
      item.tabIndex = on ? 0 : -1;
    }
  };
  function choose(id: TerminalColors) {
    if (id === current) return;
    current = id;
    mark();
    onChange(id);
  }
  el.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = items.findIndex((x) => x.id === current);
    const next = items[(i + step + items.length) % items.length];
    if (!next) return;
    choose(next.id);
    next.item.focus();
  });

  paint();
  mark();
  const off = onThemeChange(paint);
  return {
    el,
    set(id) {
      current = id;
      mark();
    },
    dispose: off,
  };
}
