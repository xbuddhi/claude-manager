import { describe, expect, it } from "vitest";
import type { GitStatus } from "../../bindings/GitStatus";
import { parseBranches } from "./branch";
import { actionsFor, changeRows, rowKey, statusClass } from "./changes";

const file = (path: string, status: string) => ({ path, name: path.split("/").pop() ?? path, dir: "", status });
const status = (staged: ReturnType<typeof file>[], changes: ReturnType<typeof file>[]): GitStatus => ({
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  staged,
  changes,
});

describe("change rows", () => {
  it("omits an empty STAGED CHANGES section but always shows CHANGES", () => {
    expect(changeRows(status([], [])).map(rowKey)).toEqual(["#changes"]);
    const rows = changeRows(status([file("a.ts", "M")], [file("a.ts", "M"), file("b.ts", "U")]));
    expect(rows.map(rowKey)).toEqual(["#staged", "staged|a.ts", "#changes", "changes|a.ts", "changes|b.ts"]);
    expect(rows[0]).toEqual({ kind: "section", section: "staged", count: 1 });
    expect(rows[2]).toEqual({ kind: "section", section: "changes", count: 2 });
    expect(changeRows(null)).toEqual([]);
  });

  it("offers the Windows app's actions per row", () => {
    const [staged, stagedFile, changes, changedFile] = changeRows(status([file("a", "M")], [file("b", "M")]));
    expect(staged && actionsFor(staged)).toEqual(["unstageAll"]);
    expect(stagedFile && actionsFor(stagedFile)).toEqual(["open", "unstage"]);
    expect(changes && actionsFor(changes)).toEqual(["discardAll", "stageAll"]);
    expect(changedFile && actionsFor(changedFile)).toEqual(["open", "discard", "stage"]);
  });

  it("colours status letters", () => {
    expect(["M", "A", "U", "D", "R", "C", "!", "T"].map(statusClass)).toEqual([
      "git-st-mod",
      "git-st-add",
      "git-st-add",
      "git-st-del",
      "git-st-ren",
      "git-st-ren",
      "git-st-conf",
      "git-st-other",
    ]);
  });
});

describe("parseBranches", () => {
  it("reads the current marker and names", () => {
    expect(parseBranches("*\tmain\r\n \tfeature/x\n\n")).toEqual([
      { name: "main", current: true },
      { name: "feature/x", current: false },
    ]);
    expect(parseBranches("")).toEqual([]);
  });
});
