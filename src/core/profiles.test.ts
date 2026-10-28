import { describe, expect, it } from "vitest";
import type { Profile } from "../bindings/Profile";
import { splitHidden, withNames } from "./profiles";

const profile = (dir: string, name: string) => ({ dir, name }) as Profile;

describe("withNames", () => {
  it("shows the name given in the app in place of the folder's, by folder", () => {
    const list = [profile("/u/.claude", "default"), profile("/u/.claude-test", "Test")];
    expect(withNames(list, { "/u/.claude-test": "Work" }).map((p) => p.name)).toEqual(["default", "Work"]);
    // blank names fall back to the folder's; an unchanged list keeps its objects
    expect(withNames(list, { "/u/.claude": "  " })[0]).toBe(list[0]);
  });
});

describe("splitHidden", () => {
  it("leaves profiles removed from the app out of the shown list", () => {
    const list = [profile("/u/.claude", "default"), profile("/u/.claude-test", "Test")];
    const { shown, hidden } = splitHidden(list, ["/u/.claude-test"]);
    expect(shown.map((p) => p.name)).toEqual(["default"]);
    expect(hidden.map((p) => p.name)).toEqual(["Test"]);
  });
});
