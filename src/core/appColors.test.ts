import { describe, expect, it } from "vitest";
import { APP_COLORS, SKIN_TOKENS, skinPalette, skinTokens, terminalColorsFor } from "./appColors";
import { TERM_COLORS } from "./termColors";

describe("interface colours", () => {
  it("every skin sets every token in both versions", () => {
    for (const s of APP_COLORS.filter((c) => c.id !== "claude")) {
      for (const pal of [s.dark, s.light]) {
        expect(Object.keys(pal ?? {}).sort()).toEqual([...SKIN_TOKENS].sort());
        for (const c of Object.values(pal ?? {})) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("text on accent fills and muted text on cards stay readable (4.5:1)", () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
      return (hi + 0.05) / (lo + 0.05);
    };
    for (const s of APP_COLORS) {
      for (const pal of [s.dark, s.light]) {
        if (!pal) continue;
        expect(contrast(pal["accent-strong"], pal["on-accent"]), `${s.id} accent`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(pal.muted, pal.card), `${s.id} muted`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("each skin's terminal colours exist", () => {
    for (const s of APP_COLORS) expect(TERM_COLORS.map((c) => c.id)).toContain(s.terminal);
  });

  it("claude clears the inline tokens", () => {
    expect(skinPalette("claude", "dark")).toBeNull();
    expect(skinTokens(null).every(([, v]) => v === "")).toBe(true);
    expect(skinTokens(skinPalette("graphite", "dark"))).toContainEqual(["--accent", "#8ea2ff"]);
  });

  it("default terminals follow the skin; a chosen scheme wins", () => {
    expect(terminalColorsFor({ appColors: "claude", terminalColors: "default" })).toBe("default");
    expect(terminalColorsFor({ appColors: "graphite", terminalColors: "default" })).toBe("graphite");
    expect(terminalColorsFor({ appColors: "graphite", terminalColors: "gruvbox" })).toBe("gruvbox");
  });
});
