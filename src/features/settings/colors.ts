// The colour pickers in Settings: a small preview of each choice (in the theme in use), the chosen one
// ringed. Arrow keys move the choice. Terminal colours preview a terminal; interface colours a window.

import type { AppColors } from "../../bindings/AppColors";
import type { TerminalColors } from "../../bindings/TerminalColors";
import { APP_COLORS, skinPalette, terminalColorsFor } from "../../core/appColors";
import { h } from "../../core/dom";
import { settings } from "../../core/settings";
import { TERM_COLORS, termPalette } from "../../core/termColors";
import { appDark, onThemeChange, termDark } from "../../core/theme";

export interface ColorPicker<T extends string> {
  el: HTMLElement;
  set(id: T): void;
  /** Stops following theme changes. */
  dispose(): void;
}

/** The tokens.css values of `names` (without `--`): a skin's or a scheme's tokens can be inline on <html>. */
function baseTokens<K extends string>(names: readonly K[]): Record<K, string> {
  // lifted for the read (no paint happens in between)
  const root = document.documentElement;
  const inline = root.getAttribute("style");
  root.removeAttribute("style");
  const css = getComputedStyle(root);
  const out = Object.fromEntries(names.map((n) => [n, css.getPropertyValue(`--${n}`).trim()])) as Record<K, string>;
  if (inline !== null) root.setAttribute("style", inline);
  return out;
}

const DOTS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/** The colours a terminal preview shows: the scheme's, or for "default" the skin's or the app's own. */
function swatch(id: TerminalColors): { bg: string; fg: string; dots: string[] } {
  const shown = id === "default" ? terminalColorsFor({ ...settings(), terminalColors: id }) : id;
  const pal = termPalette(shown, termDark() ? "dark" : "light");
  if (pal) return { bg: pal.bg, fg: pal.fg, dots: pal.ansi.slice(1, 7) };
  const t = baseTokens(["term-bg", "term-fg", ...DOTS.map((c) => `term-${c}` as const)]);
  return { bg: t["term-bg"], fg: t["term-fg"], dots: DOTS.map((c) => t[`term-${c}`]) };
}

const WINDOW = ["bg", "side", "card", "border", "text", "muted", "accent-strong"] as const;

/** The colours a window preview shows: the skin's, or the app's own for "claude". */
function windowColors(id: AppColors): Record<(typeof WINDOW)[number], string> {
  return skinPalette(id, appDark() ? "dark" : "light") ?? baseTokens(WINDOW);
}

function picker<T extends string>(
  label: string,
  choices: ReadonlyArray<{ id: T; label: string }>,
  value: T,
  onChange: (id: T) => void,
  paint: (id: T, preview: HTMLElement) => void,
  previewClass = "",
): ColorPicker<T> {
  let current = value;
  const el = h("div", { class: "set-colors", attrs: { role: "radiogroup", "aria-label": label } });
  const items = choices.map((c) => {
    const preview = h("span", { class: `set-color-preview ${previewClass}`.trim() });
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

  const repaint = () => {
    for (const { id, preview } of items) paint(id, preview);
  };
  const mark = () => {
    for (const { id, item } of items) {
      const on = id === current;
      item.classList.toggle("selected", on);
      item.setAttribute("aria-checked", String(on));
      item.tabIndex = on ? 0 : -1;
    }
  };
  function choose(id: T) {
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

  repaint();
  mark();
  const off = onThemeChange(repaint);
  return {
    el,
    set(id) {
      current = id;
      mark();
    },
    dispose: off,
  };
}

export function colorPicker(
  value: TerminalColors,
  onChange: (id: TerminalColors) => void,
): ColorPicker<TerminalColors> {
  return picker("Terminal colours", TERM_COLORS, value, onChange, (id, preview) => {
    const s = swatch(id);
    preview.replaceChildren(
      h("span", { class: "set-color-text", textContent: "~ $ claude" }),
      h("span", { class: "set-color-dots" }, ...s.dots.map((d) => h("i", { style: { background: d } }))),
    );
    preview.style.background = s.bg;
    preview.style.color = s.fg;
  });
}

export function skinPicker(value: AppColors, onChange: (id: AppColors) => void): ColorPicker<AppColors> {
  return picker(
    "Interface colours",
    APP_COLORS,
    value,
    onChange,
    (id, preview) => {
      const c = windowColors(id);
      const line = (color: string, width: string) => h("i", { style: { background: color, width } });
      preview.replaceChildren(
        h(
          "span",
          { class: "set-skin-side", style: { background: c.side, borderColor: c.border } },
          line(c.muted, "70%"),
          line(c.muted, "50%"),
          line(c.muted, "60%"),
        ),
        h(
          "span",
          { class: "set-skin-card", style: { background: c.card, borderColor: c.border } },
          line(c.text, "65%"),
          line(c.muted, "45%"),
          h("b", { style: { background: c["accent-strong"] } }),
        ),
      );
      preview.style.background = c.bg;
    },
    "set-skin-preview",
  );
}
