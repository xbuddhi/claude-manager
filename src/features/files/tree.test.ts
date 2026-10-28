import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../bindings/FileEntry";
import type { FolderListing } from "../../bindings/FolderListing";
import { absPath, canMoveInto, flatten, isUnder, parentRel, renamed } from "./tree";

const dir = (name: string): FileEntry => ({ name, dir: true, link: false, ignored: false, size: 0 });
const file = (name: string): FileEntry => ({ name, dir: false, link: false, ignored: false, size: 1 });
const listing = (entries: FileEntry[], more = 0): FolderListing => ({ entries, more });

describe("flatten", () => {
  const listings = new Map([
    ["", listing([dir("src"), dir("docs"), file("a.md")])],
    ["src", listing([dir("ui"), file("main.ts")], 2)],
    ["src/ui", listing([file("x.ts")])],
  ]);

  it("lists open folders' entries under them, deeper", () => {
    const rows = flatten(listings, new Set(["src", "src/ui", "docs"]));
    expect(rows.map((r) => [r.key, r.depth, r.kind === "entry" && r.open])).toEqual([
      ["src", 0, true],
      ["src/ui", 1, true],
      ["src/ui/x.ts", 2, false],
      ["src/main.ts", 1, false],
      ["src/\0more", 1, false],
      // open but not loaded yet: shown closed
      ["docs", 0, false],
      ["a.md", 0, false],
    ]);
  });

  it("keeps a folder's entries hidden while its parent is closed", () => {
    expect(flatten(listings, new Set(["src/ui"])).map((r) => r.key)).toEqual(["src", "docs", "a.md"]);
  });
});

describe("paths", () => {
  it("finds parents and what is under a folder", () => {
    expect(parentRel("a/b/c.ts")).toBe("a/b");
    expect(parentRel("c.ts")).toBe("");
    expect(isUnder("a/b", "a")).toBe(true);
    expect(isUnder("ab", "a")).toBe(false);
    expect(isUnder("x", "")).toBe(true);
  });

  it("allows moves elsewhere, never into the item itself", () => {
    expect(canMoveInto("a/b.ts", "")).toBe(true);
    expect(canMoveInto("a/b.ts", "a")).toBe(false);
    expect(canMoveInto("a", "a/sub")).toBe(false);
    expect(canMoveInto("a", "ab")).toBe(true);
  });

  it("follows a rename to the paths under it", () => {
    expect(renamed("src/ui/x.ts", "src", "lib/src")).toBe("lib/src/ui/x.ts");
    expect(renamed("srcx/y.ts", "src", "lib")).toBe("srcx/y.ts");
  });

  it("builds absolute paths in the root's separators", () => {
    expect(absPath("/Users/me/app", "src/a.ts")).toBe("/Users/me/app/src/a.ts");
    expect(absPath("C:\\code\\app\\", "src/a.ts")).toBe("C:\\code\\app\\src\\a.ts");
    expect(absPath("/r", "")).toBe("/r");
  });
});
