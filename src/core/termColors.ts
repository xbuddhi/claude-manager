// Terminal colour schemes (settings: terminalColors), each with a dark and a light version for the
// terminal theme. "default" keeps the app's own tokens (styles/tokens.css); the others are set as inline
// tokens on <html> by core/theme.ts, so the terminals, their tab and the session bar all follow.

import type { TerminalColors } from "../bindings/TerminalColors";
import type { Scheme } from "./theme";

/** The 16 ANSI colours, as xterm ITheme keys; their tokens are `--term-<kebab-case key>`. */
export const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

export function ansiToken(key: (typeof ANSI)[number]): string {
  return `--term-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

export interface Palette {
  bg: string;
  fg: string;
  /** In ANSI order. */
  ansi: readonly string[];
}

export interface ColorScheme {
  id: TerminalColors;
  label: string;
  dark: Palette | null;
  light: Palette | null;
}

const p = (bg: string, fg: string, ansi: string): Palette => ({ bg, fg, ansi: ansi.split(" ") });

export const TERM_COLORS: readonly ColorScheme[] = [
  { id: "default", label: "Default", dark: null, light: null },
  {
    id: "one",
    label: "One",
    dark: p(
      "#282c34",
      "#abb2bf",
      "#3f4451 #e06c75 #98c379 #e5c07b #61afef #c678dd #56b6c2 #d7dae0 #5c6370 #ff7b86 #b1e18b #efb074 #67cdff #e48bff #63d4e0 #ffffff",
    ),
    light: p(
      "#fafafa",
      "#383a42",
      "#383a42 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #a0a1a7 #696c77 #e45649 #50a14f #c18401 #4078f2 #a626a4 #0184bc #fafafa",
    ),
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: p(
      "#1e1e2e",
      "#cdd6f4",
      "#45475a #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #bac2de #585b70 #f38ba8 #a6e3a1 #f9e2af #89b4fa #f5c2e7 #94e2d5 #a6adc8",
    ),
    light: p(
      "#eff1f5",
      "#4c4f69",
      "#5c5f77 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #acb0be #6c6f85 #d20f39 #40a02b #df8e1d #1e66f5 #ea76cb #179299 #bcc0cc",
    ),
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    dark: p(
      "#1a1b26",
      "#c0caf5",
      "#15161e #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #a9b1d6 #414868 #f7768e #9ece6a #e0af68 #7aa2f7 #bb9af7 #7dcfff #c0caf5",
    ),
    light: p(
      "#e1e2e7",
      "#3760bf",
      "#b4b5b9 #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #6172b0 #a1a6c5 #f52a65 #587539 #8c6c3e #2e7de9 #9854f1 #007197 #3760bf",
    ),
  },
  {
    id: "rose-pine",
    label: "Rosé Pine",
    dark: p(
      "#191724",
      "#e0def4",
      "#26233a #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4 #6e6a86 #eb6f92 #31748f #f6c177 #9ccfd8 #c4a7e7 #ebbcba #e0def4",
    ),
    light: p(
      "#faf4ed",
      "#575279",
      "#f2e9e1 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279 #9893a5 #b4637a #286983 #ea9d34 #56949f #907aa9 #d7827e #575279",
    ),
  },
  {
    id: "gruvbox",
    label: "Gruvbox",
    dark: p(
      "#282828",
      "#ebdbb2",
      "#282828 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #a89984 #928374 #fb4934 #b8bb26 #fabd2f #83a598 #d3869b #8ec07c #ebdbb2",
    ),
    light: p(
      "#fbf1c7",
      "#3c3836",
      "#fbf1c7 #cc241d #98971a #d79921 #458588 #b16286 #689d6a #7c6f64 #928374 #9d0006 #79740e #b57614 #076678 #8f3f71 #427b58 #3c3836",
    ),
  },
  {
    id: "solarized",
    label: "Solarized",
    dark: p(
      "#002b36",
      "#93a1a1",
      "#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #586e75 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3",
    ),
    light: p(
      "#fdf6e3",
      "#586e75",
      "#073642 #dc322f #859900 #b58900 #268bd2 #d33682 #2aa198 #eee8d5 #002b36 #cb4b16 #586e75 #657b83 #839496 #6c71c4 #93a1a1 #fdf6e3",
    ),
  },
  {
    id: "github",
    label: "GitHub",
    dark: p(
      "#0d1117",
      "#e6edf3",
      "#484f58 #ff7b72 #3fb950 #d29922 #58a6ff #bc8cff #39c5cf #b1bac4 #6e7681 #ffa198 #56d364 #e3b341 #79c0ff #d2a8ff #56d4dd #ffffff",
    ),
    light: p(
      "#ffffff",
      "#1f2328",
      "#24292f #cf222e #116329 #4d2d00 #0969da #8250df #1b7c83 #6e7781 #57606a #a40e26 #1a7f37 #633c01 #218bff #a475f9 #3192aa #8c959f",
    ),
  },
  // the terminals of the Graphite interface colours (core/appColors.ts)
  {
    id: "graphite",
    label: "Graphite",
    dark: p(
      "#1a1a1d",
      "#e4e4e8",
      "#2a2a2e #ff6b6b #6fcf97 #f5c26b #8ea2ff #c79bff #6fd3e0 #d4d4da #5c5c66 #ff8a8a #8ee0ae #ffd58a #aab9ff #d9b6ff #8fe3ee #f4f4f6",
    ),
    light: p(
      "#fbfbfc",
      "#1f1f23",
      "#1f1f23 #d43c3c #1f8a50 #a86b00 #3d51d9 #9b3fc4 #137f91 #6b6b73 #55555d #e5484d #2f9e5f #c27c0e #5266ec #b45bd9 #1c97ab #a1a1aa",
    ),
  },
];

/** The palette for scheme `id` in `scheme`; null = the app's own colours. */
export function termPalette(id: TerminalColors, scheme: Scheme): Palette | null {
  const s = TERM_COLORS.find((c) => c.id === id);
  return (scheme === "dark" ? s?.dark : s?.light) ?? null;
}

/** The inline tokens for a palette (empty values clear them, back to tokens.css). */
export function paletteTokens(pal: Palette | null): Array<[string, string]> {
  return [
    ["--term-bg", pal?.bg ?? ""],
    ["--term-fg", pal?.fg ?? ""],
    ...ANSI.map((key, i): [string, string] => [ansiToken(key), pal?.ansi[i] ?? ""]),
  ];
}
