import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "../../bindings/Group";
import type { Settings } from "../../bindings/Settings";
import { DEFAULT_SETTINGS, store } from "../../core/store";

const dialog = vi.hoisted(() => ({
  input: vi.fn<(text: string, opts?: { value?: string }) => Promise<string | null>>(),
  ask: vi.fn<(text: string, caption?: string, kind?: string) => Promise<boolean>>(),
  message: vi.fn<(text: string) => Promise<void>>(),
}));
vi.mock("../../ui/dialog", () => dialog);
// settings save straight into the store mirror (no backend in tests)
vi.mock("../../core/settings", async () => {
  const { store } = await import("../../core/store");
  return {
    settings: () => store.get().settings,
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      store.set({ settings: { ...store.get().settings, ...patch } });
      return true;
    }),
  };
});

const {
  addGroup,
  deleteProject,
  groupOf,
  isPinned,
  moveFolder,
  moveToGroup,
  nameTaken,
  newProject,
  pin,
  removeGroup,
  renameGroup,
  renameProject,
  setCollapsed,
  togglePin,
  withPins,
  withoutPin,
} = await import("./groups");

const g = (name: string, folders: string[] = [], collapsed = false): Group => ({ name, folders, collapsed });

function setGroups(groups: Group[], pinned: string[] = []) {
  store.set({ settings: { ...DEFAULT_SETTINGS, groups, pinned }, platform: { os: "windows", build: "", arch: "" } });
}
const groups = () => store.get().settings.groups;

beforeEach(() => {
  vi.clearAllMocks();
  setGroups([]);
});

describe("group helpers", () => {
  it("keeps one project per folder and trims the path", () => {
    const start = [g("A", ["C:\\x"]), g("B", ["C:\\y"])];
    const moved = moveToGroup(start, "c:\\X\\", "B", "windows");
    expect(moved).toEqual([g("A", []), g("B", ["C:\\y", "c:\\X"])]);
    expect(moveToGroup(moved, "C:\\x", null, "windows")).toEqual([g("A"), g("B", ["C:\\y"])]);
    // the input is not changed
    expect(start[0]?.folders).toEqual(["C:\\x"]);
  });

  it("finds a folder's group without case on Windows and macOS only", () => {
    const list = [g("A", ["/Users/me/App"])];
    expect(groupOf(list, "/users/me/app/", "macos")?.name).toBe("A");
    expect(groupOf(list, "/users/me/app", "linux")).toBeUndefined();
  });

  it("compares names without case, except against the group being renamed", () => {
    const list = [g("Web"), g("Api")];
    expect(nameTaken(list, "web")).toBe(true);
    expect(nameTaken(list, "WEB", "Web")).toBe(false);
    expect(nameTaken(list, "api", "Web")).toBe(true);
  });

  it("adds, renames, removes and collapses", () => {
    let list = addGroup([], "A");
    expect(list).toEqual([g("A")]);
    list = renameGroup(list, "A", "B");
    expect(list).toEqual([g("B")]);
    list = setCollapsed(list, "B");
    expect(list[0]?.collapsed).toBe(true);
    expect(setCollapsed(list, "B", true)[0]?.collapsed).toBe(true);
    expect(removeGroup(list, "B")).toEqual([]);
  });

  it("pins once per folder, trimmed, and unpins every spelling", () => {
    const pinned = withPins(["C:\\a"], ["c:\\A\\", "C:\\b\\", " "], "windows");
    expect(pinned).toEqual(["C:\\a", "C:\\b"]);
    expect(isPinned(pinned, "c:/b", "windows")).toBe(true);
    expect(withoutPin(["C:\\a\\", "c:\\A", "C:\\b"], "C:\\a", "windows")).toEqual(["C:\\b"]);
  });
});

describe("group flows", () => {
  it("creates a project with the Windows app's prompt, moving a folder into it", async () => {
    setGroups([g("Old", ["C:\\x"])]);
    dialog.input.mockResolvedValueOnce("  New  ");
    expect(await newProject("C:\\x\\")).toBe("New");
    expect(dialog.input).toHaveBeenCalledWith(
      "New project\nName for the new project. Folders are only referenced here, never moved.",
    );
    expect(groups()).toEqual([g("Old"), g("New", ["C:\\x"])]);
  });

  it("refuses a duplicate name with the Windows app's message", async () => {
    setGroups([g("Web")]);
    dialog.input.mockResolvedValueOnce("web");
    expect(await newProject()).toBeNull();
    expect(dialog.message).toHaveBeenCalledWith("A project named 'web' already exists.");
    expect(groups()).toEqual([g("Web")]);
  });

  it("does nothing when the name prompt is cancelled or left empty", async () => {
    dialog.input.mockResolvedValueOnce(null).mockResolvedValueOnce("   ");
    expect(await newProject()).toBeNull();
    expect(await newProject()).toBeNull();
    expect(groups()).toEqual([]);
  });

  it("renames with the name prefilled; unchanged or empty is a no-op; duplicates are refused", async () => {
    setGroups([g("Web", ["C:\\x"]), g("Api")]);
    dialog.input.mockResolvedValueOnce("Shop");
    await renameProject("Web");
    expect(dialog.input).toHaveBeenLastCalledWith("Rename project\nNew name:", { value: "Web" });
    expect(groups()[0]).toEqual(g("Shop", ["C:\\x"]));

    dialog.input.mockResolvedValueOnce("Shop").mockResolvedValueOnce("");
    await renameProject("Shop");
    await renameProject("Shop");
    expect(groups()[0]?.name).toBe("Shop");

    dialog.input.mockResolvedValueOnce("API");
    await renameProject("Shop");
    expect(dialog.message).toHaveBeenCalledWith("A project named 'API' already exists.");
    expect(groups().map((x) => x.name)).toEqual(["Shop", "Api"]);

    // only the case changes: allowed
    dialog.input.mockResolvedValueOnce("shop");
    await renameProject("Shop");
    expect(groups().map((x) => x.name)).toEqual(["shop", "Api"]);
  });

  it("asks before deleting a project and keeps its folders and sessions", async () => {
    setGroups([g("Web", ["C:\\a", "C:\\b", ""])]);
    dialog.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await deleteProject("Web");
    expect(groups()).toHaveLength(1);
    expect(dialog.ask).toHaveBeenCalledWith(
      "Delete the project 'Web'?\n\nIts 2 folder(s) go back to Ungrouped. No folders or sessions are deleted.",
      "Delete project",
      "warning",
    );
    await deleteProject("Web");
    expect(groups()).toEqual([]);
  });

  it("moves folders and toggles pins through settings", async () => {
    setGroups([g("A"), g("B")], ["C:\\p"]);
    await moveFolder("C:\\f", "A");
    await moveFolder("C:\\f", "B");
    expect(groups()).toEqual([g("A"), g("B", ["C:\\f"])]);
    await togglePin("c:\\P\\");
    expect(store.get().settings.pinned).toEqual([]);
    await togglePin("C:\\q\\");
    await pin(["C:\\q", "C:\\r"]);
    expect(store.get().settings.pinned).toEqual(["C:\\q", "C:\\r"]);
  });
});
