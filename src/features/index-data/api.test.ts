import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexSnapshot } from "../../bindings/IndexSnapshot";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { store } from "../../core/store";

const callMock = vi.fn();
vi.mock("../../core/api", () => ({ call: (...args: unknown[]) => callMock(...args) }));

const { countFor, fillCwd, findSession, projectsFor, refreshIndex, resetIndexClient, visibleProjects } = await import(
  "./api"
);

const session = (id: string, profile: string, label = id): Session => ({
  id,
  file: `${id}.jsonl`,
  cwd: null,
  label,
  full: label,
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
      ok({ gen: 9, ready: true, projects, counts: [{ profile: "/home", count: 5 }] } satisfies IndexSnapshot),
    );
    await refreshIndex();
    expect([countFor(null), countFor("/home"), countFor("/work")]).toEqual([5, 5, 0]);
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
