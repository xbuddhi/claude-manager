import { describe, expect, it } from "vitest";
import { overlayHoldsPeek } from "./shell";

describe("peeking sidebar", () => {
  const overlay = (...classes: string[]) => {
    const root = document.createElement("div");
    for (const c of classes) {
      const el = document.createElement("div");
      el.className = c;
      root.append(el);
    }
    return root;
  };

  it("slides away with only the tooltip or the toast stack in the overlay (they stay once created)", () => {
    expect(overlayHoldsPeek(overlay())).toBe(false);
    expect(overlayHoldsPeek(overlay("tooltip", "toast-stack"))).toBe(false);
  });

  it("stays while a menu, popover or dialog is open", () => {
    expect(overlayHoldsPeek(overlay("tooltip", "menu"))).toBe(true);
    expect(overlayHoldsPeek(overlay("popover"))).toBe(true);
    expect(overlayHoldsPeek(overlay("toast-stack", "dlg-backdrop"))).toBe(true);
  });
});
