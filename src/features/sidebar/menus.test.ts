import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../bindings/Session";
import { on } from "../../core/bus";

const sessionsApi = vi.hoisted(() => ({ continueLast: vi.fn(async () => {}), deleteSessions: vi.fn() }));
vi.mock("../sessions/api", () => sessionsApi);
vi.mock("../../core/api", () => ({
  call: vi.fn(async () => ({ ok: false, error: { code: "internal", message: "no backend in tests" } })),
  listen: vi.fn(async () => () => {}),
}));

const { continueLast } = await import("./menus");

describe("Continue last session", () => {
  it("goes through the sessions feature, which asks before resuming a session running elsewhere", () => {
    const s = { id: "a", profile: "/p", label: "x" } as unknown as Session;
    continueLast([s], "/dir");
    expect(sessionsApi.continueLast).toHaveBeenCalledWith([s], "/dir", undefined);
  });

  it("starts a new session when the folder has none", () => {
    const launched = vi.fn();
    on("launch", launched);
    sessionsApi.continueLast.mockClear();
    continueLast([], "/dir");
    expect(sessionsApi.continueLast).not.toHaveBeenCalled();
    expect(launched).toHaveBeenCalledWith(expect.objectContaining({ dir: "/dir" }));
  });
});
