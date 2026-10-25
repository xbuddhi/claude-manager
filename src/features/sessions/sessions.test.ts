import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { DEFAULT_SETTINGS, store } from "../../core/store";
import { detailsFor } from "./details";
import { buildScope, sessionDir } from "./model";
import {
  countText,
  deleteConfirm,
  deleteLabel,
  deleteTip,
  detailMeta,
  detailText,
  folderWhat,
  lastActive,
  longDate,
  resumeTip,
} from "./strings";
import { cells } from "./table";

const call = vi.hoisted(() => vi.fn());
const ask = vi.hoisted(() => vi.fn());
vi.mock("../../core/api", () => ({ call, listen: async () => () => {} }));
vi.mock("../../ui/dialog", () => ({ ask }));

const { deleteSessions } = await import("./api");

const PROFILE = "C:\\Users\\me\\.claude-work";
let seq = 0;
function session(label: string, modified: number, cwd: string | null = "C:\\code\\app"): Session {
  const id = `00000000-0000-0000-0000-${String(++seq).padStart(12, "0")}`;
  return {
    id,
    file: `${PROFILE}\\projects\\C--code-app\\${id}.jsonl`,
    cwd,
    label,
    full: `${label} (full text)`,
    count: 12,
    modified,
    sizeKb: 1536,
    profile: PROFILE,
    slug: "C--code-app",
    partial: false,
  };
}
const project = (path: string, sessions: Session[]): Project => ({
  path,
  name: path,
  modified: sessions[0]?.modified ?? 0,
  pinned: false,
  missing: false,
  sessions,
});

describe("strings", () => {
  it("count, last active and the long date", () => {
    expect(countText(12, "app")).toBe("12   in   app");
    const now = new Date(2026, 9, 25, 14, 5).getTime();
    expect(lastActive(2, now - 3_600_000, now)).toBe("Working...");
    expect(lastActive(1, now, now)).toBe("Open now");
    expect(lastActive(0, now - 3_600_000, now)).toBe("1h ago");
    expect(longDate(new Date(2026, 9, 25, 9, 5).getTime())).toBe("Sun, Oct 25 2026  09:05");
  });

  it("details text says when the session runs", () => {
    expect(detailText("Fix it", 0)).toBe("Fix it");
    expect(detailText("Fix it", 1)).toBe("This session is open. Double-click to switch to it.\nFix it");
    expect(detailText("Fix it", 2)).toBe("Claude is working in this session. Double-click to switch to it.\nFix it");
    const s = { modified: new Date(2026, 0, 2, 23, 59).getTime(), count: 7, id: "abc" };
    expect(detailMeta(s, "work")).toBe("Fri, Jan 2 2026  23:59     7 messages     profile: work     abc");
  });

  it("delete confirmation for 1, 3 and 7 sessions, Recycle Bin on Windows and Trash on macOS", () => {
    expect(deleteConfirm(["a"], false)).toBe(
      "Move this session to the Recycle Bin?\n\n  - a\n\nIf one is open in a terminal, close it first.",
    );
    expect(deleteConfirm(["a", "b", "c"], true)).toBe(
      "Move these 3 sessions to the Trash?\n\n  - a\n  - b\n  - c\n\nIf one is open in a terminal, close it first.",
    );
    const seven = deleteConfirm(["1", "2", "3", "4", "5", "6", "7"], false);
    expect(seven).toBe(
      "Move these 7 sessions to the Recycle Bin?\n\n  - 1\n  - 2\n  - 3\n  - 4\n  - 5\n  ... and 2 more\n\nIf one is open in a terminal, close it first.",
    );
    expect(deleteConfirm(["a", "b"], true, folderWhat(2, "app"))).toMatch(
      /^Move all 2 sessions of 'app' to the Trash\?/,
    );
  });

  it("buttons and tooltips", () => {
    expect(deleteLabel(1)).toBe("");
    expect(deleteLabel(4)).toBe("Delete 4");
    expect(resumeTip(false)).toBe("Resume this session  (Enter)");
    expect(resumeTip(true)).toBe("Resume this session  (Return)");
    expect(deleteTip(1, false)).toBe("Delete this session  (Del)");
    expect(deleteTip(3, true)).toBe("Delete these 3 sessions  (⌘⌫)");
  });
});

