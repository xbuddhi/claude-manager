import { describe, expect, it, vi } from "vitest";
import { createStore } from "./store";

describe("createStore", () => {
  it("merges patches and notifies only on real changes", () => {
    const s = createStore({ a: 1, b: "x" });
    const fn = vi.fn();
    s.subscribe(fn);
    s.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
    s.set({ a: 2 });
    expect(s.get()).toEqual({ a: 2, b: "x" });
    expect(fn).toHaveBeenCalledWith({ a: 2, b: "x" }, { a: 1, b: "x" });
  });

  it("accepts an updater function", () => {
    const s = createStore({ n: 1 });
    s.set((st) => ({ n: st.n + 1 }));
    expect(s.get().n).toBe(2);
  });

  it("select fires only when the selected value changes", () => {
    const s = createStore({ a: 1, b: 1 });
    const fn = vi.fn();
    s.select((st) => st.a, fn);
    s.set({ b: 2 });
    expect(fn).not.toHaveBeenCalled();
    s.set({ a: 5 });
    expect(fn).toHaveBeenCalledWith(5, 1);
  });

  it("select with immediate runs once right away", () => {
    const s = createStore({ a: 1 });
    const fn = vi.fn();
    s.select((st) => st.a, fn, { immediate: true });
    expect(fn).toHaveBeenCalledWith(1, 1);
  });

  it("applies a set made by a listener after the current round, in order", () => {
    const s = createStore({ a: 0, b: 0 });
    const seen: string[] = [];
    s.subscribe((st) => {
      seen.push(`first a=${st.a} b=${st.b}`);
      if (st.a === 1 && st.b === 0) s.set({ b: 1 });
    });
    s.subscribe((st) => {
      seen.push(`second a=${st.a} b=${st.b}`);
    });
    s.set({ a: 1 });
    expect(seen).toEqual(["first a=1 b=0", "second a=1 b=0", "first a=1 b=1", "second a=1 b=1"]);
  });

  it("unsubscribes", () => {
    const s = createStore({ a: 0 });
    const fn = vi.fn();
    const off = s.subscribe(fn);
    off();
    s.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});
