import { describe, expect, it } from "vitest";
import { ANSI, paletteTokens, TERM_COLORS, termPalette } from "./termColors";

describe("terminal colours", () => {
  it("every scheme has both versions with all 16 ANSI colours", () => {
    for (const s of TERM_COLORS.filter((c) => c.id !== "default")) {
      for (const pal of [s.dark, s.light]) {
        expect(pal?.ansi).toHaveLength(ANSI.length);
        for (const c of [pal?.bg, pal?.fg, ...(pal?.ansi ?? [])]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("default clears the inline tokens", () => {
    expect(termPalette("default", "dark")).toBeNull();
    expect(paletteTokens(null).every(([, v]) => v === "")).toBe(true);
    expect(paletteTokens(termPalette("gruvbox", "light"))).toContainEqual(["--term-bright-black", "#928374"]);
  });
});
