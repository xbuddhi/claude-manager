// Pure usage rules (Windows app: UsagePanel, UsageRing). `now` is a parameter so tests can fix it.

import type { PlanReport } from "../../bindings/PlanReport";
import type { Profile } from "../../bindings/Profile";
import type { UsageReport } from "../../bindings/UsageReport";
import { samePath } from "../../core/paths";

const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/** Profile folders whose plan limits are shown: the one in view, or every signed-in one for All profiles. */
export function planScope(current: string | null, profiles: Profile[]): string[] {
  if (current !== null) return [current];
  return profiles.filter((p) => p.signedIn !== false).map((p) => p.dir);
}

/** Profile folders whose transcripts are counted: the one in view, or all of them. */
export function localScope(current: string | null, profiles: Profile[]): string[] {
  return current !== null ? [current] : profiles.map((p) => p.dir);
}

/** Whether `plans` are the reports of exactly `dirs`, in order. */
export function samePlans(plans: PlanReport[], dirs: string[], os: string): boolean {
  return plans.length === dirs.length && plans.every((p, i) => samePath(p.profile, dirs[i] ?? "", os));
}

/** Highest "Current session" percent across the shown profiles; -1 when none is known. */
export function sessionPercent(plans: PlanReport[]): number {
  let max = -1;
  for (const p of plans)
    for (const l of p.limits) if (l.label === "Current session" && l.percent > max) max = l.percent;
  return max;
}

export type RingState = "loading" | "ok" | "failed";

/** Loading until plans arrive; failed when none of them has numbers. Nothing to fetch counts as ok. */
export function ringState(plans: PlanReport[], scopeEmpty: boolean): RingState {
  if (plans.some((p) => p.limits.length > 0)) return "ok";
  if (scopeEmpty) return "ok";
  return plans.length === 0 ? "loading" : "failed";
}

/** What the ring fills: the session percent, else the local 5-hour window's share of the busiest one. */
export function ringFraction(plans: PlanReport[], local: UsageReport | null): number {
  const pct = sessionPercent(plans);
  const f = pct >= 0 ? pct / 100 : (local?.fraction ?? 0);
  return Math.max(0, Math.min(1, f));
}

/** "just now", "12s ago", "5m ago", else the time ("3:04 PM"). */
export function usageAgo(ms: number, now = Date.now()): string {
  const s = (now - ms) / 1000;
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return clock.format(new Date(ms)).replace(/[  ]/g, " ");
}

/** The popover's status line: what it is doing, so a slow network never looks like a broken app. */
export function statusLine(plans: PlanReport[], busy: boolean, now = Date.now()): string {
  if (plans.length === 0) return busy ? "Loading your plan limits..." : "Plan limits not loaded yet";
  let newest = 0;
  for (const p of plans) if (p.limits.length > 0 && p.fetched > newest) newest = p.fetched;
  if (plans.some((p) => p.stale !== null)) {
    return `Numbers from ${usageAgo(newest, now)}  ·  usage service busy, will check again shortly`;
  }
  if (newest === 0) return busy ? "Checking..." : "No plan limits available";
  return `Updated ${usageAgo(newest, now)}${busy ? "  ·  refreshing..." : ""}`;
}

/** Header text right of "USAGE": the scope, plus the plan when exactly one profile is shown. */
export function headerText(scope: string, plans: PlanReport[]): string {
  const plan = plans.length === 1 ? plans[0]?.plan : null;
  return plan ? `${scope}  ·  ${plan} plan` : scope;
}

/** Whether the shown plans are older than `seconds` (or missing). */
export function plansStale(plans: PlanReport[], seconds: number, now = Date.now()): boolean {
  const first = plans[0];
  return !first || now - first.fetched > seconds * 1000;
}
