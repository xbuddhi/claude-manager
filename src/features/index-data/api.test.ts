import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexSnapshot } from "../../bindings/IndexSnapshot";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { store } from "../../core/store";

const callMock = vi.fn();
vi.mock("../../core/api", () => ({ call: (...args: unknown[]) => callMock(...args) }));

const {
  countFor,
  fillCwd,
  findSession,
  mergeIndex,
  projectsFor,
  refreshIndex,
  resetIndexClient,
  sessionText,
  sessionTextCached,
  sessionTextLast,
  visibleProjects,
} = await import("./api");

const session = (id: string, profile: string, label = id): Session => ({
  id,
  file: `${id}.jsonl`,
  cwd: null,
  label,
  count: 1,
  modified: 1,
  sizeKb: 1,
  profile,
  slug: "s",
  partial: false,
});

const project = (name: string, sessions: Session[], pinned = false): Project => ({
  path: `/code/${name}`,
  name,
  modified: 1,
  pinned,
  missing: false,
  sessions,
});

const snap = (gen: number, projects: Project[] | null, ready = true): IndexSnapshot => ({
  gen,
  ready,
  projects,
  counts: [],
  base: null,
  changed: null,
  order: null,
});

const delta = (gen: number, base: number, changed: Project[], order: string[]): IndexSnapshot => ({
  ...snap(gen, null),
  base,
  changed,
  order,
});

const ok = (value: unknown) => ({ ok: true, value });

describe("refreshIndex", () => {
  const initial = store.get();
  beforeEach(() => {
    resetIndexClient();
    callMock.mockReset();
    callMock.mockResolvedValue(ok(snap(0, null, false)));
  });
  afterEach(() => store.set(initial));

  it("stays loading until the backend is ready, then fills the store", async () => {
    callMock.mockResolvedValueOnce(ok(snap(0, null, false)));
    await refreshIndex();
    expect(store.get().index.loaded).toBe("loading");
    const projects = [project("app", [session("a", "/p")])];
    callMock.mockResolvedValueOnce(ok(snap(3, projects)));
    await refreshIndex();
    expect(store.get().index).toEqual({ gen: 3, projects, loaded: "ok", error: null });
    expect(callMock).toHaveBeenLastCalledWith("get_index", { sinceGen: null }, { quiet: true });
  });

  it("asks only for changes and keeps the same data when nothing changed", async () => {
    const projects = [project("app", [session("a", "/p")])];
    callMock.mockResolvedValueOnce(ok(snap(5, projects)));
    await refreshIndex();
    const before = store.get().index;
    callMock.mockResolvedValueOnce(ok(snap(5, null)));
    await refreshIndex();
    expect(callMock).toHaveBeenLastCalledWith("get_index", { sinceGen: 5 }, { quiet: true });
    expect(store.get().index).toBe(before);
  });

  it("applies only the changes, keeping unchanged projects and the backend's order", async () => {
    const app = project("app", [session("a", "/p")]);
    const lib = project("lib", [session("l", "/p")]);
    const old = project("old", [session("o", "/p")]);
    callMock.mockResolvedValueOnce(ok(snap(2, [app, lib, old])));
    await refreshIndex();
    const newer = project("lib", [session("l", "/p"), session("l2", "/p")]);
    const added = project("new", [session("n", "/p")]);
    callMock.mockResolvedValueOnce(ok(delta(3, 2, [newer, added], ["/code/new", "/code/lib", "/code/app"])));
    await refreshIndex();
    expect(callMock).toHaveBeenLastCalledWith("get_index", { sinceGen: 2 }, { quiet: true });
    const { projects, gen } = store.get().index;
    expect(gen).toBe(3);
    expect(projects.map((p) => p.name)).toEqual(["new", "lib", "app"]);
    expect(projects[2]).toBe(app);
    expect(projects[1]).toBe(newer);
    // the cwd left out by the backend is filled in for changed projects too
    expect(projects[0]?.sessions[0]?.cwd).toBe("/code/new");
  });

  it("asks for every project when the changes do not fit what is held", async () => {
    callMock.mockResolvedValueOnce(ok(snap(2, [project("app", [session("a", "/p")])])));
    await refreshIndex();
    callMock.mockResolvedValueOnce(ok(delta(4, 1, [], ["/code/app"])));
    const full = [project("lib", [session("l", "/p")])];
    callMock.mockResolvedValueOnce(ok(snap(4, full)));
    await refreshIndex();
    await vi.waitFor(() => expect(store.get().index.gen).toBe(4));
    expect(callMock).toHaveBeenLastCalledWith("get_index", { sinceGen: null }, { quiet: true });
    expect(store.get().index.projects).toBe(full);
  });

  it("reports no sessions as empty", async () => {
    callMock.mockResolvedValueOnce(ok(snap(1, [])));
    await refreshIndex();
    expect(store.get().index.loaded).toBe("empty");
  });

  it("shows an error only when nothing was loaded yet", async () => {
    callMock.mockResolvedValueOnce({ ok: false, error: { code: "io", message: "denied" } });
    await refreshIndex();
    expect(store.get().index).toMatchObject({ loaded: "error", error: "denied" });
    callMock.mockResolvedValueOnce(ok(snap(2, [project("app", [session("a", "/p")])])));
    await refreshIndex();
    callMock.mockResolvedValueOnce({ ok: false, error: { code: "io", message: "again" } });
    await refreshIndex();
    expect(store.get().index).toMatchObject({ loaded: "ok", error: "again" });
  });

  it("merges calls made while one runs into one more, and ignores older answers", async () => {
    let release: (v: unknown) => void = () => {};
    callMock.mockReturnValueOnce(new Promise((r) => (release = r)));
    const first = refreshIndex();
    void refreshIndex();
    void refreshIndex();
    expect(callMock).toHaveBeenCalledTimes(1);
    callMock.mockResolvedValueOnce(ok(snap(4, [project("old", [session("o", "/p")])])));
    release(ok(snap(7, [project("new", [session("n", "/p")])])));
    await first;
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.get().index.gen).toBe(7);
    expect(store.get().index.projects[0]?.name).toBe("new");
  });
});

