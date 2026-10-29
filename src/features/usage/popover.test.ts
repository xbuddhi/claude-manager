import { describe, expect, it } from "vitest";
import type { PlanReport } from "../../bindings/PlanReport";
import { type PanelData, panelHtml, tickPanel } from "./popover";

const MIN = 60_000;
const NOW = new Date(2026, 0, 5, 12, 0, 0).getTime();

const data = (): PanelData => ({
  scope: "Work",
  plans: [
    {
      profile: "a",
      name: "Work",
      plan: "Max",
      error: null,
      stale: null,
      fetched: NOW - 30_000,
      limits: [
        { label: "Current session", percent: 40, resets: NOW + 90 * MIN },
        { label: "Weekly", percent: 10, resets: NOW + 3 * 24 * 60 * MIN },
      ],
    } satisfies PlanReport,
  ],
  plansBusy: false,
  local: null,
  localBusy: false,
});

describe("tickPanel", () => {
  it("updates only the clock texts, matching a full redraw", () => {
    const d = data();
    const root = document.createElement("div");
    root.innerHTML = panelHtml(d, NOW).value;
    const status = root.querySelector(".use-status");
    const later = NOW + 5 * MIN;
    expect(tickPanel(root, d, later)).toBe(true);
    // the same nodes, now with the texts a redraw at that time has
    expect(root.querySelector(".use-status")).toBe(status);
    const fresh = document.createElement("div");
    fresh.innerHTML = panelHtml(d, later).value;
    expect(root.innerHTML).toBe(fresh.innerHTML);
    expect(tickPanel(root, d, later)).toBe(false);
  });
});

describe("other accounts", () => {
  const other: PlanReport = {
    profile: "b",
    name: "Personal",
    plan: "Pro",
    error: null,
    stale: null,
    fetched: NOW,
    limits: [
      { label: "Current session", percent: 62, resets: NOW + MIN },
      { label: "Weekly · all models", percent: 30, resets: null },
    ],
  };

  it("is folded at first: a button with how many there are", () => {
    const root = document.createElement("div");
    root.innerHTML = String(panelHtml({ ...data(), others: { count: 2, open: false, plans: [] } }, NOW));
    const toggle = root.querySelector(".use-others-toggle");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(toggle?.textContent).toContain("2");
    expect(root.querySelector(".use-o-row")).toBeNull();
  });

  it("open: each account's session and week on one line", () => {
    const root = document.createElement("div");
    root.innerHTML = String(panelHtml({ ...data(), others: { count: 1, open: true, plans: [other] } }, NOW));
    expect(root.querySelector(".use-o-name")?.textContent).toBe("Personal  ·  Pro");
    expect([...root.querySelectorAll(".use-o-m b")].map((b) => b.textContent)).toEqual(["62%", "30%"]);
    // the countdowns still belong to the profile in view only
    expect(root.querySelectorAll(".use-reset")).toHaveLength(2);
  });

  it("none without other accounts", () => {
    const root = document.createElement("div");
    root.innerHTML = String(panelHtml({ ...data(), others: null }, NOW));
    expect(root.querySelector(".use-others")).toBeNull();
  });
});
