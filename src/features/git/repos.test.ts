import { describe, expect, it } from "vitest";
import type { SidebarSelection } from "../../core/store";
import { pickTarget, repoLabels, selectionFolders, unique } from "./repos";

const folder = (path: string): SidebarSelection => ({ kind: "folder", key: `f:${path}`, path });
const group = (folders: string[]): SidebarSelection => ({ kind: "group", key: "g:x", name: "x", folders });

describe("pickTarget", () => {
  it("shows a folder's only repository, or the folder itself, without a picker", () => {
    expect(pickTarget(folder("C:\\p"), [["C:\\p"]], null, "windows")).toEqual({ repos: [], folder: "C:\\p" });
    expect(pickTarget(folder("C:\\p"), [["C:\\p\\api"]], null, "windows")).toEqual({ repos: [], folder: "C:\\p\\api" });
    expect(pickTarget(folder("C:\\p"), [[]], null, "windows")).toEqual({ repos: [], folder: "C:\\p" });
  });

  it("offers a picker for several repositories and keeps a pick that is still there", () => {
    const found = [["/w/api", "/w/web"]];
    expect(pickTarget(folder("/w"), found, null, "macos")).toEqual({ repos: ["/w/api", "/w/web"], folder: "/w/api" });
    expect(pickTarget(folder("/w"), found, "/W/Web", "macos").folder).toBe("/w/web");
    expect(pickTarget(folder("/w"), found, "/elsewhere", "macos").folder).toBe("/w/api");
  });

  it("unions a group's repositories, falling back to its folders", () => {
    const sel = group(["/a", "/b"]);
    expect(pickTarget(sel, [["/a"], ["/b/x", "/a"]], null, "linux")).toEqual({ repos: ["/a", "/b/x"], folder: "/a" });
    expect(pickTarget(sel, [[], []], null, "linux")).toEqual({ repos: ["/a", "/b"], folder: "/a" });
    expect(pickTarget(group([]), [], null, "linux")).toEqual({ repos: [], folder: null });
    expect(pickTarget(null, [], null, "linux")).toEqual({ repos: [], folder: null });
  });

  it("lists the folders a selection needs", () => {
    expect(selectionFolders(folder("/a"))).toEqual(["/a"]);
    expect(selectionFolders(group(["/a", "/b"]))).toEqual(["/a", "/b"]);
    expect(selectionFolders(null)).toEqual([]);
  });
});

describe("repo labels", () => {
  it("adds the parent folder when two repositories share a name", () => {
    expect(repoLabels(["C:\\x\\api", "C:\\y\\API", "C:\\y\\web"], "\\")).toEqual(["x\\api", "y\\API", "web"]);
    expect(repoLabels(["/w/api", "/w/web/"], "/")).toEqual(["api", "web"]);
  });

  it("dedupes by the OS's path rules", () => {
    expect(unique(["C:\\A", "c:/a/", "C:\\b"], "windows")).toEqual(["C:\\A", "C:\\b"]);
    expect(unique(["/A", "/a"], "linux")).toEqual(["/A", "/a"]);
  });
});