describe("index queries", () => {
  const initial = store.get();
  afterEach(() => store.set(initial));

  const projects = [
    project("app", [session("a1", "/work", "Fix login"), session("a2", "/home", "Write docs")]),
    project("lib", [session("l1", "/home", "Refactor")]),
    project("pinned", [], true),
  ];

  it("filters by profile and keeps pinned folders", () => {
    expect(visibleProjects(projects, "/work", "").map((p) => p.name)).toEqual(["app", "pinned"]);
    expect(projectsFor("/home", projects).map((p) => [p.name, p.sessions.length])).toEqual([
      ["app", 1],
      ["lib", 1],
      ["pinned", 0],
    ]);
    expect(visibleProjects(projects, null, "")).toHaveLength(3);
  });

  it("keeps the projects of a profile as the same objects while their sessions are unchanged", () => {
    const first = projectsFor("/home", projects);
    expect(projectsFor("/home", projects)).toBe(first);
    // another project changed: a new list, but the untouched projects are the objects from before
    const changed = [
      projects[0] as Project,
      project("lib", [session("l1", "/home", "Renamed")]),
      projects[2] as Project,
    ];
    const next = projectsFor("/home", changed);
    expect(next).not.toBe(first);
    expect(next[0]).toBe(first[0]);
    expect(next[1]).not.toBe(first[1]);
    // a project whose sessions are all in view is not copied
    expect(projectsFor("/home", changed)[1]).toBe(changed[1]);
  });

  it("searches names, paths and labels of visible sessions, case-insensitively", () => {
    expect(visibleProjects(projects, null, "  LOGIN ").map((p) => p.name)).toEqual(["app"]);
    expect(visibleProjects(projects, "/home", "login")).toEqual([]);
    expect(visibleProjects(projects, null, "/code/LIB").map((p) => p.name)).toEqual(["lib"]);
    expect(visibleProjects(projects, null, "pinn").map((p) => p.name)).toEqual(["pinned"]);
  });

  it("finds sessions and counts them per profile", async () => {
    resetIndexClient();
    store.set({ index: { gen: 1, projects, loaded: "ok", error: null } });
    expect(findSession("l1")?.project.name).toBe("lib");
    expect(findSession("nope")).toBeNull();
    expect([countFor(null), countFor("/home"), countFor("/x")]).toEqual([3, 2, 0]);
    callMock.mockResolvedValueOnce(
      ok({ ...snap(9, projects), counts: [{ profile: "/home", count: 5 }] } satisfies IndexSnapshot),
    );
    await refreshIndex();
    expect([countFor(null), countFor("/home"), countFor("/work")]).toEqual([5, 5, 0]);
  });
});

