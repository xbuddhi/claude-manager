import { describe, expect, it } from "vitest";
import type { Group } from "../../bindings/Group";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { buildTree, counts, folderList, type TreeInput, type TreeRow, unlistedPaths } from "./tree";

let seq = 0;
function session(modified: number, label = "a prompt"): Session {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    file: `f${seq}.jsonl`,
    cwd: null,
    label,
    count: 1,
    modified,
    sizeKb: 1,
    profile: "C:\\Users\\me\\.claude",
    slug: "slug",
    partial: false,
  };
}

function project(path: string, times: number[] = [1000], extra: Partial<Project> = {}): Project {
  const name = path.split(/[\\/]/).pop() ?? path;
  return {
    path,
    name,
    modified: Math.max(0, ...times),
    pinned: false,
    missing: false,
    sessions: times.map((t) => session(t)),
    ...extra,
  };
}

const group = (name: string, folders: string[], collapsed = false): Group => ({ name, folders, collapsed });

function input(over: Partial<TreeInput> = {}): TreeInput {
  return {
    projects: [],
    pinned: [],
    os: "windows",
    kinds: {},
    groups: [],
    foldersCollapsed: false,
    showAll: new Set(),
    liveCwd: {},
    ago: (ms) => `t${ms}`,
    ...over,
  };
}

const keys = (rows: TreeRow[]) => rows.map((r) => r.key);
const titles = (rows: TreeRow[]) => rows.map((r) => r.title);

