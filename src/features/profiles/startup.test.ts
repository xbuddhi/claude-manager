import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../../bindings/Profile";
import { DEFAULT_SETTINGS, store } from "../../core/store";

const saved: Array<Record<string, unknown>> = [];
vi.mock("../../core/settings", async (orig) => ({
  ...(await orig<typeof import("../../core/settings")>()),
  updateSettings: async (patch: Record<string, unknown>) => {
    saved.push(patch);
    return true;
  },
}));

const { enterProfile, startChoice } = await import("./startup");

const home = "C:\\Users\\me";
const profile = (dir: string, name: string): Profile => ({
  dir,
  name,
  email: null,
  signedIn: null,
  isDefault: name === "default",
});
const profiles = [profile(`${home}\\.claude`, "default"), profile(`${home}\\.claude-work`, "work")];

describe("startChoice (which screen the app opens on)", () => {
  const choose = (showPicker: boolean, lastProfile: string | null) =>
    startChoice({ showPicker, lastProfile }, profiles, "windows");

  it("shows the picker when the setting asks, whatever the last profile", () => {
    for (const last of [null, "", "all", `${home}\\.claude-work`, `${home}\\.claude-gone`]) {
      expect(choose(true, last)).toEqual({ picker: true });
    }
  });

  it("shows the picker when no profile was entered before", () => {
    expect(choose(false, null)).toEqual({ picker: true });
    expect(choose(false, "")).toEqual({ picker: true });
    expect(choose(false, "  ")).toEqual({ picker: true });
  });

  it("opens all profiles for 'all'", () => {
    expect(choose(false, "all")).toEqual({ picker: false, dir: null });
  });

  it("shows the picker when the last profile is gone", () => {
    expect(choose(false, `${home}\\.claude-gone`)).toEqual({ picker: true });
  });

  it("opens the last profile, as discovery spells it", () => {
    expect(choose(false, `${home}\\.claude-work`)).toEqual({ picker: false, dir: `${home}\\.claude-work` });
    expect(choose(false, "c:/users/me/.claude-work/")).toEqual({ picker: false, dir: `${home}\\.claude-work` });
  });
});

describe("enterProfile", () => {
  const initial = store.get();
  beforeEach(() => {
    saved.length = 0;
    store.set({
      profiles,
      platform: { os: "windows", build: "", arch: "" },
      settings: DEFAULT_SETTINGS,
      screen: "picker",
      currentProfile: null,
      searchQuery: "old query",
    });
  });
  afterEach(() => store.set(initial));

  it("enters a profile: shows main, clears search, remembers it as account and last profile", () => {
    enterProfile(`${home}\\.CLAUDE-work`, { focus: false });
    const s = store.get();
    expect(s.currentProfile).toBe(`${home}\\.claude-work`);
    expect(s.screen).toBe("main");
    expect(s.searchQuery).toBe("");
    expect(saved).toEqual([{ account: `${home}\\.claude-work`, lastProfile: `${home}\\.claude-work` }]);
  });

  it("enters all profiles without touching the account", () => {
    enterProfile(null, { focus: false });
    expect(store.get().currentProfile).toBeNull();
    expect(store.get().screen).toBe("main");
    expect(saved).toEqual([{ lastProfile: "all" }]);
  });

  it("refuses a folder that is not a profile", () => {
    enterProfile(`${home}\\.claude-gone`, { focus: false });
    expect(store.get().screen).toBe("picker");
    expect(saved).toEqual([]);
  });
});
