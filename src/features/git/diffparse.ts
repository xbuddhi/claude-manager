// Unified diff to display lines, ported from the Windows app's DiffView (ShowDiff / ShowNewFile).
// Pure: no DOM, so it is tested directly.

export type LineKind = "context" | "add" | "del" | "hunk" | "file" | "meta";

export interface DiffLine {
  kind: LineKind;
  /** Old / new line numbers; 0 = none. */
  old: number;
  new: number;
  text: string;
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
