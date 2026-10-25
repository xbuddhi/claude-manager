import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../../bindings/Profile";
import { DEFAULT_SETTINGS, store } from "../../core/store";
import { profileAvatar, profileColor, profileEmail, profileInitial, startProfile } from "./api";

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

describe("profile colours match the Windows app's rule", () => {
  // the same algorithm as ClaudeManager.ps1 Get-ProfileColor, written out on its own
  const ps1 = (name: string) => {
    const palette = ["#0A84FF", "#BF5AF2", "#FF375F", "#FF9F0A", "#30D158", "#5E5CE6", "#64D2FF", "#FF453A"];
    let sum = 0;
    for (const ch of name) sum += ch.charCodeAt(0);
    return palette[sum % 8];
  };

  it.each(["default", "work", "personal", "team-2", "x"])("%s", (name) => {
    expect(profileColor(name)).toBe(ps1(name));
  });

  it("personal is green (sum 868 mod 8 = 4)", () => {
    expect(profileColor("personal")).toBe("#30D158");
  });
});

describe("profile email and avatar", () => {
  const initial = store.get();
  afterEach(() => store.set(initial));

  it("show the email, Not signed in, or the all-profiles line", () => {
    store.set({
      profiles: [{ ...profile("/h/.claude-work", "work"), email: "me@work.test" }, profile("/h/.claude", "default")],
    });
    expect(profileEmail("/h/.claude-work")).toBe("me@work.test");
    expect(profileEmail("/h/.claude")).toBe("Not signed in");
    expect(profileEmail(null)).toBe("Sessions from every profile");
  });

  it("draw all profiles with the control colour and text ink", () => {
    store.set({ profiles: [profile("/h/.claude-work", "work")] });
    const work = profileAvatar("/h/.claude-work", 34);
    expect(work.textContent).toBe("W");
    expect(work.classList.contains("prof-avatar-all")).toBe(false);
    const all = profileAvatar(null, 84);
    expect(all.textContent).toBe("All");
    expect(all.classList.contains("prof-avatar-all")).toBe(true);
  });
});
