import { describe, expect, it } from "vitest";
import type { PlanReport } from "../../bindings/PlanReport";
import type { Profile } from "../../bindings/Profile";
import type { UsageReport } from "../../bindings/UsageReport";
import {
  headerText,
  localScope,
  planScope,
  plansStale,
  ringFraction,
  ringState,
  samePlans,
  sessionPercent,
  statusLine,
  usageAgo,
} from "./model";
import { panelHtml } from "./popover";

const NOW = new Date(2026, 9, 25, 12, 0, 0).getTime();
const SEC = 1000;
const MIN = 60 * SEC;

function plan(profile: string, patch: Partial<PlanReport> = {}): PlanReport {
  return {
    profile,
    name: profile.replace(/^.*\.claude-?/, "") || "default",
    plan: null,
    error: null,
    stale: null,
    fetched: NOW - 30 * SEC,
    limits: [
      { label: "Current session", percent: 42, resets: NOW + 2 * 60 * MIN },
      { label: "Weekly · all models", percent: 75.6, resets: null },
    ],
    ...patch,
  };
}

function profile(dir: string, signedIn: boolean | null): Profile {
  return { dir, name: dir, email: null, signedIn, isDefault: false };
}

const local: UsageReport = {
  blockStart: NOW - 60 * MIN,
  blockTokens: 500,
  blockReplies: 2,
  peakBlock: 2000,
  today: 1_234_567,
  todayReplies: 9,
  week: 8_400_000,
  days: [0, 10, 0, 0, 0, 20, 40],
  fraction: 0.25,
  resetsAt: NOW + 4 * 60 * MIN,
};

describe("scope", () => {
  const all = [profile("/h/.claude", true), profile("/h/.claude-work", false), profile("/h/.claude-x", null)];

  it("is the profile in view, or every signed-in profile for All", () => {
    expect(planScope("/h/.claude-work", all)).toEqual(["/h/.claude-work"]);
    expect(planScope(null, all)).toEqual(["/h/.claude", "/h/.claude-x"]);
    expect(localScope(null, all)).toEqual(["/h/.claude", "/h/.claude-work", "/h/.claude-x"]);
  });

  it("matches plans to profiles with the platform's path rules", () => {
    const plans = [plan("C:\\Users\\Me\\.claude")];
    expect(samePlans(plans, ["c:/users/me/.claude/"], "windows")).toBe(true);
    expect(samePlans(plans, ["C:\\Users\\Me\\.claude", "x"], "windows")).toBe(false);
    expect(samePlans([], [], "windows")).toBe(true);
  });
});

describe("ring", () => {
  it("shows the highest session percent, else the local window", () => {
    const plans = [plan("a"), plan("b", { limits: [{ label: "Current session", percent: 91, resets: null }] })];
    expect(sessionPercent(plans)).toBe(91);
    expect(ringFraction(plans, local)).toBeCloseTo(0.91);
    expect(sessionPercent([plan("a", { limits: [] })])).toBe(-1);
    expect(ringFraction([], local)).toBe(0.25);
    expect(ringFraction([], null)).toBe(0);
  });

  it("is loading without plans and failed when none has numbers", () => {
    expect(ringState([], false)).toBe("loading");
    expect(ringState([], true)).toBe("ok");
    expect(ringState([plan("a", { limits: [], error: "Not signed in" })], false)).toBe("failed");
    expect(ringState([plan("a", { limits: [], error: "x" }), plan("b")], false)).toBe("ok");
  });
});

describe("status line", () => {
  it("says what the panel is doing", () => {
    expect(statusLine([], true, NOW)).toBe("Loading your plan limits...");
    expect(statusLine([], false, NOW)).toBe("Plan limits not loaded yet");
    const failed = [plan("a", { limits: [], error: "Usage service busy" })];
    expect(statusLine(failed, true, NOW)).toBe("Checking...");
    expect(statusLine(failed, false, NOW)).toBe("No plan limits available");
    expect(statusLine([plan("a")], false, NOW)).toBe("Updated 30s ago");
    expect(statusLine([plan("a")], true, NOW)).toBe("Updated 30s ago  ·  refreshing...");
    const stale = [plan("a", { stale: "Usage service busy", fetched: NOW - 5 * MIN })];
    expect(statusLine(stale, false, NOW)).toBe("Numbers from 5m ago  ·  usage service busy, will check again shortly");
  });

  it("formats how long ago", () => {
    expect(usageAgo(NOW - 4 * SEC, NOW)).toBe("just now");
    expect(usageAgo(NOW - 59 * SEC, NOW)).toBe("59s ago");
    expect(usageAgo(NOW - 59 * MIN, NOW)).toBe("59m ago");
    expect(usageAgo(new Date(2026, 9, 25, 9, 5).getTime(), NOW)).toBe("9:05 AM");
  });

  it("names the plan only for one profile", () => {
    expect(headerText("work", [plan("a", { plan: "Max" })])).toBe("work  ·  Max plan");
    expect(headerText("All profiles", [plan("a", { plan: "Max" }), plan("b", { plan: "Pro" })])).toBe("All profiles");
    expect(headerText("work", [])).toBe("work");
  });

  it("knows when plans are older than a limit", () => {
    expect(plansStale([], 300, NOW)).toBe(true);
    expect(plansStale([plan("a")], 300, NOW)).toBe(false);
    expect(plansStale([plan("a", { fetched: NOW - 301 * SEC })], 300, NOW)).toBe(true);
  });
});

describe("panel", () => {
  const render = (d: Parameters<typeof panelHtml>[0]) => {
    const el = document.createElement("div");
    el.innerHTML = panelHtml(d, NOW).value;
    return el;
  };

  it("shows skeleton rows and a counting footer before anything loads", () => {
    const el = render({ scope: "default", plans: [], plansBusy: true, local: null, localBusy: true });
    expect(el.querySelectorAll(".use-skel")).toHaveLength(2);
    expect(el.querySelector(".use-spinner")).not.toBeNull();
    expect(el.querySelector(".use-foot")?.textContent?.trim()).toBe("This PC: counting...");
  });

  it("shows limits, errors and the local footnote", () => {
    const el = render({
      scope: "All profiles",
      plans: [plan("/h/.claude-work"), plan("/h/.claude-<b>", { name: "<b>", limits: [], error: "Not signed in" })],
      plansBusy: false,
      local,
      localBusy: false,
    });
    expect(el.querySelector(".use-spinner")).toBeNull();
    expect([...el.querySelectorAll(".use-profile")].map((e) => e.textContent)).toEqual(["work", "<b>"]);
    expect(el.querySelector(".use-error")?.textContent).toBe("Not signed in");
    const rows = [...el.querySelectorAll(".use-limit")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector("b")?.textContent).toBe("42% used");
    expect(rows[1]?.querySelector("b")?.textContent).toBe("76% used");
    expect(rows[0]?.querySelector(".use-reset")?.textContent).toBe("Resets in 2h 0m  ·  2:00 PM");
    expect(el.querySelector(".use-foot span")?.textContent).toBe("This PC  ·  today 1.2M  ·  week 8.4M");
    const bars = [...el.querySelectorAll<HTMLElement>(".use-bars i")];
    expect(bars).toHaveLength(7);
    expect(bars[6]?.classList.contains("today")).toBe(true);
    expect(bars[6]?.style.height).toBe("18px");
    expect(bars[0]?.style.height).toBe("2px");
  });
});
