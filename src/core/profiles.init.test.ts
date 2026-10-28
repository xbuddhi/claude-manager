import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../bindings/Profile";

const handlers = new Map<string, (payload: unknown) => void>();
const list = (): Profile[] => [
  { dir: "/u/.claude", name: "default", email: null, signedIn: null, isDefault: true },
  { dir: "/u/.claude-work", name: "work", email: "a@b.c", signedIn: true, isDefault: false },
];
vi.mock("./api", () => ({
  call: vi.fn(async () => ({ ok: true, value: list() })),
  listen: vi.fn(async (name: string, fn: (payload: unknown) => void) => {
    handlers.set(name, fn);
    return () => {};
  }),
}));

const { initProfiles, profileName } = await import("./profiles");
const { store } = await import("./store");

describe("profiles mirror", () => {
  it("keeps the published arrays when the backend sends the same profiles again", async () => {
    await initProfiles();
    const shown = store.get().profiles;
    expect(shown.map((p) => p.name)).toEqual(["default", "work"]);
    const fired = vi.fn();
    const stop = store.select((s) => s.profiles, fired);
    handlers.get("profiles-changed")?.(list());
    expect(store.get().profiles).toBe(shown);
    expect(fired).not.toHaveBeenCalled();
    // a real change is published
    handlers.get("profiles-changed")?.([list()[0]]);
    expect(store.get().profiles.map((p) => p.name)).toEqual(["default"]);
    expect(profileName("/u/.claude-work")).toBe(".claude-work");
    stop();
  });
});