describe("table cells", () => {
  it("fills the folder and the group columns", () => {
    const now = new Date(2026, 9, 25, 12).getTime();
    const s = session("Fix it", now - 120_000, "C:\\code\\web\\");
    expect(cells(s, "folder", 0, "work", now)).toEqual(["Fix it", "12", "2m ago", "work", "1.5 MB"]);
    expect(cells(s, "group", 2, "work", now)).toEqual(["Fix it", "web", "12", "Working...", "work"]);
    expect(cells({ ...s, cwd: null }, "group", 0, "work", now)[1]).toBe("");
  });
});

describe("scope and details pane", () => {
  const a1 = session("a1", 300, "C:\\code\\a");
  const a2 = session("a2", 100, "C:\\code\\a");
  const b1 = session("b1", 200, null);
  const projects = [project("C:\\code\\a", [a1, a2]), project("C:\\code\\b", [b1]), project("C:\\code\\empty", [])];
  const name = () => "work";

  it("a folder lists its sessions; a group merges its folders newest first", () => {
    const folder = buildScope({ kind: "folder", key: "f:c:\\code\\a", path: "c:/code/a/" }, projects, "windows");
    expect(folder).toMatchObject({ kind: "folder", name: "a", sessions: [a1, a2] });
    const group = buildScope(
      { kind: "group", key: "g:web", name: "Web", folders: ["C:\\code\\a", "C:\\code\\b", "C:\\gone"] },
      projects,
      "windows",
    );
    expect(group?.sessions).toEqual([a1, b1, a2]);
    expect(buildScope(null, projects, "windows")).toBeNull();
    // a session without a cwd starts in the folder it is listed under
    expect(sessionDir(b1, projects, null)).toBe("C:\\code\\b");
    expect(sessionDir(a1, projects, null)).toBe("C:\\code\\a");
  });

  it("shows the selected session, else a hint for what is selected", () => {
    const folder = buildScope({ kind: "folder", key: "f", path: "C:\\code\\a" }, projects, "windows");
    expect(detailsFor(folder, [a1], 1, name).text).toBe(
      "This session is open. Double-click to switch to it.\na1 (full text)",
    );
    expect(detailsFor(folder, [a1], 0, name).meta).toContain("12 messages     profile: work     ");
    const empty = buildScope({ kind: "folder", key: "f", path: "C:\\code\\empty" }, projects, "windows");
    expect(detailsFor(empty, [], 0, name)).toEqual({
      text: "No sessions yet. Double-click the folder (or press New Session) to start one.",
      meta: "C:\\code\\empty",
    });
    const group = buildScope(
      { kind: "group", key: "g", name: "Web", folders: ["C:\\code\\a", "C:\\code\\b"] },
      projects,
      "windows",
    );
    expect(detailsFor(group, [], 0, name)).toEqual({
      text: "Project 'Web': 2 folder(s). Drag folders onto it in the sidebar, or right-click a folder and pick Move to project. Folders on disk are never moved.",
      meta: "C:\\code\\a     C:\\code\\b",
    });
    expect(detailsFor(null, [], 0, name).text).toBe(
      "Double-click a project to start a session, or a session to resume it. Drop a folder on the window to start there. Right-click for more.",
    );
    expect(detailsFor(folder, [], 0, name).meta).toBe("C:\\code\\a");
  });
});

describe("deleteSessions", () => {
  const initial = store.get();
  afterEach(() => {
    store.set(initial);
    call.mockReset();
    ask.mockReset();
  });

  it("asks, then trashes by profile and id, and unpins the folder", async () => {
    const s = session("Fix it", 1);
    store.set({
      platform: { os: "windows", build: "", arch: "" },
      settings: { ...DEFAULT_SETTINGS, pinned: ["C:\\code\\app", "C:\\other"] },
    });
    ask.mockResolvedValue(true);
    call.mockImplementation(async (cmd: string, args: { patch?: object }) => {
      if (cmd === "trash_sessions") return { ok: true, value: { trashed: [s.id], failed: [] } };
      if (cmd === "update_settings") return { ok: true, value: { ...store.get().settings, ...args.patch } };
      return { ok: true, value: [] };
    });
    expect(await deleteSessions([s], { unpinFolder: "c:/code/app/" })).toBe(true);
    expect(ask.mock.calls[0]?.[0]).toMatch(/^Move all 1 sessions of 'app' to the/);
    expect(call).toHaveBeenCalledWith("trash_sessions", { items: [{ profile: PROFILE, sessionId: s.id }] });
    expect(store.get().settings.pinned).toEqual(["C:\\other"]);
  });

  it("does nothing when the question is declined", async () => {
    ask.mockResolvedValue(false);
    expect(await deleteSessions([session("x", 1)])).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
});
