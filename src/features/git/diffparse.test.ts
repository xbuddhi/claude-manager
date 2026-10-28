import { describe, expect, it } from "vitest";
import {
  type DiffLine,
  diffToText,
  displayText,
  MAX_NEW_FILE_LINES,
  markWords,
  newFileLines,
  parseDiff,
  splitRows,
  widestLine,
  wordMarks,
} from "./diffparse";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 3b18e51..a9c2f4d 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ function main() {",
  " keep one",
  "-old line",
  "+new line",
  "+\tadded",
  " keep two",
  "\\ No newline at end of file",
  "@@ -40 +41,2 @@",
  " last",
  "+tail",
  "",
].join("\n");

describe("parseDiff", () => {
  it("numbers old and new lines from the hunk headers and hides header noise", () => {
    const lines = parseDiff(DIFF);
    expect(lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ["file", 0, 0, "src/app.ts"],
      ["hunk", 0, 0, "@@ -10,4 +10,5 @@ function main() {"],
      ["context", 10, 10, "keep one"],
      ["del", 11, 0, "old line"],
      ["add", 0, 11, "new line"],
      ["add", 0, 12, "\tadded"],
      ["context", 12, 13, "keep two"],
      ["meta", 0, 0, "\\ No newline at end of file"],
      ["hunk", 0, 0, "@@ -40 +41,2 @@"],
      ["context", 40, 41, "last"],
      ["add", 0, 42, "tail"],
    ]);
  });

  it("keeps the commit header of git show and handles CRLF, renames and binaries", () => {
    const show = [
      "commit abc",
      "Author: A <a@x>",
      "",
      "    Subject",
      "",
      " a.png | Bin 0 -> 10 bytes",
      "diff --git a/old name.txt b/new name.txt",
      "similarity index 90%",
      "rename from old name.txt",
      "rename to new name.txt",
      "diff --git a/a.png b/a.png",
      "new file mode 100644",
      "Binary files /dev/null and b/a.png differ",
    ].join("\r\n");
    const lines = parseDiff(show);
    expect(lines.slice(0, 6).every((l) => l.kind === "meta")).toBe(true);
    expect(lines.slice(6).map((l) => [l.kind, l.text])).toEqual([
      ["file", "new name.txt"],
      ["file", "a.png"],
      ["meta", "Binary file not shown"],
    ]);
  });

  it("gives nothing for empty output, trimming blank trailing meta lines", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("\n\n")).toEqual([]);
  });

  it("caps very long diffs", () => {
    const big = `diff --git a/a b/a\n@@ -1 +1,50000 @@\n${"+x\n".repeat(50_000)}`;
    expect(parseDiff(big).length).toBe(40_001);
  });
});

describe("new files and copying", () => {
  it("shows a new file as added lines", () => {
    const lines = newFileLines("docs/a.md", "one\r\ntwo\n");
    expect(lines.map((l) => [l.kind, l.new, l.text])).toEqual([
      ["file", 0, "docs/a.md  (new file)"],
      ["add", 1, "one"],
      ["add", 2, "two"],
    ]);
    expect(newFileLines("e", "").length).toBe(2);
    expect(newFileLines("big", "x\n".repeat(MAX_NEW_FILE_LINES + 10)).length).toBe(MAX_NEW_FILE_LINES + 1);
  });

  it("copies with +/-/space prefixes and measures tabs as four spaces", () => {
    const lines = parseDiff(DIFF).slice(0, 6);
    expect(diffToText(lines)).toBe(
      "src/app.ts\n@@ -10,4 +10,5 @@ function main() {\n keep one\n-old line\n+new line\n+\tadded\n",
    );
    expect(displayText("\tx")).toBe("    x");
    expect(widestLine(newFileLines("p", "\tabc"))).toBe(Math.max("p  (new file)".length, 8));
  });
});

describe("word marks", () => {
  const cut = (text: string, marks: Array<[number, number]> | undefined) =>
    (marks ?? []).map(([a, b]) => text.slice(a, b));

  it("marks only the words that changed", () => {
    const a = "// from Privy. Telegram shows once the Privy dashboard has it";
    const b = "// from Privy. Apple and Telegram show when their flags say so";
    const m = wordMarks(a, b);
    expect(m).not.toBeNull();
    expect(cut(a, m?.a)).toEqual(["shows once the Privy dashboard has it"]);
    expect(cut(b, m?.b)).toEqual(["Apple and", "show when their flags say so"]);
  });

  it("leaves lines with almost nothing in common unmarked", () => {
    expect(wordMarks("const a = 1;", "return fetchEverything(now)")).toBeNull();
  });

  it("pairs removed and added lines in a block and marks them", () => {
    const lines = parseDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "@@ -1,2 +1,3 @@",
        "-let a = 1;",
        "-gone();",
        "+let a = 2;",
        "+kept();",
        "+extra();",
      ].join("\n"),
    );
    markWords(lines);
    const del = lines[2] as DiffLine;
    const add = lines[4] as DiffLine;
    expect(cut(del.text, del.marks)).toEqual(["1"]);
    expect(cut(add.text, add.marks)).toEqual(["2"]);
    expect(splitRows(lines)).toEqual([
      { span: 0 },
      { span: 1 },
      { left: 2, right: 4 },
      { left: 3, right: 5 },
      { left: undefined, right: 6 },
    ]);
  });
});
