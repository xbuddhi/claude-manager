import { describe, expect, it, vi } from "vitest";
import { createList, SelectionModel, type SelRow } from "./list";

// a heading row ("h") between selectable rows, like the sidebar's section labels
const rows = (...keys: string[]): SelRow[] => keys.map((key) => ({ key, selectable: key !== "h" }));

function model(multi = true) {
  const m = new SelectionModel(multi);
  m.setRows(rows("a", "h", "b", "c", "d"));
  return m;
}

describe("SelectionModel clicks", () => {
  it("selects one row on a plain click and ignores rows that cannot be selected", () => {
    const m = model();
    expect(m.click("b")).toBe(true);
    expect(m.selected).toEqual(["b"]);
    expect(m.click("h")).toBe(false);
    expect(m.selected).toEqual(["b"]);
    expect(m.click("b")).toBe(false);
  });

  it("toggles with Ctrl/Cmd and extends ranges with Shift, skipping headings", () => {
    const m = model();
    m.click("d");
    m.click("b", { toggle: true });
    expect(m.selected).toEqual(["b", "d"]);
    m.click("b", { toggle: true });
    expect(m.selected).toEqual(["d"]);
    m.click("a");
    m.click("c", { range: true });
    expect(m.selected).toEqual(["a", "b", "c"]);
    // the anchor stays at "a", so a second shift-click re-ranges from there
    m.click("b", { range: true });
    expect(m.selected).toEqual(["a", "b"]);
  });

  it("adds a range to the selection with Ctrl/Cmd+Shift", () => {
    const m = model();
    m.click("d");
    m.click("a", { toggle: true });
    m.click("b", { toggle: true, range: true });
    expect(m.selected).toEqual(["a", "b", "d"]);
  });

  it("selects a single row in a single-select model whatever the modifiers", () => {
    const m = model(false);
    m.click("a");
    m.click("c", { toggle: true });
    expect(m.selected).toEqual(["c"]);
    m.click("d", { range: true });
    expect(m.selected).toEqual(["d"]);
    expect(m.selectAll()).toBe(false);
  });

  it("keeps a multi-selection on right-click of a selected row and replaces it otherwise", () => {
    const m = model();
    m.click("a");
    m.click("c", { range: true });
    expect(m.contextClick("b")).toBe(false);
    expect(m.selected).toEqual(["a", "b", "c"]);
    expect(m.contextClick("d")).toBe(true);
    expect(m.selected).toEqual(["d"]);
  });

  it("selects every selectable row", () => {
    const m = model();
    m.selectAll();
    expect(m.selected).toEqual(["a", "b", "c", "d"]);
  });
});

describe("SelectionModel keyboard", () => {
  it("moves past rows that cannot be selected", () => {
    const m = model();
    m.move("next");
    expect(m.selected).toEqual(["a"]);
    m.move("next");
    expect(m.selected).toEqual(["b"]);
    m.move("prev");
    expect(m.selected).toEqual(["a"]);
    m.move("prev");
    expect(m.selected).toEqual(["a"]);
  });

  it("starts from the end when moving up with nothing focused", () => {
    const m = model();
    m.move("prev");
    expect(m.selected).toEqual(["d"]);
  });

  it("jumps to the ends and by pages, clamped", () => {
    const m = model();
    m.move("last");
    expect(m.focus).toBe("d");
    m.move("first");
    expect(m.focus).toBe("a");
    m.move({ page: 3 });
    expect(m.focus).toBe("c");
    m.move({ page: 10 });
    expect(m.focus).toBe("d");
    // lands on the heading, so it keeps going up to the next selectable row
    m.move({ page: -3 });
    expect(m.focus).toBe("a");
  });

  it("extends from the anchor with Shift", () => {
    const m = model();
    m.click("b");
    m.move("next", true);
    m.move("next", true);
    expect(m.selected).toEqual(["b", "c", "d"]);
    m.move("prev", true);
    expect(m.selected).toEqual(["b", "c"]);
  });
});

describe("SelectionModel across refreshes", () => {
  it("keeps the selection by key and drops rows that are gone", () => {
    const m = model();
    m.click("b");
    m.click("d", { toggle: true });
    expect(m.setRows(rows("d", "x", "b"))).toBe(false);
    expect(m.selected).toEqual(["d", "b"]);
    expect(m.setRows(rows("x", "b"))).toBe(true);
    expect(m.selected).toEqual(["b"]);
    expect(m.focus).toBe("b");
  });

  it("drops a selected row that became unselectable", () => {
    const m = new SelectionModel();
    m.setRows(rows("a", "b"));
    m.click("a");
    expect(
      m.setRows([
        { key: "a", selectable: false },
        { key: "b", selectable: true },
      ]),
    ).toBe(true);
    expect(m.selected).toEqual([]);
  });
});

describe("list view", () => {
  const make = () => {
    const update = vi.fn();
    const list = createList<{ k: string }>({
      label: "Test",
      key: (r) => r.k,
      height: () => 20,
      create: () => document.createElement("div"),
      update,
    });
    document.body.append(list.el);
    list.setRows(["a", "b", "c"].map((k) => ({ k })));
    return { list, update };
  };

  it("looks rows up by key", () => {
    const { list } = make();
    expect(list.indexOfKey("b")).toBe(1);
    expect(list.indexOfKey("x")).toBe(-1);
    expect(list.rowByKey("c")).toEqual({ k: "c" });
    expect(list.rowByKey("x")).toBeUndefined();
  });

  it("does nothing when given the very same rows", () => {
    const { list, update } = make();
    const rows = list.rows();
    update.mockClear();
    list.setRows([...rows]);
    expect(update).not.toHaveBeenCalled();
    list.setRows([...rows.slice(0, 2), { k: "c" }]);
    expect(update).toHaveBeenCalled();
  });

  it("only places rows on scroll and updates their content on refresh", async () => {
    const { list, update } = make();
    expect(update).toHaveBeenCalledTimes(3);
    list.el.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(update).toHaveBeenCalledTimes(3);
    list.refresh();
    expect(update).toHaveBeenCalledTimes(6);
  });
});
