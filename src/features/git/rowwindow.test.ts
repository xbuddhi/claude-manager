import { describe, expect, it } from "vitest";
import { createRowWindow } from "./rowwindow";

function setup() {
  const inner = document.createElement("div");
  const built: number[] = [];
  const win = createRowWindow(inner, (i) => {
    built.push(i);
    const el = document.createElement("div");
    el.textContent = String(i);
    return el;
  });
  const shown = () => [...inner.children].map((c) => Number(c.textContent));
  return { inner, built, win, shown };
}

describe("createRowWindow", () => {
  it("builds only the rows coming into the window, in index order", () => {
    const { built, win, shown } = setup();
    win.update(0, 5);
    expect(shown()).toEqual([0, 1, 2, 3, 4]);
    built.length = 0;
    win.update(3, 8);
    expect(shown()).toEqual([3, 4, 5, 6, 7]);
    expect(built).toEqual([5, 6, 7]);
    built.length = 0;
    win.update(1, 6);
    expect(shown()).toEqual([1, 2, 3, 4, 5]);
    expect(built).toEqual([1, 2]);
  });

  it("rebuilds after a jump or an invalidate", () => {
    const { built, win, shown } = setup();
    win.update(0, 3);
    win.update(10, 12);
    expect(shown()).toEqual([10, 11]);
    built.length = 0;
    win.invalidate();
    win.update(10, 12);
    expect(built).toEqual([10, 11]);
    win.update(0, 0);
    expect(shown()).toEqual([]);
  });
});
