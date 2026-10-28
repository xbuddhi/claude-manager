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
