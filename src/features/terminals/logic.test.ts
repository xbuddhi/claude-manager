import { describe, expect, it, vi } from "vitest";
import {
  assignColors,
  chatName,
  debounce,
  defaultTitle,
  GROUP_COLORS,
  groupOrder,
  HIGH_WATER,
  InputQueue,
  insertIndex,
  LOW_WATER,
  layoutTabs,
  quotePaths,
  TAB_MAX,
  tabSub,
  throttle,
  Watermark,
} from "./logic";

describe("titles", () => {
  it("names new, resumed and forked sessions", () => {
    expect(defaultTitle(undefined, "x")).toBe("New session");
    expect(defaultTitle({}, "Fix the login bug")).toBe("Fix the login bug");
    expect(defaultTitle({ fork: true }, "Fix the login bug")).toBe("Fork of Fix the login bug");
    expect(defaultTitle({}, "a".repeat(60))).toBe(`${"a".repeat(39)}…`);
    expect(defaultTitle({}, undefined)).toBe("Resumed session");
  });

  it("shows folder and profile in the sub line", () => {
    expect(tabSub("C:\\code\\app", "work")).toBe("app  ·  work");
    expect(tabSub("/Users/me/web/", "default")).toBe("web  ·  default");
  });

  it("keeps chat names and drops generic terminal titles", () => {
    expect(chatName("✳ Fix the login bug")).toBe("Fix the login bug");
    expect(chatName("⠂ Claude Code")).toBeNull();
    expect(chatName("claude")).toBeNull();
    expect(chatName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBeNull();
    expect(chatName("/usr/local/bin/node.exe")).toBeNull();
    expect(chatName("Administrator: Windows PowerShell")).toBeNull();
    expect(chatName("-zsh")).toBeNull();
    expect(chatName("   ")).toBeNull();
    expect(chatName("2 tests left")).toBe("2 tests left");
  });
});

describe("dropped paths", () => {
  it("double-quotes on Windows", () => {
    expect(quotePaths(["C:\\a b\\x.png", "C:\\y"], "windows")).toBe('"C:\\a b\\x.png" "C:\\y" ');
  });

  it("single-quotes on macOS, escaping quotes", () => {
    expect(quotePaths(["/Users/me/it's.png"], "macos")).toBe("'/Users/me/it'\\''s.png' ");
    expect(quotePaths(["/a $(b)"], "macos")).toBe("'/a $(b)' ");
  });

  it("gives nothing for no files", () => {
    expect(quotePaths([], "macos")).toBe("");
  });
});

describe("tab strip layout", () => {
  it("shares the width between 150 and 250 px", () => {
    expect(layoutTabs(2, 0, 1000)).toEqual({ shown: [0, 1], width: TAB_MAX, overflow: false });
    const l = layoutTabs(5, 0, 900);
    expect(l.overflow).toBe(false);
    expect(l.width).toBe(176);
  });

  it("sends tabs that do not fit to the more menu, keeping the active one", () => {
    const l = layoutTabs(10, 8, 700);
    expect(l.overflow).toBe(true);
    expect(l.shown).toEqual([0, 1, 2, 8]);
    expect(l.width).toBeGreaterThanOrEqual(110);
  });

  it("always shows at least one tab", () => {
    const l = layoutTabs(3, 2, 50);
    expect(l.shown).toEqual([2]);
    expect(l.width).toBe(110);
    expect(layoutTabs(0, -1, 500).shown).toEqual([]);
  });
});

describe("flow control", () => {
  it("pauses above the high mark and resumes below the low one", () => {
    const w = new Watermark();
    expect(w.add(HIGH_WATER)).toBe(false);
    expect(w.add(1)).toBe(true);
    expect(w.add(1000)).toBe(false); // already paused
    expect(w.done(HIGH_WATER - LOW_WATER)).toBe(false);
    expect(w.done(1002)).toBe(true);
    expect(w.paused).toBe(false);
    expect(w.done(10 * HIGH_WATER)).toBe(false);
    expect(w.pending).toBe(0);
  });
});

describe("input queue", () => {
  it("waits for the terminal, then sends in order and batches what piles up", async () => {
    const sent: Array<string | number[]> = [];
    let release: () => void = () => {};
    const q = new InputQueue(async (d) => {
      sent.push(d);
      await new Promise<void>((r) => {
        release = r;
      });
      return true;
    });
    q.push("a");
    q.push("b");
    expect(sent).toEqual([]);
    q.start();
    expect(sent).toEqual(["ab"]);
    q.push("c");
    q.push([27]);
    q.push([91]);
    q.push("d");
    release();
    await vi.waitFor(() => expect(sent).toEqual(["ab", "c"]));
    release();
    await vi.waitFor(() => expect(sent).toEqual(["ab", "c", [27, 91]]));
    release();
    await vi.waitFor(() => expect(sent).toEqual(["ab", "c", [27, 91], "d"]));
    release();
  });

  it("drops queued input once a send fails", async () => {
    const sent: Array<string | number[]> = [];
    const q = new InputQueue(async (d) => {
      sent.push(d);
      return false;
    });
    q.start();
    q.push("x");
    await vi.waitFor(() => expect(sent).toEqual(["x"]));
    q.push("y");
    await vi.waitFor(() => expect(sent).toEqual(["x", "y"]));
  });
});

describe("timing helpers", () => {
  it("throttles to the latest value", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const t = throttle(250, (v: number) => seen.push(v));
    t(1);
    t(2);
    t(3);
    expect(seen).toEqual([1]);
    vi.advanceTimersByTime(250);
    expect(seen).toEqual([1, 3]);
    vi.useRealTimers();
  });

  it("debounces to the last call", () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const d = debounce(80, (v: number) => seen.push(v));
    d(1);
    vi.advanceTimersByTime(50);
    d(2);
    vi.advanceTimersByTime(79);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([2]);
    vi.useRealTimers();
  });
});

describe("folder groups", () => {
  it("puts a new tab after the last tab of its folder", () => {
    expect(insertIndex(["a", "b", "a", "c"], "a")).toBe(3);
    expect(insertIndex(["a", "b"], "z")).toBe(2);
    expect(insertIndex([], "a")).toBe(0);
  });

  it("keeps each folder's tabs together, in first-seen order", () => {
    const tabs = [
      { id: 1, k: "a" },
      { id: 2, k: "b" },
      { id: 3, k: "a" },
      { id: 4, k: "c" },
      { id: 5, k: "b" },
    ];
    expect(groupOrder(tabs, (t) => t.k).map((t) => t.id)).toEqual([1, 3, 2, 5, 4]);
  });

  it("gives each open folder its own colour and keeps it while the folder stays", () => {
    const first = assignColors(["a", "b"], new Map());
    expect([first.get("a"), first.get("b")]).toEqual([0, 1]);
    // a folder before them opens: a and b keep theirs, the new one takes the next free colour
    const next = assignColors(["c", "a", "b"], first);
    expect([next.get("c"), next.get("a"), next.get("b")]).toEqual([2, 0, 1]);
    // a closes: its colour is free again
    expect(assignColors(["c", "b", "d"], next).get("d")).toBe(0);
    const many = assignColors(["1", "2", "3", "4", "5", "6", "7"], new Map());
    expect(new Set([...many.values()].slice(0, GROUP_COLORS.length)).size).toBe(GROUP_COLORS.length);
  });
});
