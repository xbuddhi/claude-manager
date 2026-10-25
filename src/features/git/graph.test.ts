import { describe, expect, it } from "vitest";
import { type GraphSeg, graphSvg, graphWidth, laneX, layoutGraph } from "./graph";

// Expected rows worked out by hand from MacUI.cs GitGraph.Layout.
const seg = (x1: number, y1: 0 | 1 | 2, x2: number, y2: 0 | 1 | 2, color: number): GraphSeg => ({
  x1,
  y1,
  x2,
  y2,
  color,
});

describe("layoutGraph", () => {
  it("draws a linear history in one lane", () => {
    const g = layoutGraph(["c", "b", "a"], ["b", "a", ""], [true, false, false]);
    expect(g.maxLanes).toBe(1);
    expect(g.rows).toEqual([
      { lane: 0, color: 0, lanes: 1, merge: false, head: true, segs: [seg(0, 1, 0, 2, 0)] },
      { lane: 0, color: 0, lanes: 1, merge: false, head: false, segs: [seg(0, 0, 0, 1, 0), seg(0, 1, 0, 2, 0)] },
      { lane: 0, color: 0, lanes: 1, merge: false, head: false, segs: [seg(0, 0, 0, 1, 0)] },
    ]);
  });

  it("branches a merge's second parent off and joins it back", () => {
    // m merges x into the line a <- m; x branched from a; r is the root
    const g = layoutGraph(["m", "x", "a", "r"], ["a x", "a", "r", ""]);
    expect(g.maxLanes).toBe(2);
    expect(g.rows[0]).toEqual({
      lane: 0,
      color: 0,
      lanes: 2,
      merge: true,
      head: false,
      segs: [seg(0, 1, 0, 2, 0), seg(0, 1, 1, 2, 1)],
    });
    expect(g.rows[1]).toEqual({
      lane: 1,
      color: 1,
      lanes: 2,
      merge: false,
      head: false,
      segs: [seg(0, 0, 0, 2, 0), seg(1, 0, 1, 1, 1), seg(1, 1, 0, 2, 0)],
    });
    expect(g.rows[2]?.segs).toEqual([seg(0, 0, 0, 1, 0), seg(0, 1, 0, 2, 0)]);
    expect(g.rows[3]?.segs).toEqual([seg(0, 0, 0, 1, 0)]);
  });

  it("gives every parent of an octopus merge its own lane and colour", () => {
    const g = layoutGraph(["o", "c", "b", "a"], ["a b c", "a", "a", ""]);
    expect(g.maxLanes).toBe(3);
    expect(g.rows.map((r) => [r.lane, r.color, r.lanes, r.merge])).toEqual([
      [0, 0, 3, true],
      [2, 2, 3, false],
      [1, 1, 2, false],
      [0, 0, 1, false],
    ]);
    expect(g.rows[0]?.segs).toEqual([seg(0, 1, 0, 2, 0), seg(0, 1, 1, 2, 1), seg(0, 1, 2, 2, 2)]);
    expect(g.rows[1]?.segs).toEqual([seg(0, 0, 0, 2, 0), seg(1, 0, 1, 2, 1), seg(2, 0, 2, 1, 2), seg(2, 1, 0, 2, 0)]);
    expect(g.rows[2]?.segs).toEqual([seg(0, 0, 0, 2, 0), seg(1, 0, 1, 1, 1), seg(1, 1, 0, 2, 0)]);
  });

  it("starts a new lane for a second branch tip", () => {
    const g = layoutGraph(["t1", "t2", "p"], ["p", "p", ""]);
    expect(g.rows[1]).toEqual({
      lane: 1,
      color: 1,
      lanes: 2,
      merge: false,
      head: false,
      segs: [seg(0, 0, 0, 2, 0), seg(1, 1, 0, 2, 0)],
    });
    expect(g.rows[2]?.lane).toBe(0);
  });

  it("handles an empty history", () => {
    expect(layoutGraph([], [])).toEqual({ rows: [], maxLanes: 1 });
  });
});

describe("graph drawing", () => {
  it("places lanes like the Windows app", () => {
    expect(laneX(0)).toBe(22);
    expect(laneX(2)).toBe(50);
    expect(graphWidth(0)).toBe(38);
    expect(graphWidth(3)).toBe(66);
  });

  it("draws curves between lanes, rings for merges and a dot in a ring for HEAD", () => {
    const g = layoutGraph(["m", "x", "a"], ["a x", "a", ""], [true, false, false]);
    const head = graphSvg(g.rows[0] as never, 60);
    expect(head).toContain('<path d="M22 17L22 34" stroke="var(--lane-1)"/>');
    expect(head).toContain('<path d="M22 17C22 25.5 36 25.5 36 34" stroke="var(--lane-2)"/>');
    expect(head).toContain('r="5.5" stroke="var(--lane-1)" fill="none"');
    expect(head).toContain(`r="${5.5 / 2.2}" fill="var(--lane-1)"`);
    const plain = graphSvg(g.rows[2] as never, 60);
    expect(plain).toContain('r="4" fill="var(--lane-1)"');
  });
});
