// Interface colours (settings: appColors): skins for the app itself, each with a dark and a light version
// for the app theme. "claude" keeps the app's own tokens (styles/tokens.css); the others are set as inline
// tokens on <html> by core/theme.ts. A skin can bring its terminal colours: terminals on "default" use them.

import type { AppColors } from "../bindings/AppColors";
import type { Settings } from "../bindings/Settings";
import type { TerminalColors } from "../bindings/TerminalColors";
import type { Scheme } from "./theme";

/** The tokens a skin sets (names without the leading `--`); every skin sets all of them. */
export const SKIN_TOKENS = [
  "bg",
  "side",
  "card",
  "alt",
  "ctrl",
  "ctrl-hover",
  "track",
  "seg-sel",
  "text",
  "muted",
  "border",
  "accent",
  "accent-hover",
  "accent-strong",
  "accent-strong-hover",
  "accent-strong-press",
  "on-accent",
  "danger",
  "warn",
  "menu",
  "hover",
  "git-modified",
  "git-added",
  "git-deleted",
  "git-renamed",
  "git-conflict",
] as const;

export type SkinToken = (typeof SKIN_TOKENS)[number];
export type SkinPalette = Readonly<Record<SkinToken, string>>;

export interface AppSkin {
  id: AppColors;
  label: string;
  dark: SkinPalette | null;
  light: SkinPalette | null;
  /** The terminal colours terminals on "default" use with this skin. */
  terminal: TerminalColors;
}

export const APP_COLORS: readonly AppSkin[] = [
  { id: "claude", label: "Claude", dark: null, light: null, terminal: "default" },
  // Graphite: cool neutral greys with a soft indigo accent; quiet enough to sit on the window glass
  {
    id: "graphite",
    label: "Graphite",
    dark: {
      bg: "#161618",
      side: "#1b1b1d",
      card: "#1f1f22",
      alt: "#242427",
      ctrl: "#2a2a2e",
      "ctrl-hover": "#333337",
      track: "#2a2a2e",
      "seg-sel": "#45454a",
      text: "#ededf0",
      muted: "#9a9aa2",
      border: "#2e2e33",
      accent: "#8ea2ff",
      "accent-hover": "#a3b3ff",
      "accent-strong": "#8ea2ff",
      "accent-strong-hover": "#a3b3ff",
      "accent-strong-press": "#7a8fef",
      "on-accent": "#0d1024",
      danger: "#ff6b6b",
      warn: "#f5b14c",
      menu: "#232326",
      hover: "#28282c",
      "git-modified": "#e8c27a",
      "git-added": "#6fcf97",
      "git-deleted": "#ff7b7b",
      "git-renamed": "#74c0fc",
      "git-conflict": "#ff6b6b",
    },
    light: {
      bg: "#f2f2f4",
      side: "#f7f7f9",
      card: "#ffffff",
      alt: "#f8f8fa",
      ctrl: "#ffffff",
      "ctrl-hover": "#efeff2",
      track: "#e6e6ea",
      "seg-sel": "#ffffff",
      text: "#18181b",
      muted: "#63636b",
      border: "#dedee3",
      accent: "#4a5ee8",
      "accent-hover": "#3a4fd6",
      "accent-strong": "#3d51d9",
      "accent-strong-hover": "#4a5ee8",
      "accent-strong-press": "#3344c2",
      "on-accent": "#ffffff",
      danger: "#e5484d",
      warn: "#c27c0e",
      menu: "#ffffff",
      hover: "#e9e9ed",
      "git-modified": "#b7791f",
      "git-added": "#2f9e5f",
      "git-deleted": "#d93f3f",
      "git-renamed": "#2b7bbf",
      "git-conflict": "#d93f3f",
    },
    terminal: "graphite",
  },
];

const skin = (id: AppColors) => APP_COLORS.find((c) => c.id === id);

/** The palette for skin `id` in `scheme`; null = the app's own colours. */
export function skinPalette(id: AppColors, scheme: Scheme): SkinPalette | null {
  const s = skin(id);
  return (scheme === "dark" ? s?.dark : s?.light) ?? null;
}

/** The inline tokens for a skin palette (empty values clear them, back to tokens.css). */
export function skinTokens(pal: SkinPalette | null): Array<[string, string]> {
  return SKIN_TOKENS.map((name): [string, string] => [`--${name}`, pal?.[name] ?? ""]);
}

/** The terminal colours in use: the chosen scheme, or on "default" the skin's own. */
export function terminalColorsFor(s: Pick<Settings, "appColors" | "terminalColors">): TerminalColors {
  return s.terminalColors === "default" ? (skin(s.appColors)?.terminal ?? "default") : s.terminalColors;
}
