import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/api", () => ({
  call: vi.fn(async () => ({ ok: false, error: { code: "internal", message: "no backend in tests" } })),
  listen: vi.fn(async () => () => {}),
}));

const { ansiColors, mixHex } = await import("./term");

describe("terminal ANSI palette", () => {
  it("reads the 16 colours from --term-* tokens and leaves missing ones to xterm", () => {
    const got = ansiColors((name) =>
      name === "--term-bright-white" ? "#a5a5a5" : name === "--term-red" ? "#f00" : "",
    );
    expect(got).toEqual({ brightWhite: "#a5a5a5", red: "#f00" });
  });
});

describe("mixHex", () => {
  it("tints a colour towards another", () => {
    expect(mixHex("#000000", "#ffffff", 0.05)).toBe("#0d0d0d");
    expect(mixHex("#141416", "#e6e6ea", 0)).toBe("#141416");
  });

  it("keeps a colour it cannot read", () => {
    expect(mixHex("rgb(0 0 0)", "#ffffff", 0.5)).toBe("rgb(0 0 0)");
  });
});
