import { describe, expect, it } from "vitest";
import { newFileLines, parseDiff } from "./diffparse";
import { highlightDiff, highlightFile } from "./highlight";

const classesOf = (toks: Array<[string, string]> | undefined, text: string) =>
  toks?.find(([t]) => t === text)?.[1] ?? null;

describe("highlightDiff", () => {
  it("colours each side of a hunk with the file's language", async () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      " /* a comment",
      "-   still it */ let old = 1;",
      "+   still it */ const next: number = 2;",
      " export {};",
    ].join("\n");
    const lines = parseDiff(diff);
    const toks = await highlightDiff(lines);
    const add = lines.findIndex((d) => d.kind === "add");
    const del = lines.findIndex((d) => d.kind === "del");
    // the comment opened on the context line above still holds on both sides
    expect(classesOf(toks[add], "   still it */")).toBe("syn-comment");
    expect(classesOf(toks[del], "   still it */")).toBe("syn-comment");
    expect(classesOf(toks[add], "const")).toBe("syn-storage");
    expect(classesOf(toks[add], "number")).toBe("syn-type");
    expect(classesOf(toks[del], "let")).toBe("syn-storage");
    expect(classesOf(toks[add], "=")).toBe("syn-operator");
    expect(classesOf(toks[lines.length - 1], "export")).toBe("syn-keyword");
    // file and hunk lines stay plain
    expect(toks[0]).toBeUndefined();
    expect(toks[1]).toBeUndefined();
  });

  it("tells parameters and type members apart", async () => {
    const lines = newFileLines("c.tsx", "const f = ({ text = 1 }: { label?: string }, x) => x;\n");
    const toks = await highlightDiff(lines);
    expect(classesOf(toks[1], "text")).toBe("syn-param");
    expect(classesOf(toks[1], "x")).toBe("syn-param");
    expect(classesOf(toks[1], "label")).toBe("syn-member");
    expect(classesOf(toks[1], "f")).toBeNull();
  });

  it("colours a new file as a whole and leaves unknown languages plain", async () => {
    const json = newFileLines("data.json", '{\n  "a": true\n}\n');
    const toks = await highlightDiff(json);
    expect(classesOf(toks[2], "true")).toBe("syn-constant");
    const txt = await highlightDiff(newFileLines("notes.txt", "hello\n"));
    expect(txt[1]).toBeUndefined();
  });
});

describe("highlightFile", () => {
  it("colours a long file in slices with the same tokens on every line", async () => {
    const line = "const s = f('text', 2); // note\n";
    const text = line.repeat(2000);
    const toks = await highlightFile("big.ts", text);
    expect(toks).not.toBeNull();
    expect(toks?.length).toBe(2001);
    const first = JSON.stringify(toks?.[0]);
    expect(toks?.every((t, i) => i === 2000 || JSON.stringify(t) === first)).toBe(true);
    expect(toks?.[0]?.map(([piece]) => piece).join("")).toBe(line.slice(0, -1));
  });

  it("stops when the result is no longer wanted, and leaves very large files plain", async () => {
    expect(await highlightFile("a.ts", "let a = 1;\n", () => true)).toBeNull();
    expect(await highlightFile("a.ts", "x".repeat(400_000))).toBeNull();
  });
});