describe("buildTree", () => {
  it("shows the empty-projects hint and every folder under FOLDERS when there are no groups", () => {
    const rows = buildTree(input({ projects: [project("C:\\src\\b", [1]), project("C:\\src\\a", [2])] }));
    expect(titles(rows)).toEqual(["PROJECTS", "No projects yet. Click + to create one.", "FOLDERS  ·  2", "a", "b"]);
    expect(keys(rows)).toEqual(["s:projects", "h:projects", "s:folders", "f:c:\\src\\a", "f:c:\\src\\b"]);
    expect(rows.map((r) => r.height)).toEqual([30, 30, 30, 32, 32]);
    const folders = rows.find((r) => r.key === "s:folders");
    expect(folders?.acceptsDrop).toBe(true);
    expect(folders?.open).toBe(true);
    expect(rows[0]?.open).toBeUndefined();
  });

  it("nests grouped folders and leaves them out of FOLDERS", () => {
    const rows = buildTree(
      input({
        projects: [project("C:\\src\\web", [5, 9]), project("C:\\src\\api", [3]), project("C:\\src\\other", [1])],
        groups: [group("Shop", ["C:\\src\\web", "C:\\src\\api\\"])],
      }),
    );
    expect(titles(rows)).toEqual(["PROJECTS", "Shop", "web", "api", "FOLDERS  ·  1", "other"]);
    const g = rows[1];
    expect(g).toMatchObject({ kind: "group", key: "g:shop", height: 34, badge: "3", open: true, acceptsDrop: true });
    expect(g?.info?.sessions.map((s) => s.modified)).toEqual([9, 5, 3]);
    expect(rows[2]).toMatchObject({ kind: "folder", indent: 1, group: "Shop", draggable: true, lastChild: false });
    expect(rows[3]).toMatchObject({ indent: 1, lastChild: true, detail: "t3" });
    expect(rows[5]).toMatchObject({ indent: 0, group: undefined });
  });

  it("hints an empty group and hides a collapsed group's folders", () => {
    const rows = buildTree(
      input({
        projects: [project("C:\\x", [1])],
        groups: [group("Empty", []), group("Closed", ["C:\\x"], true)],
      }),
    );
    expect(titles(rows)).toEqual(["PROJECTS", "Empty", "Drag folders here", "Closed", "FOLDERS  ·  0"]);
    expect(rows[2]).toMatchObject({ kind: "hint", height: 28, indent: 1, lastChild: true });
    expect(rows[3]).toMatchObject({ open: false, badge: "1" });
  });

  it("collapses FOLDERS but still counts them", () => {
    const rows = buildTree(input({ projects: [project("C:\\a"), project("C:\\b")], foldersCollapsed: true }));
    expect(titles(rows).slice(-1)).toEqual(["FOLDERS  ·  2"]);
    expect(rows[rows.length - 1]?.open).toBe(false);
  });

  it("leaves hidden folders out of FOLDERS behind a 'Show N hidden' row, but never out of a project", () => {
    const base = input({
      projects: [project("C:\\a"), project("C:\\b"), project("C:\\c")],
      groups: [group("Work", ["C:\\c"])],
      hidden: ["C:\\b\\", "C:\\c"],
    });
    const rows = buildTree(base);
    expect(titles(rows).slice(-3)).toEqual(["FOLDERS  ·  1", "a", "Show 1 hidden"]);
    expect(rows.some((r) => r.title === "c")).toBe(true);

    const shown = buildTree({ ...base, showHidden: true });
    expect(titles(shown).slice(-3)).toEqual(["a", "HIDDEN  ·  1", "b"]);
    expect(shown.find((r) => r.title === "b")?.dim).toBe(true);
  });

  it("shows 5 of more than 6 folders with 'Show N more', all of them with 'Show less'", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `C:\\p\\f${i}`);
    const base = input({ projects: paths.map((p, i) => project(p, [100 - i])), groups: [group("Big", paths)] });
    const short = buildTree(base);
    expect(short.filter((r) => r.kind === "folder")).toHaveLength(5);
    const more = short.find((r) => r.kind === "more");
    expect(more).toMatchObject({ key: "m:big", title: "Show 3 more", height: 28, indent: 1, group: "Big" });

    const long = buildTree({ ...base, showAll: new Set(["big"]) });
    expect(long.filter((r) => r.kind === "folder")).toHaveLength(8);
    expect(long.find((r) => r.kind === "more")?.title).toBe("Show less");
  });

  it("lists exactly 6 folders without a 'Show more' row", () => {
    const paths = Array.from({ length: 6 }, (_, i) => `C:\\p\\f${i}`);
    const rows = buildTree(input({ projects: paths.map((p) => project(p)), groups: [group("Six", paths)] }));
    expect(rows.filter((r) => r.kind === "folder")).toHaveLength(6);
    expect(rows.some((r) => r.kind === "more")).toBe(false);
  });

  it("flags pinned and missing folders with their icons and dims missing ones", () => {
    const rows = buildTree(
      input({
        projects: [project("C:\\gone", [5], { missing: true }), project("C:\\here", [4])],
        pinned: ["C:\\here\\", "C:\\pinned-only"],
        kinds: { "c:\\pinned-only": "dir" },
      }),
    );
    const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(byTitle.here).toMatchObject({ icon: "star", dim: false, detail: "t4" });
    expect(byTitle["pinned-only"]).toMatchObject({ icon: "star", dim: false, detail: undefined });
    expect(byTitle.gone).toMatchObject({ icon: "warning", dim: true });
    // pinned first, then by last activity
    expect(titles(rows).slice(3)).toEqual(["here", "pinned-only", "gone"]);
  });

  it("marks grouped or pinned folders the disk says are gone as missing", () => {
    const rows = buildTree(
      input({
        pinned: ["C:\\old"],
        groups: [group("G", ["C:\\nowhere", "C:\\file.txt"])],
        kinds: { "c:\\old": "missing", "c:\\nowhere": "missing", "c:\\file.txt": "file" },
      }),
    );
    const folders = rows.filter((r) => r.kind === "folder");
    expect(folders.map((r) => [r.title, r.icon, r.dim])).toEqual([
      ["nowhere", "warning", true],
      ["file.txt", "warning", true],
      ["old", "warning", true],
    ]);
    // a group folder without sessions has no time
    expect(folders[0]?.detail).toBeUndefined();
  });

  it("sums the group badge over all its folders, even the ones hidden behind 'Show more'", () => {
    const paths = Array.from({ length: 7 }, (_, i) => `C:\\p\\f${i}`);
    const rows = buildTree(input({ projects: paths.map((p) => project(p, [1, 2])), groups: [group("G", paths)] }));
    expect(rows.find((r) => r.kind === "group")?.badge).toBe("14");
  });

  it("keeps row keys stable across rebuilds and case changes in the data", () => {
    const a = buildTree(input({ projects: [project("C:\\Src\\App")], groups: [group("Web", [])] }));
    const b = buildTree(input({ projects: [project("c:/src/app/")], groups: [group("Web", [])] }));
    expect(keys(a)).toEqual(keys(b));
    expect(keys(a)).toContain("f:c:\\src\\app");
    expect(keys(a)).toContain("g:web");
  });

  it("matches folders case-insensitively on Windows and macOS, exactly elsewhere", () => {
    for (const os of ["windows", "macos"]) {
      const sep = os === "windows" ? "\\" : "/";
      const p = (s: string) => (os === "windows" ? `C:${sep}${s}` : `/Users/me/${s}`);
      const rows = buildTree(
        input({ os, projects: [project(p("App"))], groups: [group("G", [p("app")])], pinned: [p("APP")] }),
      );
      const folders = rows.filter((r) => r.kind === "folder");
      expect(folders, os).toHaveLength(1);
      expect(folders[0]).toMatchObject({ group: "G", icon: "star" });
    }
    const linux = buildTree(
      input({ os: "linux", projects: [project("/home/me/App")], groups: [group("G", ["/home/me/app"])] }),
    );
    expect(linux.filter((r) => r.kind === "folder").map((r) => r.group)).toEqual(["G", undefined]);
  });

  it("lists a folder that two groups name only in the first", () => {
    const rows = buildTree(
      input({ projects: [project("C:\\a")], groups: [group("One", ["C:\\a"]), group("Two", ["c:\\A"])] }),
    );
    expect(titles(rows)).toEqual(["PROJECTS", "One", "a", "Two", "Drag folders here", "FOLDERS  ·  0"]);
  });

  it("gives folders their live level and groups the highest of theirs", () => {
    const rows = buildTree(
      input({
        projects: [project("C:\\a"), project("C:\\b"), project("C:\\c")],
        groups: [group("G", ["C:\\a", "C:\\b"])],
        liveCwd: { "c:\\a": 1, "c:\\b": 2, "c:\\c": 1 },
      }),
    );
    const live = Object.fromEntries(rows.map((r) => [r.title, r.live]));
    expect(live).toMatchObject({ G: 2, a: 1, b: 2, c: 1, PROJECTS: 0 });
  });
});

