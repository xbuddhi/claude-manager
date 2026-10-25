import { describe, expect, it, vi } from "vitest";
import { store } from "../../core/store";

vi.mock("../../core/api", () => ({
  call: vi.fn(async () => ({ ok: false, error: { code: "internal", message: "no backend in tests" } })),
  listen: vi.fn(async () => () => {}),
}));

const { accepts } = await import("./drop");

describe("folder drop", () => {
  it("is refused behind any modal, including the Settings sheet", () => {
    store.set({ screen: "main", activeTerminal: null });
    expect(accepts()).toBe(true);
    const sheet = document.createElement("div");
    sheet.className = "set-sheet";
    sheet.setAttribute("aria-modal", "true");
    document.body.append(sheet);
    expect(accepts()).toBe(false);
    sheet.remove();
    expect(accepts()).toBe(true);
  });
});
