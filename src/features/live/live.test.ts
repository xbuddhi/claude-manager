import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSession } from "../../bindings/LiveSession";
import type { Orphan } from "../../bindings/Orphan";
import { bus } from "../../core/bus";
import { store, type TermInfo } from "../../core/store";

const calls: Array<{ cmd: string; args: unknown }> = [];
const answers: Record<string, unknown> = {};
vi.mock("../../core/api", () => ({
  call: async (cmd: string, args: unknown) => {
    calls.push({ cmd, args });
    return { ok: true, value: answers[cmd] ?? null };
  },
  listen: async () => () => {},
}));
const dialogs: string[] = [];
let confirm = true;
vi.mock("../../ui/dialog", () => ({
  ask: async (text: string) => {
    dialogs.push(text);
    return confirm;
  },
  message: async (text: string) => {
    dialogs.push(text);
  },
}));

const { folderLevel, focusLive, liveDot, liveDotHtml, sessionLevel } = await import("./api");
const { activePid, applyLive } = await import("./index");
const { closeOrphans, orphanQuestion } = await import("./orphans");
const { tabFor } = await import("./focus");

const A = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const B = "1f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

const session = (id: string, pid: number, level: 1 | 2, cwd: string | null): LiveSession => ({
  sessionId: id,
  pid,
  level,
  cwd,
  profile: "C:\\Users\\me\\.claude",
  reachable: true,
});

const term = (id: number, pid: number | null, sessionId: string | null, exited = false): TermInfo => ({
  id,
  ptyId: id,
  pid,
  title: "t",
  sub: "s",
  dir: "C:\\code",
  profile: "C:\\Users\\me\\.claude",
  sessionId,
  exited,
});

const initial = store.get();
beforeEach(() => {
  calls.length = 0;
  dialogs.length = 0;
  confirm = true;
  for (const k of Object.keys(answers)) delete answers[k];
});
afterEach(() => store.set(initial));

describe("live state", () => {
  it("indexes sessions by id and reads levels per session and folder", () => {
    store.set({ platform: { os: "windows", build: "", arch: "" } });
    applyLive({ sessions: [session(A, 10, 2, "C:\\Code\\App")], liveCwd: { "c:\\code\\app": 2 } });
    expect(sessionLevel(A)).toBe(2);
    expect(sessionLevel(B)).toBe(0);
    expect(folderLevel("C:/code/app/")).toBe(2);
    expect(folderLevel("C:\\other")).toBe(0);
  });

  it("keeps the objects of a scan that changed nothing, and of entries that did not change", () => {
    applyLive({
      sessions: [session(A, 10, 2, "C:\\Code\\App"), session(B, 11, 1, null)],
      liveCwd: { "c:\\code\\app": 2 },
    });
    const held = store.get();
    applyLive({
      sessions: [session(A, 10, 2, "C:\\Code\\App"), session(B, 11, 1, null)],
      liveCwd: { "c:\\code\\app": 2 },
    });
    expect(store.get().live).toBe(held.live);
    expect(store.get().liveCwd).toBe(held.liveCwd);
    applyLive({
      sessions: [session(A, 10, 1, "C:\\Code\\App"), session(B, 11, 1, null)],
      liveCwd: { "c:\\code\\app": 2 },
    });
    expect(store.get().live).not.toBe(held.live);
    expect(store.get().live[B]).toBe(held.live[B]);
    expect(store.get().liveCwd).toBe(held.liveCwd);
  });

  it("reports the pid of the running tab in front only", () => {
    const terminals = [term(1, 100, null), term(2, 200, null, true)];
    store.set({ terminals, activeTerminal: 1 });
    expect(activePid(store.get())).toBe(100);
    store.set({ activeTerminal: 2 });
    expect(activePid(store.get())).toBeNull();
    store.set({ activeTerminal: null });
    expect(activePid(store.get())).toBeNull();
  });
});

describe("live dot", () => {
  it("renders one marker per level", () => {
    expect(liveDot(2).dataset.level).toBe("2");
    expect(liveDotHtml(1).value).toBe('<span class="live-dot" data-level="1" aria-hidden="true"></span>');
    expect(liveDotHtml("<b>" as unknown as 1).value).toContain('data-level="0"');
  });
});

describe("focusLive", () => {
  it("matches a tab by the session's process chain, else a pending tab for the same session", () => {
    const terms = [term(1, 50, null), term(2, 60, B), term(3, null, A), term(4, 70, null, true)];
    expect(tabFor(A, [99, 60, 1], terms)?.id).toBe(2);
    expect(tabFor(A, [99], terms)?.id).toBe(3);
    expect(tabFor(B, [70], terms)).toBeNull();
  });

  it("switches to the tab, or asks the backend for an outside window", async () => {
    const shown: Array<number | null> = [];
    const off = bus.on("terminal:show", ({ id }) => shown.push(id));
    store.set({ live: { [A]: session(A, 61, 1, null) }, terminals: [term(5, 60, null)] });
    answers.live_ancestors = [61, 60];
    expect(await focusLive(A)).toBe(true);
    expect(shown).toEqual([5]);
    expect(calls.map((c) => c.cmd)).toEqual(["live_ancestors"]);

    calls.length = 0;
    answers.live_ancestors = [61, 7];
    answers.focus_live = true;
    expect(await focusLive(A)).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["live_ancestors", "focus_live"]);
    off();

    calls.length = 0;
    expect(await focusLive(B)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("close background sessions", () => {
  const orphan = (pid: number, cwd: string | null): Orphan => ({ pid, sessionId: A, cwd, profile: "p" });

  it("lists at most six, by folder name", () => {
    const text = orphanQuestion([
      orphan(1, "C:\\code\\web\\"),
      orphan(2, null),
      ...[3, 4, 5, 6, 7].map((p) => orphan(p, "/u/x")),
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Close 7 background sessions?");
    expect(lines[2]).toBe("  - web  (pid 1)");
    expect(lines[3]).toBe("  - session  (pid 2)");
    expect(lines).toHaveLength(8);
    expect(orphanQuestion([orphan(9, "/a")]).split("\n")[0]).toBe("Close 1 background session?");
  });

  it("says so when there is nothing to close", async () => {
    answers.find_orphans = [];
    store.set({ currentProfile: "C:\\Users\\me\\.claude-work" });
    await closeOrphans();
    expect(calls).toEqual([{ cmd: "find_orphans", args: { profile: "C:\\Users\\me\\.claude-work" } }]);
    expect(dialogs[0]).toBe("No background sessions to close\nEvery running session can be reached from a window.");
  });

  it("ends them only after a yes", async () => {
    answers.find_orphans = [orphan(11, "/a"), orphan(12, "/b")];
    confirm = false;
    await closeOrphans();
    expect(calls.map((c) => c.cmd)).toEqual(["find_orphans"]);
    confirm = true;
    await closeOrphans();
    expect(calls[calls.length - 1]).toEqual({ cmd: "close_orphans", args: { pids: [11, 12] } });
  });
});
