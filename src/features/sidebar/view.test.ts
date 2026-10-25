import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Group } from "../../bindings/Group";
import type { Project } from "../../bindings/Project";
import type { Settings } from "../../bindings/Settings";
import { emit, type LaunchRequest, on } from "../../core/bus";
import { DEFAULT_SETTINGS, store } from "../../core/store";
import { closeMenus } from "../../ui/menu";

const dialog = vi.hoisted(() => ({
  input: vi.fn(async () => null as string | null),
  ask: vi.fn(async () => false),
  message: vi.fn(async () => {}),
}));
vi.mock("../../ui/dialog", () => dialog);
const calls = vi.hoisted(() => [] as Array<{ cmd: string; args: unknown }>);
vi.mock("../../core/api", () => ({
  call: vi.fn(async (cmd: string, args: { paths?: string[] }) => {
    calls.push({ cmd, args });
    if (cmd === "path_kinds") return { ok: true, value: (args.paths ?? []).map(() => "dir") };
    return { ok: false, error: { code: "internal", message: "no backend in tests" } };
  }),
  listen: vi.fn(async () => () => {}),
}));
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

const PROFILE = "C:\\Users\\me\\.claude";

function project(path: string, modified: number): Project {
  const id = `00000000-0000-4000-8000-${String(modified).padStart(12, "0")}`;
  return {
    path,
    name: path.split("\\").pop() ?? path,
    modified,
    pinned: false,
    missing: false,
    sessions: [
      {
        id,
        file: `${id}.jsonl`,
        cwd: path,
        label: "hello",
        full: "hello",
        count: 2,
        modified,
        sizeKb: 1,
        profile: PROFILE,
        slug: "s",
        partial: false,
      },
    ],
  };
}

function setData(groups: Group[], projects: Project[]) {
  store.set({
    platform: { os: "windows", build: "", arch: "" },
    profiles: [{ dir: PROFILE, name: "default" } as never],
    settings: { ...DEFAULT_SETTINGS, groups, pinned: [] },
    index: { gen: store.get().index.gen + 1, projects, loaded: "ok", error: null },
  });
}

const rowEl = (key: string) => document.querySelector<HTMLElement>(`.sb-tree .list-row[data-key="${CSS.escape(key)}"]`);
const tree = () => document.querySelector<HTMLElement>(".sb-tree") as HTMLElement;
const key = (k: string) => tree().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const press = (el: HTMLElement | null, x = 100) =>
  el?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: x, clientY: 5 }));

beforeAll(async () => {
  document.body.innerHTML = `<span id="tb-subtitle"></span><aside id="sidebar-slot"></aside><div id="overlay-root"></div>`;
  const { mount } = await import("./index");
  mount();
});

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  store.set({ sidebarSelection: null, sidebarShowAll: [] });
  setData(
    [{ name: "Web", folders: ["C:\\src\\site", "C:\\src\\api"], collapsed: false }],
    [project("C:\\src\\site", 300), project("C:\\src\\api", 200), project("C:\\src\\tools", 100)],
  );
});

afterEach(() => closeMenus());

