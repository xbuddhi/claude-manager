import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/api", () => ({
  call: vi.fn(async () => ({ ok: false, error: { code: "internal", message: "no backend in tests" } })),
  listen: vi.fn(async () => () => {}),
}));

const { ansiColors } = await import("./term");

describe("terminal ANSI palette", () => {
  it("reads the 16 colours from --term-* tokens and leaves missing ones to xterm", () => {
    const got = ansiColors((name) =>
      name === "--term-bright-white" ? "#a5a5a5" : name === "--term-red" ? "#f00" : "",
    );
    expect(got).toEqual({ brightWhite: "#a5a5a5", red: "#f00" });
  });
});
