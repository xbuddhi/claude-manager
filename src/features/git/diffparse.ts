// Unified diff to display lines, ported from the Windows app's DiffView (ShowDiff / ShowNewFile).
// Pure: no DOM, so it is tested directly.

export type LineKind = "context" | "add" | "del" | "hunk" | "file" | "meta";

export interface DiffLine {
  kind: LineKind;
  /** Old / new line numbers; 0 = none. */
  old: number;
  new: number;
  text: string;
  /** Changed parts of a removed or added line next to its counterpart: [from, to) offsets in `text`. */
  marks?: Array<[number, number]>;
}

/** One row of the side-by-side view: indexes into the lines; `span` = across both sides (file, hunk, meta). */
export interface SplitRow {
  span?: number;
  /** Old side; missing = filler. */
  left?: number;
  /** New side; missing = filler. */
  right?: number;
}

/** Lines shown at most of a diff, and of a new file. */
export const MAX_DIFF_LINES = 40_000;
export const MAX_NEW_FILE_LINES = 20_000;

/** git header lines that say nothing the file bar does not. */
const NOISE = ["index ", "--- ", "+++ ", "new file", "deleted file", "similarity", "rename ", "old mode", "new mode"];

const line = (kind: LineKind, text: string, old = 0, nw = 0): DiffLine => ({ kind, old, new: nw, text });

/** Parses `git diff` / `git show` output. An empty result means "nothing to show". */
export function parseDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0;
  let n = 0;
  let inDiff = false;
  for (const raw of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (out.length > MAX_DIFF_LINES) break;
    if (raw.startsWith("diff --git ")) {
      inDiff = true;
      const parts = raw.slice(11).split(" b/");
      out.push(line("file", parts.length > 1 ? (parts[parts.length - 1] as string) : raw));
      continue;
    }
    // before the first file: commit header and --stat of git show
    if (!inDiff) {
      out.push(line("meta", raw));
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(raw);
      if (m) {
        o = Number(m[1]);
        n = Number(m[2]);
      }
      out.push(line("hunk", raw));
      continue;
    }
    if (NOISE.some((p) => raw.startsWith(p))) continue;
    if (raw.startsWith("Binary files")) out.push(line("meta", "Binary file not shown"));
    else if (raw.startsWith("+")) out.push(line("add", raw.slice(1), 0, n++));
    else if (raw.startsWith("-")) out.push(line("del", raw.slice(1), o++, 0));
    else if (raw.startsWith("\\")) out.push(line("meta", raw));
    else if (raw.length > 0) out.push(line("context", raw.slice(1), o++, n++)); // context lines start with a space
  }
  while (out.length > 0 && out[out.length - 1]?.kind === "meta" && !out[out.length - 1]?.text.trim()) out.pop();
  return out;
}

/** A new file shown as added lines under a file bar. */
export function newFileLines(path: string, text: string): DiffLine[] {
  const out: DiffLine[] = [line("file", `${path}  (new file)`)];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // a final newline ends the last line; it does not start another
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length && i < MAX_NEW_FILE_LINES; i++) out.push(line("add", lines[i] as string, 0, i + 1));
  return out;
}

/** Tabs as four spaces, as the diff view draws them. */
export function displayText(text: string): string {
  return text.replaceAll("\t", "    ");
}

/** The whole diff as text with +/-/space prefixes (Ctrl/Cmd+C with nothing selected). */
export function diffToText(lines: readonly DiffLine[]): string {
  const prefix: Record<LineKind, string> = { add: "+", del: "-", context: " ", hunk: "", file: "", meta: "" };
  return lines.map((d) => `${prefix[d.kind]}${d.text}\n`).join("");
}

/** Longest displayed line in characters (sets the horizontal scroll width). */
export function widestLine(lines: readonly DiffLine[]): number {
  let max = 0;
  for (const d of lines)
    max = Math.max(max, displayText(d.text).length + (d.kind === "file" || d.kind === "meta" ? 0 : 1));
  return max;
}