describe("sidebar view", () => {
  it("renders an ARIA tree and selects the first row", () => {
    expect(tree().getAttribute("role")).toBe("tree");
    expect(rowEl("g:web")?.getAttribute("aria-expanded")).toBe("true");
    expect(rowEl("f:c:\\src\\site")?.getAttribute("aria-level")).toBe("2");
    expect(rowEl("f:c:\\src\\tools")?.getAttribute("aria-level")).toBe("1");
    expect(store.get().sidebarSelection).toEqual({
      kind: "group",
      key: "g:web",
      name: "Web",
      folders: ["C:\\src\\site", "C:\\src\\api"],
    });
    expect(document.getElementById("tb-subtitle")?.textContent).toBe(
      "All profiles · 3 sessions · 3 folders · 1 project",
    );
  });

  it("moves with the arrows and publishes folder selections", () => {
    tree().focus();
    key("ArrowDown");
    expect(store.get().sidebarSelection).toMatchObject({ kind: "folder", path: "C:\\src\\site", name: "site" });
    key("ArrowLeft"); // from a folder in a project back to the project
    expect(store.get().sidebarSelection?.key).toBe("g:web");
  });

  it("opens and closes a project with the chevron, the arrows and Enter", () => {
    press(rowEl("g:web"), 10);
    expect(store.get().settings.groups[0]?.collapsed).toBe(true);
    expect(rowEl("f:c:\\src\\site")).toBeNull();
    key("ArrowRight");
    expect(store.get().settings.groups[0]?.collapsed).toBe(false);
    key("ArrowLeft");
    expect(store.get().settings.groups[0]?.collapsed).toBe(true);
    key("Enter");
    expect(store.get().settings.groups[0]?.collapsed).toBe(false);
  });

  it("collapses FOLDERS from its heading and keeps it in settings", () => {
    press(rowEl("s:folders"));
    expect(store.get().settings.ungroupedCollapsed).toBe(true);
    expect(rowEl("f:c:\\src\\tools")).toBeNull();
    press(rowEl("s:folders"));
    expect(store.get().settings.ungroupedCollapsed).toBe(false);
  });

  it("starts a session in a folder on Enter", () => {
    const launches: LaunchRequest[] = [];
    const off = on("launch", (r) => launches.push(r));
    store.set({ currentProfile: null });
    tree().focus();
    key("End");
    key("Enter");
    off();
    expect(launches).toEqual([{ dir: "C:\\src\\tools", profile: PROFILE, mode: undefined }]);
  });

  it("asks before deleting a project on Delete", () => {
    press(rowEl("g:web"));
    key("Delete");
    expect(dialog.ask).toHaveBeenCalledWith(
      expect.stringContaining("Delete the project 'Web'?"),
      "Delete project",
      "warning",
    );
  });

  it("selects a folder by key, opening its project and its full folder list", () => {
    store.set({
      settings: { ...store.get().settings, groups: [{ name: "Web", folders: ["C:\\src\\site"], collapsed: true }] },
    });
    expect(rowEl("f:c:\\src\\site")).toBeNull();
    emit("sidebar:select", { key: "f:c:\\src\\site" });
    expect(store.get().settings.groups[0]?.collapsed).toBe(false);
    expect(store.get().sidebarShowAll).toEqual(["web"]);
    expect(store.get().sidebarSelection?.path).toBe("C:\\src\\site");
  });

  it("shows the folder menu on right-click with the OS labels", () => {
    rowEl("f:c:\\src\\tools")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    const labels = [...document.querySelectorAll(".menu .mi-label")].map((e) => e.textContent);
    expect(labels).toEqual([
      "New session",
      "New session in new window",
      "New session inside app",
      "New session with profile",
      "Continue last session",
      "Open PowerShell here",
      "Open in Explorer",
      "Open in VS Code",
      "Copy path",
      "Move to project",
      "Pin",
      "Delete all sessions...",
    ]);
    expect(store.get().sidebarSelection?.path).toBe("C:\\src\\tools");
  });

  it("offers 'Remove from project' for a grouped folder and the project menu for a group", () => {
    rowEl("f:c:\\src\\site")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    expect([...document.querySelectorAll(".menu .mi-label")].map((e) => e.textContent)).toContain(
      "Remove from project",
    );
    closeMenus();
    rowEl("g:web")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    expect([...document.querySelectorAll(".menu .mi-label")].map((e) => e.textContent)).toEqual([
      "New session in...",
      "Continue last session",
      "Open in VS Code",
      "Rename project...",
      "Delete project",
      "New project...",
    ]);
  });

  it("shows the load states", () => {
    store.set({ index: { gen: 99, projects: [], loaded: "error", error: "disk on fire" } });
    const status = document.querySelector<HTMLElement>(".sb-status");
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toContain("Could not read the sessions");
    expect(status?.querySelector("button")?.textContent).toBe("Retry");
    store.set({ index: { gen: 100, projects: [], loaded: "empty", error: null } });
    expect(status?.textContent).toBe("No Claude Code sessions found");
  });

  it("looks up whether grouped folders the index does not list still exist", () => {
    store.set({
      settings: { ...store.get().settings, groups: [{ name: "Web", folders: ["C:\\elsewhere"], collapsed: false }] },
    });
    expect(calls).toContainEqual({ cmd: "path_kinds", args: { paths: ["C:\\elsewhere"] } });
  });
});
