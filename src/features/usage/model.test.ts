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
  sameDirs,
  samePlans,
  sessionPercent,
  splitPlans,
  statusLine,
  usageAgo,
  weekPercent,
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

  it("adds the other signed-in accounts while Other accounts is open", () => {
    expect(planScope("/h/.claude-x", all, true, "macos")).toEqual(["/h/.claude-x", "/h/.claude"]);
    expect(planScope(null, all, true, "macos")).toEqual(["/h/.claude", "/h/.claude-x"]);
  });

  it("splits the plans into the profile in view and the others", () => {
    const a = plan("/h/.claude");
    const x = plan("/h/.claude-x");
    expect(splitPlans([x, a], "/h/.claude-x", "macos")).toEqual({ mine: [x], others: [a] });
    expect(splitPlans([a, x], null, "macos")).toEqual({ mine: [a, x], others: [] });
  });

  it("matches plans to profiles with the platform's path rules", () => {
    const plans = [plan("C:\\Users\\Me\\.claude")];
    expect(samePlans(plans, ["c:/users/me/.claude/"], "windows")).toBe(true);
    expect(samePlans(plans, ["C:\\Users\\Me\\.claude", "x"], "windows")).toBe(false);
    expect(samePlans([], [], "windows")).toBe(true);
  });

  it("tells whether local counts belong to the profiles in view", () => {
    expect(sameDirs(["C:\\Users\\Me\\.claude"], ["c:/users/me/.claude"], "windows")).toBe(true);
    expect(sameDirs(["/h/.claude"], ["/h/.claude-work"], "macos")).toBe(false);
    expect(sameDirs(["/h/.claude"], ["/h/.claude", "/h/.claude-x"], "macos")).toBe(false);
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

  it("shows the highest weekly percent across models, -1 when none", () => {
    const limits = [
      { label: "Current session", percent: 50, resets: null },
      { label: "Weekly · all models", percent: 12, resets: null },
      { label: "Weekly · Fable", percent: 30, resets: null },
    ];
    expect(weekPercent([plan("a", { limits })])).toBe(30);
    expect(weekPercent([plan("a", { limits: [] })])).toBe(-1);
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
    expect(el.querySelector(".use-local .use-error")?.textContent).toBe("Counting...");
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
    expect(rows[0]?.querySelector(".use-pct")?.textContent).toBe("42% used");
    expect(rows[1]?.querySelector(".use-pct")?.textContent).toBe("76% used");
    expect(rows[0]?.querySelector(".use-reset")?.textContent).toBe("Resets in 2h 0m  ·  2:00 PM");
    // several profiles: no row leads
    expect(el.querySelector(".use-limit.hero")).toBeNull();
    const tiles = [...el.querySelectorAll(".use-tile")].map((t) => [
      t.querySelector(".use-tile-v")?.textContent,
      t.querySelector(".use-tile-s")?.textContent,
    ]);
    expect(tiles).toEqual([
      ["500", "25% of your peak"],
      ["1.2M", "9 replies"],
      ["8.4M", "peak 5h 2.0K"],
    ]);
    const days = [...el.querySelectorAll<HTMLElement>(".use-day")];
    expect(days).toHaveLength(7);
    expect(days[6]?.classList.contains("today")).toBe(true);
    expect(days[6]?.querySelector("span")?.textContent).toBe("Today");
    expect(days[6]?.dataset.tip).toBe("Today: 40 tokens");
    const bar = (i: number) => days[i]?.querySelector<HTMLElement>("i")?.style.height;
    expect(bar(6)).toBe("100.0%");
    expect(bar(5)).toBe("50.0%");
    // a day without tokens draws nothing
    expect(bar(0)).toBe("0.0%");
  });

  it("marks how much of a limit's window has passed", () => {
    const el = render({
      scope: "default",
      plans: [plan("/h/.claude-work")],
      plansBusy: false,
      local,
      localBusy: false,
    });
    const first = el.querySelector(".use-limit");
    expect(first?.classList.contains("hero")).toBe(true);
    // the session resets in 2h of its 5h: 60% has passed
    const marker = first?.querySelector<HTMLElement>(".use-pace");
    expect(marker?.style.left).toBe("60.0%");
    expect(marker?.dataset.tip).toBe("60% of this window has passed: well within pace");
  });
});