/** Lines longer than this, or pairs with more words than this between them, get no word marks. */
const MARK_MAX_CHARS = 1000;
const MARK_MAX_CELLS = 40_000;
/** Work for a whole diff: line pairs compared, and their words multiplied together. The rest stays unmarked. */
export const MARK_MAX_PAIRS = 5000;
const MARK_MAX_TOTAL_CELLS = 2_000_000;

type Marks = { a: Array<[number, number]>; b: Array<[number, number]> };

/** Words and single symbols, with their offsets (spaces are not compared). */
function words(text: string): Array<[string, number]> {
  return [...text.matchAll(/\w+|[^\w\s]/g)].map((m) => [m[0], m.index ?? 0]);
}

/**
 * The parts of `a` and `b` that differ, by words (longest common subsequence), as [from, to) offsets.
 * Null when the lines are too long to compare or have almost nothing in common: then the whole line is the
 * change, and marking every word in it says nothing more.
 */
export function wordMarks(a: string, b: string): Marks | null {
  return compareWords(a, b)[0];
}

/** wordMarks, and the cells compared (the work done). */
function compareWords(a: string, b: string): [Marks | null, number] {
  if (a.length > MARK_MAX_CHARS || b.length > MARK_MAX_CHARS) return [null, 0];
  const wa = words(a);
  const wb = words(b);
  const n = wa.length;
  const m = wb.length;
  if (n * m > MARK_MAX_CELLS) return [null, 0];
  // lcs[i][j]: common words of wa[i..] and wb[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint16Array;
    const next = lcs[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        wa[i]?.[0] === wb[j]?.[0] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const keptA = new Array<boolean>(n).fill(false);
  const keptB = new Array<boolean>(m).fill(false);
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (wa[i]?.[0] === wb[j]?.[0]) {
      keptA[i++] = true;
      keptB[j++] = true;
      common++;
    } else if ((lcs[i + 1]?.[j] as number) >= (lcs[i]?.[j + 1] as number)) i++;
    else j++;
  }
  if (common * 3 < Math.min(n, m)) return [null, n * m];
  return [{ a: ranges(a, wa, keptA), b: ranges(b, wb, keptB) }, n * m];
}

/** The offsets of the words not kept, joined into ranges; only spaces between two changed words join them. */
function ranges(text: string, w: Array<[string, number]>, kept: boolean[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  w.forEach(([word, at], i) => {
    if (kept[i]) return;
    const last = out[out.length - 1];
    if (last && !text.slice(last[1], at).trim()) last[1] = at + word.length;
    else out.push([at, at + word.length]);
  });
  return out;
}

/**
 * Marks the changed words of each removed line and the added line in its place (the n-th of each block).
 * A huge diff gets marks only up to MARK_MAX_PAIRS pairs / MARK_MAX_TOTAL_CELLS of work.
 */
export function markWords(lines: DiffLine[]): void {
  let pairsDone = 0;
  let cells = 0;
  for (let i = 0; i < lines.length; ) {
    if (lines[i]?.kind !== "del") {
      i++;
      continue;
    }
    const delStart = i;
    while (lines[i]?.kind === "del") i++;
    const addStart = i;
    while (lines[i]?.kind === "add") i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      if (pairsDone >= MARK_MAX_PAIRS || cells >= MARK_MAX_TOTAL_CELLS) return;
      pairsDone++;
      const d = lines[delStart + k] as DiffLine;
      const a = lines[addStart + k] as DiffLine;
      const [marks, work] = compareWords(d.text, a.text);
      cells += work;
      if (!marks) continue;
      d.marks = marks.a;
      a.marks = marks.b;
    }
  }
}

/** The lines as side-by-side rows: removed lines face the added lines that replace them, the rest a filler. */
export function splitRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const kind = lines[i]?.kind;
    if (kind === "context") {
      rows.push({ left: i, right: i });
      i++;
    } else if (kind === "del" || kind === "add") {
      const dels: number[] = [];
      const adds: number[] = [];
      while (lines[i]?.kind === "del") dels.push(i++);
      while (lines[i]?.kind === "add") adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] });
    } else {
      rows.push({ span: i });
      i++;
    }
  }
  return rows;
}
