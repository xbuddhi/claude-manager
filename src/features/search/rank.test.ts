import { describe, expect, it } from "vitest";
import type { Group } from "../../bindings/Group";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { LIMITS, nextPick, type SearchData, type SearchItem, searchItems } from "./rank";

const NOW = Date.UTC(2026, 9, 25, 12);
const HOUR = 3_600_000;

let seq = 0;
function session(full: string, modified: number, cwd: string | null = "C:\\code\\app"): Session {
  const id = `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;
  return {
    id,
    file: `C:\\Users\\me\\.claude\\projects\\x\\${id}.jsonl`,
    cwd,
    label: full,
    full,
    count: 3,
    modified,
    sizeKb: 4,
    profile: "C:\\Users\\me\\.claude",
    slug: "x",
    partial: false,
  };
}

function project(path: string, modified: number, sessions: Session[] = []): Project {
  return { path, name: path.split("\\").pop() ?? path, modified, pinned: false, missing: false, sessions };
}

function data(over: Partial<SearchData> = {}): SearchData {
  return {
    groups: [],
    projects: [],
    live: {},
    liveCwd: {},
    os: "windows",
    profileName: () => "default",
    now: NOW,
    ...over,
  };
}

const titles = (items: SearchItem[], kind: SearchItem["kind"]) =>
  items.filter((i) => i.kind === kind).map((i) => i.title);

describe("searchItems", () => {
  it("returns nothing for an empty query and a message when nothing matches", () => {
    expect(searchItems("   ", data())).toEqual([]);
    expect(searchItems(" zz ", data())).toEqual([{ kind: "empty", title: "No results for 'zz'" }]);
  });

  it("puts groups whose name starts with the query first and keeps at most 4", () => {
    const groups: Group[] = ["my web", "web", "old web", "webby", "x-web", "web2"].map((name) => ({
      name,
      folders: ["C:\\a"],
      collapsed: false,
    }));
    const items = searchItems("WEB", data({ groups }));
    expect(items[0]).toEqual({ kind: "section", title: "PROJECTS" });
    expect(titles(items, "group")).toEqual(["web", "webby", "web2", "my web"]);
    expect(titles(items, "group")).toHaveLength(LIMITS.groups);
    expect(items[1]).toMatchObject({ sub: "1 folder" });
  });

  it("ranks folders by prefix, then newest, keeps at most 6 and describes each", () => {
    const projects = [
      project("C:\\code\\my-api", NOW - 1 * HOUR, [session("x", NOW - HOUR)]),
      project("C:\\code\\api-old", NOW - 9 * HOUR),
      project("C:\\code\\api-new", NOW - 2 * HOUR, [session("y", NOW - 2 * HOUR)]),
      ...[1, 2, 3, 4, 5].map((n) => project(`C:\\work\\zapi${n}`, NOW - n * HOUR)),
    ];
    const groups: Group[] = [{ name: "Backend", folders: ["c:/code/api-new/"], collapsed: true }];
    const items = searchItems("api", data({ projects, groups, liveCwd: { "c:\\code\\api-new": 2 } }));
    const folders = items.filter((i) => i.kind === "folder");
    expect(folders.map((f) => f.title)).toEqual(["api-new", "api-old", "my-api", "zapi1", "zapi2", "zapi3"]);
    expect(folders).toHaveLength(LIMITS.folders);
    expect(folders[0]).toMatchObject({ sub: "in Backend", right: "2h ago", live: 2, group: "Backend" });
    // no sessions: no age; not in a group: the parent folder's name
    expect(folders[1]).toMatchObject({ sub: "code", right: "", live: 0, group: null });
  });

  it("sorts and ages folders by the sessions in view, not every profile's activity", () => {
    // projectsFor() keeps the project's all-profile `modified` (5 minutes ago) next to this profile's sessions
    const projects = [
      project("C:\\code\\app", NOW - 5 * 60_000, [session("old", NOW - 21 * 24 * HOUR)]),
      project("C:\\code\\app-two", NOW - 2 * HOUR, [session("new", NOW - 2 * HOUR)]),
    ];
    const folders = searchItems("app", data({ projects })).filter((i) => i.kind === "folder");
    expect(folders.map((f) => f.title)).toEqual(["app-two", "app"]);
    expect(folders[1]?.right).not.toBe("5m ago");
  });

  it("lists matching sessions newest first, at most 8, without '(no prompt)'", () => {
    const sessions = [
      session("(no prompt)", NOW),
      ...Array.from({ length: 10 }, (_, i) => session(`Fix the build ${i}`, NOW - (i + 1) * HOUR)),
    ];
    const live = { [sessions[1]?.id ?? ""]: { level: 2 }, [sessions[2]?.id ?? ""]: { level: 1 } };
    const items = searchItems("fix", data({ projects: [project("C:\\code\\app", NOW, sessions)], live }));
    const found = items.filter((i) => i.kind === "session");
    expect(found).toHaveLength(LIMITS.sessions);
    expect(found.map((s) => s.title)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Fix the build ${i}`));
    expect(found.map((s) => s.right).slice(0, 3)).toEqual(["working", "open", "3h ago"]);
    expect(found[0]).toMatchObject({ sub: "app  ·  default", live: 2 });
    // "(no prompt)" is never a match, even when the query is in it
    expect(titles(searchItems("prompt", data({ projects: [project("C:\\x", NOW, sessions)] })), "session")).toEqual([]);
  });

  it("orders the sections projects, folders, sessions", () => {
    const projects = [project("C:\\code\\app", NOW, [session("app crash", NOW)])];
    const groups: Group[] = [{ name: "apps", folders: [], collapsed: false }];
    const items = searchItems("app", data({ projects, groups }));
    expect(titles(items, "section")).toEqual(["PROJECTS", "FOLDERS", "SESSIONS"]);
    expect(items.map((i) => i.kind)).toEqual(["section", "group", "section", "folder", "section", "session"]);
  });
});

describe("nextPick", () => {
  const items: SearchItem[] = [
    { kind: "section", title: "PROJECTS" },
    { kind: "group", title: "a", sub: "", name: "a" },
    { kind: "section", title: "FOLDERS" },
    { kind: "folder", title: "b", sub: "", right: "", live: 0, path: "b", group: null },
  ];

  it("skips headings and wraps around", () => {
    expect(nextPick(items, 1, 1)).toBe(3);
    expect(nextPick(items, 3, 1)).toBe(1);
    expect(nextPick(items, 1, -1)).toBe(3);
    expect(nextPick(items, items.length, -1)).toBe(3);
    expect(nextPick([{ kind: "empty", title: "none" }], 0, 1)).toBe(-1);
  });
});
