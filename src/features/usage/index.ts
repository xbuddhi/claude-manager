// Usage (WP7): the title-bar ring and its hover popover with plan limits (as Claude Code's /usage) and
// this computer's token counts. Scope: the profile in view, or every signed-in profile for All profiles.
// Cadence (Windows app): local counts every minute, plan limits every 10 minutes, on popover open when
// older than 5 minutes, and on window focus when something needs a retry. Cached numbers show at once.

import type { PlanReport } from "../../bindings/PlanReport";
import type { PlansUpdate } from "../../bindings/PlansUpdate";
import type { UsageReport } from "../../bindings/UsageReport";
import { call, listen } from "../../core/api";
import { on } from "../../core/bus";
import { $, setHtml } from "../../core/dom";
import { store } from "../../core/store";
import { openPopover, type Popover } from "../../ui/popover";
import { profileLabel } from "../profiles/api";
import { localScope, planScope, plansStale, ringFraction, ringState, sameDirs, samePlans } from "./model";
import { panelHtml } from "./popover";
import { createRing, type Ring } from "./ring";
import "./state";
import "./usage.css";

declare module "../../core/api" {
  interface Commands {
    /** Saved plan numbers of these profile folders (no network). */
    usage_cached: { args: { profiles: string[] }; result: PlanReport[] };
    /** Refreshes plan limits; skipped while one runs or when fresh, unless `force`. */
    usage_plans: { args: { profiles: string[]; force?: boolean }; result: PlansUpdate };
    usage_local: { args: { profiles: string[] }; result: UsageReport };
  }
  interface BackendEvents {
    "usage-plans": PlansUpdate;
  }
}

const LOCAL_EVERY = 60_000;
const PLANS_EVERY = 10 * 60_000;
/** Plans older than this are refreshed when the popover opens. */
const OPEN_STALE_S = 300;
/** Pointer grace between the ring and the popover. */
const LEAVE_GRACE = 150;

let ring: Ring;
let pop: Popover | null = null;
let openedBy: "hover" | "click" = "hover";
let leaveTimer: ReturnType<typeof setTimeout> | undefined;
let repaintTimer: ReturnType<typeof setInterval> | undefined;

/** Usage work happens only on the main screen with the ring shown. */
function active(): boolean {
  const s = store.get();
  return s.screen === "main" && s.settings.showUsage;
}

function scopes() {
  const s = store.get();
  return { plans: planScope(s.currentProfile, s.profiles), local: localScope(s.currentProfile, s.profiles) };
}

function isInView(plans: PlanReport[]): boolean {
  return samePlans(plans, scopes().plans, store.get().platform.os);
}

/** `fromEvent`: a refresh ended somewhere; when it was for profiles no longer in view, ours was skipped
 * while it ran, so ask again. */
function applyPlans(update: PlansUpdate, fromEvent: boolean) {
  if (!isInView(update.plans)) {
    if (update.busy) store.set({ usagePlansBusy: true });
    else if (fromEvent && active()) void refreshPlans();
    return;
  }
  store.set({ usagePlans: update.plans, usagePlansBusy: update.busy, usageNeedsRetry: update.needsRetry });
}

async function refreshPlans(force = false) {
  const res = await call("usage_plans", { profiles: scopes().plans, force }, { quiet: true });
  if (res.ok) applyPlans(res.value, false);
  else store.set({ usagePlansBusy: false });
}

/** Set when a refresh was asked for while one ran: it runs once more when that one ends. */
let localAgain = false;
/** The profiles `usageLocal` was counted for. */
let localFor: string[] = [];

async function refreshLocal() {
  if (store.get().usageLocalBusy) {
    localAgain = true;
    return;
  }
  store.set({ usageLocalBusy: true });
  const asked = scopes().local;
  const res = await call("usage_local", { profiles: asked }, { quiet: true });
  // the profile changed while it ran: these numbers belong to the old one
  const inView = sameDirs(asked, scopes().local, store.get().platform.os);
  if (res.ok && inView) localFor = asked;
  store.set({ usageLocalBusy: false, ...(res.ok && inView ? { usageLocal: res.value } : {}) });
  if (localAgain || !inView) {
    localAgain = false;
    void refreshLocal();
  }
}

