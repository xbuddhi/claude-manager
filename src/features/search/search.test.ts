import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { bus, type LaunchRequest } from "../../core/bus";
import { DEFAULT_SETTINGS, store } from "../../core/store";
import { folderKey, groupKey, mountSearch, placeholder } from "./search";

vi.mock("../../core/api", () => ({ call: async () => ({ ok: true, value: null }), listen: async () => () => {} }));

const ID = "0b9f4c2e-1a2b-4c3d-8e9f-0123456789ab";
const session: Session = {
  id: ID,
  file: `C:\\Users\\me\\.claude\\projects\\C--code-app\\${ID}.jsonl`,
  cwd: "C:\\code\\app",
  label: "Fix the login bug",
  full: "Fix the login bug in the web app",
  count: 4,
  modified: Date.now() - 60_000,
  sizeKb: 3,
  profile: "C:\\Users\\me\\.claude",
  slug: "C--code-app",
  partial: false,
};
const project: Project = {
  path: "C:\\code\\app",
  name: "app",
  modified: session.modified,
  pinned: false,
  missing: false,
  sessions: [session],
};

const input = () => document.querySelector<HTMLInputElement>(".search-input") as HTMLInputElement;
const key = (k: string) => input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event("input"));
};
const shown = () => [...document.querySelectorAll<HTMLElement>(".search-pop .search-item")];

describe("search box", () => {
  const launches: LaunchRequest[] = [];
  const selects: string[] = [];

  beforeAll(() => {
    document.body.innerHTML = `<div id="tb-search-slot"></div><div id="overlay-root"></div>`;
    store.set({
      platform: { os: "windows", build: "", arch: "" },
      settings: { ...DEFAULT_SETTINGS, groups: [{ name: "Web", folders: ["C:\\code\\app"], collapsed: false }] },
      index: { gen: 1, projects: [project], loaded: "ok", error: null },
    });
    bus.on("launch", (r) => launches.push(r));
    bus.on("sidebar:select", ({ key }) => selects.push(key));
    mountSearch(document.querySelector("#tb-search-slot") as HTMLElement);
  });
  afterEach(() => {
    vi.useRealTimers();
    launches.length = 0;
    selects.length = 0;
  });

  it("shows the shortcut in the placeholder for each OS", () => {
    expect(placeholder(false)).toBe("Search projects and sessions   (Ctrl+F)");
    expect(placeholder(true)).toBe("Search projects and sessions   (⌘F)");
    expect(groupKey("Web")).toBe("g:web");
    expect(folderKey("C:\\Code\\App\\")).toBe("f:c:\\code\\app");
  });

  it("shows results after the debounce, moves with the arrows and wraps", () => {
    vi.useFakeTimers();
    type("app");
    expect(shown()).toHaveLength(0);
    vi.advanceTimersByTime(120);
    const rows = shown();
    expect(rows.map((r) => r.classList[1])).toEqual(["folder", "session"]);
    expect(rows[0]?.classList.contains("on")).toBe(true);
    key("ArrowDown");
    expect(rows[1]?.classList.contains("on")).toBe(true);
    key("ArrowDown");
    expect(rows[0]?.classList.contains("on")).toBe(true);
    key("ArrowUp");
    expect(rows[1]?.classList.contains("on")).toBe(true);
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("Enter resumes a picked session and selects its folder; the box is cleared", () => {
    type("login");
    key("Enter"); // flushes the debounce, then picks the first result
    expect(selects).toEqual(["f:c:\\code\\app"]);
    expect(launches).toEqual([
      {
        dir: "C:\\code\\app",
        profile: session.profile,
        resume: { sessionId: ID, fork: false },
        label: session.label,
      },
    ]);
    expect(store.get().sessionsWanted).toBe(ID);
    expect(input().value).toBe("");
    expect(document.querySelector(".search-pop")).toBeNull();
  });

  it("Esc closes and clears; no match shows a message", () => {
    vi.useFakeTimers();
    type("nothing-here");
    vi.advanceTimersByTime(120);
    expect(document.querySelector(".search-empty")?.textContent).toBe("No results for 'nothing-here'");
    key("Escape");
    expect(input().value).toBe("");
    expect(store.get().searchQuery).toBe("");
    expect(document.querySelector(".search-pop")).toBeNull();
  });
});
