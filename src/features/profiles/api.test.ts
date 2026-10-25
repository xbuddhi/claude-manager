import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../../bindings/Profile";
import { DEFAULT_SETTINGS, store } from "../../core/store";
import { profileColor, profileInitial, startProfile } from "./api";

const profile = (dir: string, name: string): Profile => ({
  dir,
  name,
  email: null,
  signedIn: null,
  isDefault: name === "default",
});

describe("profile avatars", () => {
  it("colour by the sum of the name's code units, mod 8", () => {
    // "default" = 741 -> 5, "work" = 451 -> 3
    expect(profileColor("default")).toBe("#5E5CE6");
    expect(profileColor("work")).toBe("#FF9F0A");
    expect(profileColor(null)).toBe("var(--ctrl)");
  });

  it("use the first letter, or All", () => {
    expect(profileInitial("work")).toBe("W");
    expect(profileInitial(null)).toBe("All");
  });
});

describe("startProfile", () => {
  const initial = store.get();
  afterEach(() => store.set(initial));

  const home = "C:\\Users\\me";
  const profiles = [profile(`${home}\\.claude`, "default"), profile(`${home}\\.claude-work`, "work")];
  const platform = { os: "windows", build: "", arch: "" };

  it("prefers the profile in view, then the saved account, then the first profile", () => {
    store.set({ profiles, platform, currentProfile: null, settings: { ...DEFAULT_SETTINGS, account: null } });
    expect(startProfile()).toBe(`${home}\\.claude`);
    // the account matches in another spelling and resolves to the discovered folder
    store.set({ settings: { ...DEFAULT_SETTINGS, account: "c:/users/me/.claude-work/" } });
    expect(startProfile()).toBe(`${home}\\.claude-work`);
    store.set({ settings: { ...DEFAULT_SETTINGS, account: `${home}\\.claude-gone` } });
    expect(startProfile()).toBe(`${home}\\.claude`);
    store.set({ currentProfile: `${home}\\.claude-work` });
    expect(startProfile()).toBe(`${home}\\.claude-work`);
  });

  it("is null without profiles", () => {
    store.set({ profiles: [], currentProfile: null });
    expect(startProfile()).toBeNull();
  });
});