describe("folderList and counts", () => {
  it("merges two spellings of one folder and adds pinned folders", () => {
    const list = folderList({
      projects: [project("C:\\A", [1]), project("c:\\a\\", [7])],
      pinned: ["C:\\new\\"],
      os: "windows",
    });
    expect(list.map((f) => [f.path, f.last, f.sessions.length, f.pinned])).toEqual([
      ["C:\\new", 0, 0, true],
      ["C:\\A", 7, 2, false],
    ]);
    expect(counts(list)).toEqual({ sessions: 2, folders: 2 });
    // each folder carries its comparison key; the tree takes a list made beforehand
    expect(list.map((f) => f.key)).toEqual(["c:\\new", "c:\\a"]);
    const tree = input({ projects: [project("C:\\A", [1])], pinned: ["C:\\b"] });
    expect(keys(buildTree(tree, folderList(tree)))).toEqual(keys(buildTree(tree)));
  });

  it("names the pinned and grouped folders the index does not list", () => {
    const paths = unlistedPaths(
      [project("C:\\a")],
      ["C:\\A\\", "C:\\pin"],
      [group("G", ["c:\\a", "C:\\g\\", "", "C:\\PIN"])],
      "windows",
    );
    expect(paths).toEqual(["C:\\pin", "C:\\g"]);
  });
});
