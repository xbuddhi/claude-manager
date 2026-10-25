// Commit graph lanes (VS Code style), a 1:1 port of the Windows app's GitGraph.Layout. Commits come newest
// first; each lane waits for one commit hash. The first parent continues a commit's lane, other parents
// branch off to free lanes with new colours; trailing empty lanes are trimmed.

/** A line inside one row. Lanes are x; y is 0 = top of the row, 1 = the dot (middle), 2 = bottom. */
export interface GraphSeg {
  x1: number;
  y1: 0 | 1 | 2;
  x2: number;
  y2: 0 | 1 | 2;
  /** Palette index (wraps around the palette). */
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  /** Lanes this row uses (its width). */
  lanes: number;
  merge: boolean;
  head: boolean;
  segs: GraphSeg[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Widest row, at least 1. */
  maxLanes: number;
}

/** `parents` are space-separated hashes (git's %P); `heads[i]` marks the checked-out commit. */
export function layoutGraph(
  hashes: readonly string[],
  parents: readonly string[],
  heads?: readonly boolean[],
): GraphLayout {
  const lanes: Array<string | null> = [];
  const colors: number[] = [];
  let nextColor = 0;
  let maxLanes = 1;
  const rows: GraphRow[] = [];
  const freeLane = (): number => {
    let t = lanes.indexOf(null);
    if (t < 0) {
      t = lanes.length;
      lanes.push(null);
      colors.push(0);
    }
    return t;
  };

  hashes.forEach((c, i) => {
    const p = (parents[i] ?? "").trim();
    const ps = p ? p.split(" ") : [];
    let lane = lanes.indexOf(c);
    if (lane < 0) {
      // a branch tip nobody pointed at yet: take a free lane
      lane = freeLane();
      colors[lane] = nextColor++;
    }
    const color = colors[lane] ?? 0;
    const row: GraphRow = { lane, color, lanes: 0, merge: ps.length > 1, head: !!heads?.[i], segs: [] };
    // top half: lanes coming in; ones waiting for this commit bend into the dot
    lanes.forEach((h, k) => {
      if (h === null) return;
      if (h === c) row.segs.push({ x1: k, y1: 0, x2: lane, y2: 1, color: colors[k] ?? 0 });
      else row.segs.push({ x1: k, y1: 0, x2: k, y2: 2, color: colors[k] ?? 0 });
    });
    for (let k = 0; k < lanes.length; k++) if (lanes[k] === c) lanes[k] = null; // merged into this commit
    // bottom half: first parent continues this lane, other parents branch off
    const first = ps[0];
    if (first !== undefined) {
      const j = lanes.indexOf(first);
      if (j >= 0 && j !== lane) {
        row.segs.push({ x1: lane, y1: 1, x2: j, y2: 2, color: colors[j] ?? 0 }); // joins a lane already waiting for it
      } else {
        lanes[lane] = first;
        colors[lane] = color;
        row.segs.push({ x1: lane, y1: 1, x2: lane, y2: 2, color });
      }
      for (const other of ps.slice(1)) {
        let t = lanes.indexOf(other);
        if (t < 0) {
          t = freeLane();
          lanes[t] = other;
          colors[t] = nextColor++;
        }
        row.segs.push({ x1: lane, y1: 1, x2: t, y2: 2, color: colors[t] ?? 0 });
      }
    }
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
      colors.pop();
    }
    let used = 0;
    for (const s of row.segs) used = Math.max(used, Math.max(s.x1, s.x2) + 1);
    row.lanes = Math.max(used, lane + 1);
    maxLanes = Math.max(maxLanes, row.lanes);
    rows.push(row);
  });
  return { rows, maxLanes };
}

/** Lanes drawn at most; wider graphs are cut off. */
export const MAX_DRAWN_LANES = 8;
export const ROW_HEIGHT = 34;
const PALETTE = 5;

/** x of a lane's centre in the row's graph cell. */
export function laneX(lane: number): number {
  return 16 + lane * 14 + 6;
}

/** Width of the graph cell for `lanes` lanes (text starts after it). */
export function graphWidth(lanes: number): number {
  return laneX(Math.max(1, lanes)) + 2;
}

/** One row of the graph as SVG markup (only numbers and fixed names go in, so it is safe markup). */
export function graphSvg(row: GraphRow, width: number, height = ROW_HEIGHT): string {
  const yOf = (y: 0 | 1 | 2) => (y === 0 ? 0 : y === 1 ? height / 2 : height);
  const stroke = (c: number) => `var(--lane-${(c % PALETTE) + 1})`;
  const parts: string[] = [];
  for (const s of row.segs) {
    const x1 = laneX(s.x1);
    const x2 = laneX(s.x2);
    const y1 = yOf(s.y1);
    const y2 = yOf(s.y2);
    const d =
      x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    parts.push(`<path d="${d}" stroke="${stroke(s.color)}"/>`);
  }
  const cx = laneX(row.lane);
  const cy = height / 2;
  const r = row.head ? 5.5 : 4;
  const c = stroke(row.color);
  parts.push(`<circle class="git-halo" cx="${cx}" cy="${cy}" r="${r + 1.5}"/>`);
  if (row.merge || row.head) {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" stroke="${c}" fill="none"/>`);
    if (row.head) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r / 2.2}" fill="${c}" stroke="none"/>`);
  } else parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" stroke="none"/>`);
  return `<svg class="git-graph" style="width:${width}px;height:${height}px" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join("")}</svg>`;
}
