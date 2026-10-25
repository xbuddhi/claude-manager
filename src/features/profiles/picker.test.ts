import { describe, expect, it } from "vitest";
import { homeHint, validProfileName } from "./newprofile";
import { type Box, gridMove } from "./picker";
import { sessionCount } from "./strings";

// five cards of 196px (176 + margins) wrapped three to a row; the second row is centred
const card = (left: number, top: number): Box => ({ left, top, width: 176, height: 206 });
const grid = [card(10, 10), card(206, 10), card(402, 10), card(108, 236), card(304, 236)];

describe("picker keyboard grid", () => {
  it("moves left and right through the cards, stopping at the ends", () => {
    expect(gridMove(grid, 0, "ArrowRight")).toBe(1);
    expect(gridMove(grid, 2, "ArrowRight")).toBe(3);
    expect(gridMove(grid, 4, "ArrowRight")).toBe(4);
    expect(gridMove(grid, 0, "ArrowLeft")).toBe(0);
    expect(gridMove(grid, 3, "Home")).toBe(0);
    expect(gridMove(grid, 0, "End")).toBe(4);
  });

  it("moves up and down to the nearest card of the next row", () => {
    expect(gridMove(grid, 0, "ArrowDown")).toBe(3);
    expect(gridMove(grid, 2, "ArrowDown")).toBe(4);
    expect(gridMove(grid, 1, "ArrowDown")).toBe(3);
    expect(gridMove(grid, 4, "ArrowUp")).toBe(1);
    expect(gridMove(grid, 3, "ArrowUp")).toBe(0);
  });

  it("stays put without a row in that direction or for other keys", () => {
    expect(gridMove(grid, 1, "ArrowUp")).toBe(1);
    expect(gridMove(grid, 3, "ArrowDown")).toBe(3);
    expect(gridMove(grid, 2, "x")).toBe(2);
    expect(gridMove([], 0, "ArrowDown")).toBe(0);
  });
});

describe("new profile names", () => {
  it("accept letters, numbers, - and _ only", () => {
    for (const ok of ["work", "my-team_2", "Ünïcode", "a"]) expect(validProfileName(ok)).toBe(true);
    for (const bad of ["", "a b", "../x", "a/b", "a\\b", "x.y", "C:", "a*", "x".repeat(65)]) {
      expect(validProfileName(bad)).toBe(false);
    }
  });

  it("name the home folder from the default profile's folder", () => {
    expect(homeHint("C:\\Users\\me\\.claude")).toEqual({ home: "C:\\Users\\me", sep: "\\" });
    expect(homeHint("/Users/me/.claude")).toEqual({ home: "/Users/me", sep: "/" });
    expect(homeHint(undefined)).toEqual({ home: "~", sep: "/" });
  });
});

describe("session counts", () => {
  it("are singular for one", () => {
    expect(sessionCount(0)).toBe("0 sessions");
    expect(sessionCount(1)).toBe("1 session");
    expect(sessionCount(12)).toBe("12 sessions");
  });
});