/** The profiles in view changed: saved numbers first, then fresh ones. */
async function scopeChanged() {
  if (!active()) return;
  if (!isInView(store.get().usagePlans)) {
    const cached = await call("usage_cached", { profiles: scopes().plans }, { quiet: true });
    store.set({ usagePlans: cached.ok && isInView(cached.value) ? cached.value : [] });
  }
  // never the previous profile's counts under this one
  if (!sameDirs(localFor, scopes().local, store.get().platform.os)) store.set({ usageLocal: null });
  void refreshLocal();
  void refreshPlans();
}

function paintRing() {
  const s = store.get();
  ring.el.hidden = !active();
  ring.set(ringState(s.usagePlans, scopes().plans.length === 0), ringFraction(s.usagePlans, s.usageLocal));
}

function paintPanel() {
  if (!pop) return;
  const s = store.get();
  setHtml(
    pop.el.firstElementChild as HTMLElement,
    panelHtml({
      scope: profileLabel(s.currentProfile),
      plans: s.usagePlans,
      plansBusy: s.usagePlansBusy,
      local: s.usageLocal,
      localBusy: s.usageLocalBusy,
    }),
  );
  pop.reposition();
}

function open(by: "hover" | "click") {
  clearTimeout(leaveTimer);
  if (pop) {
    if (by === "click") openedBy = "click";
    return;
  }
  openedBy = by;
  const content = document.createElement("div");
  content.className = "use-panel";
  pop = openPopover({
    anchor: ring.el,
    content,
    align: "end",
    label: "Usage",
    onClose: () => {
      pop = null;
      clearInterval(repaintTimer);
      clearTimeout(leaveTimer);
      ring.el.setAttribute("aria-expanded", "false");
    },
  });
  pop.el.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
  pop.el.addEventListener("pointerleave", scheduleClose);
  ring.el.setAttribute("aria-expanded", "true");
  paintPanel();
  // countdowns every second; local counts every 30 s while open
  let ticks = 0;
  repaintTimer = setInterval(() => {
    ticks++;
    if (ticks % 30 === 0) void refreshLocal();
    paintPanel();
  }, 1000);
  if (plansStale(store.get().usagePlans, OPEN_STALE_S)) void refreshPlans();
}

function scheduleClose() {
  if (openedBy !== "hover") return;
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => pop?.close(), LEAVE_GRACE);
}

export function mount(): void {
  ring = createRing();
  $("#tb-right-slot").prepend(ring.el);
  ring.el.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") open("hover");
  });
  ring.el.addEventListener("pointerleave", scheduleClose);
  ring.el.addEventListener("click", () => {
    if (pop && openedBy === "click") pop.close();
    else open("click");
  });

  void listen("usage-plans", (update) => applyPlans(update, true));

  store.select(
    (s) => [s.usagePlans, s.usagePlansBusy, s.usageLocal, s.usageLocalBusy] as const,
    () => {
      paintRing();
      paintPanel();
    },
    { equals: (a, b) => a.every((v, i) => v === b[i]) },
  );
  store.select(
    (s) => `${s.screen}|${s.settings.showUsage}`,
    () => {
      paintRing();
      if (!active()) pop?.close();
    },
  );
  // the profiles in view: entering a profile, All profiles, or a sign-in appearing
  store.select(
    () => JSON.stringify([active(), scopes()]),
    () => void scopeChanged(),
    { immediate: true },
  );
  // self-heal: the sign-in may have been refreshed since (e.g. the profile was used once)
  store.select(
    (s) => s.windowFocused,
    (focused) => {
      if (focused && active() && store.get().usageNeedsRetry) void refreshPlans();
    },
  );
  on("refresh:full", () => {
    if (!active()) return;
    void refreshLocal();
    void refreshPlans(true);
  });

  setInterval(() => {
    if (active()) void refreshLocal();
  }, LOCAL_EVERY);
  setInterval(() => {
    if (active()) void refreshPlans();
  }, PLANS_EVERY);
  paintRing();
}
