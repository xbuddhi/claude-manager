import { describe, expect, it } from "vitest";
import { jsonEqual, keepEqual, keepIfEqual } from "./equal";

describe("jsonEqual", () => {
  it("compares JSON values by structure", () => {
    expect(jsonEqual({ a: [1, { b: "x" }], c: null }, { c: null, a: [1, { b: "x" }] })).toBe(true);
    expect(jsonEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(jsonEqual({ a: 1 }, { b: 1 })).toBe(false);
    expect(jsonEqual([], {})).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual("1", 1)).toBe(false);
  });
});

describe("keepEqual", () => {
  it("keeps the old value of every unchanged key and the old object when nothing changed", () => {
    const prev = { pinned: ["a"], groups: [{ name: "G", folders: ["b"] }], theme: "dark" };
    const same = keepEqual(prev, { pinned: ["a"], groups: [{ name: "G", folders: ["b"] }], theme: "dark" });
    expect(same).toBe(prev);
    const next = keepEqual(prev, { pinned: ["a", "c"], groups: [{ name: "G", folders: ["b"] }], theme: "dark" });
    expect(next).not.toBe(prev);
    expect(next.pinned).toEqual(["a", "c"]);
    expect(next.groups).toBe(prev.groups);
  });

  it("notices keys that were added or removed", () => {
    const prev: Record<string, unknown> = { a: 1, b: 2 };
    expect(keepEqual(prev, { a: 1 })).toEqual({ a: 1 });
    expect(keepEqual(prev, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe("keepIfEqual", () => {
  it("returns the old value when equal", () => {
    const prev = [{ dir: "/a", name: "a" }];
    expect(keepIfEqual(prev, [{ dir: "/a", name: "a" }])).toBe(prev);
    const next = [{ dir: "/a", name: "b" }];
    expect(keepIfEqual(prev, next)).toBe(next);
  });
});
