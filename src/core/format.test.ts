import { describe, expect, it } from "vitest";
import { ago, fmtTokens, leaf, plural, resetText, size, truncate, until } from "./format";

// Sunday 25 October 2026, 12:00 local time
const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("ago", () => {
  it("says there is nothing without a time", () => {
    expect(ago(null, NOW)).toBe("no sessions");
    expect(ago(undefined, NOW)).toBe("no sessions");
    expect(ago(0, NOW)).toBe("no sessions");
  });

  it("uses rounded minutes and whole hours and days", () => {
    expect(ago(NOW - 30 * SEC, NOW)).toBe("just now");
    expect(ago(NOW + 5 * SEC, NOW)).toBe("just now");
    expect(ago(NOW - 5 * MIN, NOW)).toBe("5m ago");
    expect(ago(NOW - 90 * SEC, NOW)).toBe("2m ago");
    expect(ago(NOW - 3 * HOUR - 59 * MIN, NOW)).toBe("3h ago");
    expect(ago(NOW - 30 * HOUR, NOW)).toBe("Yesterday");
    expect(ago(NOW - 3 * DAY - HOUR, NOW)).toBe("3d ago");
  });

  it("shows a date after a week, with the year only when it differs", () => {
    expect(ago(NOW - 10 * DAY, NOW)).toBe("Oct 15");
    expect(ago(new Date(2025, 2, 3, 9).getTime(), NOW)).toBe("Mar 3, 2025");
  });
});

describe("size", () => {
  it("switches to MB at 1024 KB", () => {
    expect(size(512)).toBe("512 KB");
    expect(size(1023)).toBe("1023 KB");
    expect(size(1024)).toBe("1.0 MB");
    expect(size(1536)).toBe("1.5 MB");
  });
});

describe("fmtTokens", () => {
  it("drops the decimal for large K and M values", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(1234)).toBe("1.2K");
    expect(fmtTokens(123_456)).toBe("123K");
    expect(fmtTokens(1_234_567)).toBe("1.2M");
    expect(fmtTokens(12_345_678)).toBe("12M");
  });
});

describe("until", () => {
  it("counts down in minutes and seconds, then hours and minutes", () => {
    expect(until(NOW + 30 * SEC, NOW)).toBe("less than a minute");
    expect(until(NOW + 4 * MIN + 5 * SEC, NOW)).toBe("4m 05s");
    expect(until(NOW + 2 * HOUR + 14 * MIN + 30 * SEC, NOW)).toBe("2h 14m");
  });
});

describe("resetText", () => {
  it("is empty without a reset time and 'now' within a minute", () => {
    expect(resetText(null, NOW)).toBe("");
    expect(resetText(NOW + 20 * SEC, NOW)).toBe("Resets now");
  });

  it("counts down within a day and names the day after that", () => {
    expect(resetText(NOW + 3 * HOUR, NOW)).toBe("Resets in 3h 0m  ·  3:00 PM");
    expect(resetText(new Date(2026, 9, 26, 9, 0).getTime(), NOW)).toBe("Resets in 21h 0m  ·  tomorrow 9:00 AM");
    expect(resetText(new Date(2026, 9, 26, 15, 0).getTime(), NOW)).toBe("Resets tomorrow 3:00 PM");
    expect(resetText(new Date(2026, 9, 27, 9, 0).getTime(), NOW)).toBe("Resets Tue 9:00 AM");
  });
});

describe("text helpers", () => {
  it("truncates with an ellipsis", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 5)).toBe("hell…");
  });

  it("pluralizes", () => {
    expect(plural(1, "session")).toBe("1 session");
    expect(plural(3, "session")).toBe("3 sessions");
  });

  it("takes the last path part for both separators", () => {
    expect(leaf("C:\\src\\app\\")).toBe("app");
    expect(leaf("/Users/me/app")).toBe("app");
    expect(leaf("/")).toBe("/");
  });
});
