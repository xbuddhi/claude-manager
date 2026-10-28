import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../bindings/Settings";

const call = vi.fn();
vi.mock("./api", () => ({ call: (...args: unknown[]) => call(...args), listen: vi.fn(async () => () => {}) }));

const { applySettings, updateSettings } = await import("./settings");
const { DEFAULT_SETTINGS, store } = await import("./store");

const clone = (s: Settings): Settings => JSON.parse(JSON.stringify(s));

describe("settings mirror", () => {
  beforeEach(() => {
    store.set({ settings: { ...DEFAULT_SETTINGS, groups: [{ name: "G", folders: ["/a"], collapsed: false }] } });
    call.mockReset();
  });

  it("publishes a save once, not again for the backend's answer and echo", async () => {
    const groups = vi.fn();
    const pinned = vi.fn();
    const any = vi.fn();
    const stop = [
      store.select((s) => s.settings.groups, groups),
      store.select((s) => s.settings.pinned, pinned),
      store.subscribe(any),
    ];
    call.mockImplementation(async () => ({ ok: true, value: clone(store.get().settings) }));
    const before = store.get().settings.groups;
    expect(await updateSettings({ pinned: ["/x"] })).toBe(true);
    // the echo of `settings-changed`, new objects with the same content
    applySettings(clone(store.get().settings));
    expect(pinned).toHaveBeenCalledTimes(1);
    expect(groups).not.toHaveBeenCalled();
    expect(any).toHaveBeenCalledTimes(1);
    expect(store.get().settings.groups).toBe(before);
    for (const s of stop) s();
  });

  it("goes back to what the backend holds when a save fails", async () => {
    const held = clone(store.get().settings);
    call.mockImplementation(async (cmd: string) =>
      cmd === "get_settings" ? { ok: true, value: held } : { ok: false, error: { code: "internal", message: "x" } },
    );
    expect(await updateSettings({ theme: "dark" })).toBe(false);
    expect(store.get().settings.theme).toBe(held.theme);
  });
});