describe("session text", () => {
  it("asks once for renders close together, and keeps the last text while a running session changes", async () => {
    resetIndexClient();
    callMock.mockReset();
    callMock.mockResolvedValue(ok("full text"));
    const s = session("t1", "/p");
    const [a, b] = await Promise.all([sessionText(s), sessionText(s)]);
    expect([a, b]).toEqual(["full text", "full text"]);
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(sessionTextCached(s)).toBe("full text");
    const later = { ...s, modified: 2 };
    expect(sessionTextCached(later)).toBeUndefined();
    expect(sessionTextLast(later)).toBe("full text");
  });

  it("does not keep the text of a transcript read only partly", async () => {
    resetIndexClient();
    callMock.mockReset();
    callMock.mockResolvedValue(ok("first prompt"));
    const s = { ...session("t2", "/p"), partial: true };
    expect(await sessionText(s)).toBe("first prompt");
    expect(sessionTextCached({ ...s, partial: false })).toBeUndefined();
  });
});

describe("mergeIndex", () => {
  const a = project("a", [session("a1", "/p")]);
  const b = project("b", [session("b1", "/p")]);
  const c = project("c", [session("c1", "/p")]);

  it("replaces by path, drops paths not in the order and follows the order", () => {
    const b2 = project("b", [session("b2", "/p")]);
    const merged = mergeIndex([a, b, c], [b2], ["/code/b", "/code/a"]);
    expect(merged).toEqual([b2, a]);
    expect(merged?.[1]).toBe(a);
  });

  it("returns the held list itself when nothing changed", () => {
    const held = [a, b];
    expect(mergeIndex(held, [], ["/code/a", "/code/b"])).toBe(held);
    expect(mergeIndex(held, [], ["/code/b", "/code/a"])).not.toBe(held);
  });

  it("gives null when a path is unknown", () => {
    expect(mergeIndex([a], [], ["/code/a", "/code/x"])).toBeNull();
  });

  it("matches the full list the backend would send", () => {
    const b2 = project("b", [session("b2", "/p")]);
    const d = project("d", [session("d1", "/p")]);
    const full = [d, b2, a];
    const merged = mergeIndex(
      [a, b, c],
      [d, b2],
      full.map((p) => p.path),
    );
    expect(merged).toEqual(full);
  });
});

describe("fillCwd", () => {
  it("puts back the folder the backend left out, but not for an unknown folder", () => {
    const known = project("app", [session("a", "p"), { ...session("b", "p"), cwd: "/code/app/sub" }]);
    const unknown: Project = { ...project("x", [session("c", "p")]), path: "s", name: "Unknown folder" };
    fillCwd([known, unknown]);
    expect(known.sessions.map((s) => s.cwd)).toEqual(["/code/app", "/code/app/sub"]);
    expect(unknown.sessions[0]?.cwd).toBeNull();
  });
});
