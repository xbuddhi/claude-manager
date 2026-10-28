import { describe, expect, it } from "vitest";
import {
  branchName,
  changeCount,
  changesTab,
  commitLabel,
  errorText,
  isHead,
  largeFile,
  parseLog,
  pullTip,
  pushTip,
  refPills,
  shortAge,
  stashMessage,
  successText,
  switchAsk,
  syncLabel,
  unpublishedCount,
} from "./strings";

describe("ref pills", () => {
  it("drops HEAD entries, marks the checked-out branch and strips tag prefixes", () => {
    expect(refPills("HEAD -> main, origin/main, origin/HEAD, tag: v1.2")).toEqual(["*main", "origin/main", "v1.2"]);
    expect(refPills("HEAD, tag: v0.1")).toEqual(["v0.1"]);
    expect(refPills("")).toEqual([]);
  });

  it("detects HEAD like the Windows app", () => {
    expect(isHead("HEAD -> main, origin/main")).toBe(true);
    expect(isHead("HEAD")).toBe(true);
    expect(isHead("tag: v1, HEAD")).toBe(true);
    expect(isHead("origin/HEAD, origin/main")).toBe(false);
    expect(isHead("")).toBe(false);
  });
});

describe("short ages (git's %ar, shortened)", () => {
  const now = 1_800_000_000_000;
  const ago = (seconds: number) => shortAge(Math.floor(now / 1000) - seconds, now);
  it("follows git's thresholds and rounding", () => {
    expect(ago(0)).toBe("0s");
    expect(ago(89)).toBe("89s");
    expect(ago(90)).toBe("2m");
    expect(ago(89 * 60)).toBe("89m");
    expect(ago(90 * 60)).toBe("2h");
    expect(ago(35 * 3600)).toBe("35h");
    expect(ago(36 * 3600)).toBe("2d");
    expect(ago(13 * 86400)).toBe("13d");
    expect(ago(14 * 86400)).toBe("2w");
    expect(ago(69 * 86400)).toBe("10w");
    expect(ago(70 * 86400)).toBe("2mo");
    expect(ago(364 * 86400)).toBe("12mo");
    expect(ago(365 * 86400)).toBe("1y");
    expect(ago(430 * 86400)).toBe("1y 2mo");
    expect(ago(1825 * 86400)).toBe("5y");
    expect(ago(-10)).toBe("now");
  });
});

describe("labels and messages", () => {
  it("describes the sync state and the push / pull buttons", () => {
    expect(syncLabel({ hasUpstream: false, ahead: 0, behind: 0 })).toBe("not published");
    expect(syncLabel({ hasUpstream: true, ahead: 2, behind: 1 })).toBe("↑2  ↓1");
    expect(syncLabel({ hasUpstream: true, ahead: 0, behind: 0 })).toBe("up to date");
    expect(pushTip({ hasUpstream: false, ahead: 3, behind: 0 })).toBe("Publish branch with 3 commit(s)");
    expect(pushTip({ hasUpstream: false, ahead: 0, behind: 0 })).toBe("Publish branch");
    expect(unpublishedCount("a1b2c3d\ne4f5a6b\n")).toBe(2);
    expect(unpublishedCount("")).toBe(0);
    expect(pushTip({ hasUpstream: true, ahead: 3, behind: 0 })).toBe("Push 3 commit(s)");
    expect(pushTip({ hasUpstream: true, ahead: 0, behind: 0 })).toBe("Push");
    expect(pullTip({ hasUpstream: true, ahead: 0, behind: 4 })).toBe("Pull 4 commit(s)");
    expect(pullTip({ hasUpstream: true, ahead: 0, behind: 0 })).toBe("Pull");
  });

  it("counts changes", () => {
    expect(changeCount(0)).toBe("clean");
    expect(changeCount(1)).toBe("1 change");
    expect(changeCount(5)).toBe("5 changes");
    expect(changesTab(0)).toBe("Changes");
    expect(changesTab(5)).toBe("Changes  5");
    expect(commitLabel(0)).toBe("Commit");
    expect(commitLabel(2)).toBe("Commit 2 staged");
  });

  it("summarizes git output", () => {
    expect(errorText(1, "out", "\nerror: one\n\nhint: two\nhint: three")).toBe("error: one  hint: two");
    expect(errorText(128, "", " \n")).toBe("git failed (exit 128)");
    expect(successText("first\nlast line \n", "")).toBe("last line");
    expect(successText("", "To origin\n   abc..def  main -> main\n")).toBe("abc..def  main -> main");
    expect(successText("", "")).toBe("Done");
  });

  it("formats sizes, stash messages and branch names", () => {
    expect(largeFile("data.json", 3.25 * 1024 * 1024)).toBe("data.json is a large new file (3.3 MB)");
    expect(stashMessage(new Date(2026, 0, 5, 9, 7))).toBe("2026-01-05 09:07 from Claude Manager");
    expect(branchName("  my  new\tfeature ")).toBe("my-new-feature");
  });
});

describe("parseLog", () => {
  it("splits records and fields", () => {
    const out =
      "a1\x1fb2 c3\x1fMerge it\x1fAnn\x1f1700000000\x1fHEAD -> main\x1e\nb2\x1f\x1fRoot\x1fBo\x1f1600000000\x1f\x1e";
    expect(parseLog(out)).toEqual([
      { hash: "a1", parents: "b2 c3", subject: "Merge it", author: "Ann", at: 1_700_000_000, refs: "HEAD -> main" },
      { hash: "b2", parents: "", subject: "Root", author: "Bo", at: 1_600_000_000, refs: "" },
    ]);
    expect(parseLog("")).toEqual([]);
  });
});

describe("switchAsk", () => {
  it("names what makes switching risky: changed files, Claude working, or both", () => {
    expect(switchAsk("dev", 1, false)).toMatch(/^Switch to dev\?\n1 uncommitted file: bring them along/);
    expect(switchAsk("dev", 0, true)).toBe(
      "Switch to dev?\nClaude is working in this folder: its files change under it when you switch.",
    );
    expect(switchAsk("dev", 3, true).split("\n\n")).toHaveLength(2);
  });
});
