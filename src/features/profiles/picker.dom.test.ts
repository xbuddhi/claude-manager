import { afterEach, describe, expect, it } from "vitest";
import type { Profile } from "../../bindings/Profile";
import type { Project } from "../../bindings/Project";
import type { Session } from "../../bindings/Session";
import { store } from "../../core/store";
import { avatarTip, mountAvatarButton } from "./avatar-button";
import { mountPicker } from "./picker";

const profile = (dir: string, name: string, email: string | null = null): Profile => ({
  dir,
  name,
  email,
  signedIn: null,
  isDefault: name === "default",
});
const session = (id: string, profileDir: string) => ({ id, profile: profileDir }) as Session;
const project = (sessions: Session[]) => ({ path: "/p", name: "p", sessions }) as unknown as Project;

describe("picker and avatar in the DOM", () => {
  const initial = store.get();
  afterEach(() => {
    store.set(initial);
    document.body.replaceChildren();
  });

  it("shows a card per profile, All profiles and Add profile, with live counts", () => {
    store.set({
      profiles: [profile("/h/.claude", "default", "me@home.test"), profile("/h/.claude-work", "work")],
      index: {
        gen: 1,
        projects: [project([session("a", "/h/.claude"), session("b", "/h/.claude-work")])],
        loaded: "ok",
        error: null,
      },
    });
    const root = document.createElement("div");
    document.body.append(root);
    mountPicker(root);
    const cards = [...root.querySelectorAll(".prof-card")];
    expect(cards.map((c) => c.querySelector(".prof-card-name")?.textContent)).toEqual([
      "default",
      "work",
      "All profiles",
      "Add profile",
    ]);
    expect(cards.map((c) => c.querySelector(".prof-card-mail")?.textContent)).toEqual([
      "me@home.test",
      "Not signed in",
      "Sessions from every profile",
      "Sign in to another account",
    ]);
    expect(cards.map((c) => c.querySelector(".prof-card-count")?.textContent)).toEqual([
      "1 session",
      "1 session",
      "2 sessions",
      "",
    ]);
    expect(root.textContent).toContain("Who's using Claude Code?");
    expect(root.textContent).toContain("Show this screen when the app starts");

    // a new session arrives: the counts follow, the cards stay the same elements
    const first = cards[0];
    store.set({
      index: {
        gen: 2,
        projects: [project([session("a", "/h/.claude"), session("c", "/h/.claude"), session("b", "/h/.claude-work")])],
        loaded: "ok",
        error: null,
      },
    });
    expect(root.querySelector(".prof-card")).toBe(first);
    expect(first?.querySelector(".prof-card-count")?.textContent).toBe("2 sessions");
  });

  it("names the profile in the avatar tooltip", () => {
    store.set({ profiles: [profile("/h/.claude-work", "work", "me@work.test")], currentProfile: "/h/.claude-work" });
    expect(avatarTip("/h/.claude-work")).toBe("work  -  me@work.test");
    expect(avatarTip(null)).toBe("All profiles  -  Sessions from every profile");
    const slot = document.createElement("div");
    mountAvatarButton(slot);
    const btn = slot.querySelector("button");
    expect(btn?.dataset.tip).toBe("work  -  me@work.test");
    expect(btn?.textContent).toBe("W");
    store.set({ currentProfile: null });
    expect(btn?.dataset.tip).toBe("All profiles  -  Sessions from every profile");
    expect(btn?.textContent).toBe("All");
  });
});
