// The usage popover's content (Windows app: UsagePanel): plan limits first (real numbers), then this
// computer's token counts as a small footnote with a 7-day bar chart, then "Other accounts" (folded): the
// other signed-in profiles' session and week, one line each.

import type { PlanLimit } from "../../bindings/PlanLimit";
import type { PlanReport } from "../../bindings/PlanReport";
import type { UsageReport } from "../../bindings/UsageReport";
import { html, type SafeHtml } from "../../core/dom";
import { fmtTokens, levelColor, resetText } from "../../core/format";
import { icon } from "../../core/icons";
import { headerText, sessionPercent, statusLine, weekPercent } from "./model";

export interface PanelData {
  scope: string;
  plans: PlanReport[];
  plansBusy: boolean;
  local: UsageReport | null;
  localBusy: boolean;
  /** The other signed-in accounts (null: none, or All profiles is in view, which shows them all). */
  others?: { count: number; open: boolean; plans: PlanReport[] } | null;
}

const skeleton = html`<div class="use-skel" aria-hidden="true"><i></i><i></i><i></i></div>`;

const HOUR = 3_600_000;

/** How long a limit's window is: 5 hours for the session, a week for the weekly ones; null when unknown. */
export function windowLength(label: string): number | null {
  if (label === "Current session") return 5 * HOUR;
  if (label.startsWith("Weekly")) return 7 * 24 * HOUR;
  return null;
}

/** The share of the limit's window already gone (0..1); null without a reset time or a known window. */
export function elapsed(l: PlanLimit, now: number): number | null {
  const len = windowLength(l.label);
  if (l.resets === null || len === null) return null;
  return Math.max(0, Math.min(1, 1 - (l.resets - now) / len));
}

/** The pace marker's style and tooltip: where the clock is in the window, against what is used. */
function pace(l: PlanLimit, now: number): { style: string; tip: string } | null {
  const e = elapsed(l, now);
  if (e === null) return null;
  const time = Math.round(e * 100);
  const verdict =
    l.percent > time + 10 ? "using faster than time passes" : l.percent < time - 10 ? "well within pace" : "on pace";
  return { style: `left: ${(e * 100).toFixed(1)}%`, tip: `${time}% of this window has passed: ${verdict}` };
}

function limitRow(l: PlanLimit, now: number, hero: boolean): SafeHtml {
  const f = Math.max(0, Math.min(1, l.percent / 100));
  const color = levelColor(l.percent);
  // the fill is never thinner than the meter is tall, so a small value still shows
  const fill = f > 0.002 ? html`<span class="use-fill" style="width: max(8px, ${(f * 100).toFixed(2)}%)"></span>` : "";
  const p = pace(l, now);
  const marker = p ? html`<span class="use-pace" style="${p.style}" data-tip="${p.tip}"></span>` : "";
  return html`<div class="use-limit${hero ? " hero" : ""}" style="--use-c: ${color}">
    <div class="use-limit-top"><span class="use-label">${l.label}</span><span class="use-pct"><b class="use-pct-v">${Math.round(l.percent)}</b>% used</span></div>
    <div class="use-meter">${fill}${marker}</div>
    <div class="use-reset">${resetText(l.resets, now)}</div>
  </div>`;
}

function profileBlock(p: PlanReport, many: boolean, now: number): SafeHtml {
  const head = many ? html`<div class="use-profile">${p.name}</div>` : "";
  const body =
    p.error !== null
      ? html`<div class="use-error">${p.error}</div>`
      : p.limits.map((l, i) => limitRow(l, now, !many && i === 0));
  return html`${head}${body}`;
}

const dayName = new Intl.DateTimeFormat("en-US", { weekday: "short" });

function tile(label: string, value: string, sub: string): SafeHtml {
  return html`<div class="use-tile"><span class="use-tile-l">${label}</span><b class="use-tile-v">${value}</b><span class="use-tile-s">${sub}</span></div>`;
}

const replies = (n: number) => (n === 1 ? "1 reply" : `${fmtTokens(n)} replies`);

/** This computer's token counts: three stat tiles and the last 7 days as a bar chart (today in the accent). */
function footer(local: UsageReport | null, now: number): SafeHtml {
  if (!local)
    return html`<div class="use-local"><div class="use-sec">This PC</div><div class="use-error">Counting...</div></div>`;
  const windowSub = local.blockStart === null ? "no window open" : `${Math.round(local.fraction * 100)}% of your peak`;
  const max = Math.max(1, ...local.days);
  const bars = local.days.map((d, i) => {
    const day = new Date(now - (6 - i) * 24 * HOUR);
    const name = i === 6 ? "Today" : dayName.format(day);
    const h = d > 0 ? Math.max(4, (100 * d) / max) : 0;
    return html`<div class="use-day${i === 6 ? " today" : ""}" data-tip="${name}: ${fmtTokens(d)} tokens">
      <div class="use-day-plot"><i class="use-bar" style="height: ${h.toFixed(1)}%"></i></div>
      <span>${name}</span>
    </div>`;
  });
  return html`<div class="use-local">
    <div class="use-sec">This PC <span>tokens, from the transcripts here</span></div>
    <div class="use-tiles">
      ${tile("5-hour window", fmtTokens(local.blockTokens), windowSub)}
      ${tile("Today", fmtTokens(local.today), replies(local.todayReplies))}
      ${tile("7 days", fmtTokens(local.week), `peak 5h ${fmtTokens(local.peakBlock)}`)}
    </div>
    <div class="use-chart" role="img" aria-label="Tokens per day, last 7 days">${bars}</div>
  </div>`;
}

/** A small bar and its percent ("Session ▬ 19%"); a dash when the plan does not say. */
function miniMeter(label: string, pct: number): SafeHtml {
  if (pct < 0) return html`<span class="use-o-m"><span class="use-o-l">${label}</span><b>–</b></span>`;
  const color = levelColor(pct);
  const w = Math.max(0, Math.min(100, pct));
  return html`<span class="use-o-m"><span class="use-o-l">${label}</span><span class="use-o-bar"><i style="width: max(4px, ${w.toFixed(1)}%); background: ${color}"></i></span><b style="color: ${color}">${Math.round(pct)}%</b></span>`;
}

function otherRow(p: PlanReport): SafeHtml {
  const name = p.plan ? `${p.name}  ·  ${p.plan}` : p.name;
  const body =
    p.error !== null
      ? html`<div class="use-o-err">${p.error}</div>`
      : html`<div class="use-o-meters">${miniMeter("Session", sessionPercent([p]))}${miniMeter("Week", weekPercent([p]))}</div>`;
  return html`<div class="use-o-row"><div class="use-o-name">${name}</div>${body}</div>`;
}

function othersBlock(o: PanelData["others"]): SafeHtml | "" {
  if (!o) return "";
  const toggle = html`<button type="button" class="use-others-toggle" aria-expanded="${String(o.open)}"><span>Other accounts</span><span class="use-others-n">${String(o.count)}</span>${icon("chevronDown")}</button>`;
  if (!o.open) return html`<div class="use-others">${toggle}</div>`;
  const rows = o.plans.length ? o.plans.map(otherRow) : [skeleton];
  return html`<div class="use-others open">${toggle}${rows}</div>`;
}

export function panelHtml(d: PanelData, now = Date.now()): SafeHtml {
  const spinner = d.plansBusy || d.localBusy ? html`<span class="use-spinner" aria-label="Refreshing"></span>` : "";
  const plans = d.plans.length ? d.plans.map((p) => profileBlock(p, d.plans.length > 1, now)) : [skeleton, skeleton];
  return html`<div class="use-head"><span class="use-title">USAGE</span><span class="use-scope">${headerText(d.scope, d.plans)}</span>${spinner}</div>
    <div class="use-status" role="status">${statusLine(d.plans, d.plansBusy, now)}</div>
    ${plans}
    ${footer(d.local, now)}
    ${othersBlock(d.others)}`;
}

/**
 * Brings the parts that change with the clock alone up to `now` in a panel drawn by panelHtml from the same
 * `d`: the status line, each limit's reset countdown and its pace marker. True when anything changed.
 */
export function tickPanel(root: ParentNode, d: PanelData, now = Date.now()): boolean {
  let changed = false;
  const put = (el: Element | null | undefined, text: string | undefined) => {
    if (!el || text === undefined || el.textContent === text) return;
    el.textContent = text;
    changed = true;
  };
  const attr = (el: Element, name: string, value: string) => {
    if (el.getAttribute(name) === value) return;
    el.setAttribute(name, value);
    changed = true;
  };
  put(root.querySelector(".use-status"), statusLine(d.plans, d.plansBusy, now));
  const limits = d.plans.flatMap((p) => (p.error !== null ? [] : p.limits));
  let i = 0;
  for (const el of root.querySelectorAll(".use-reset")) put(el, resetText(limits[i++]?.resets, now));
  const paces = limits.map((l) => pace(l, now)).filter((p) => p !== null);
  i = 0;
  for (const el of root.querySelectorAll(".use-pace")) {
    const p = paces[i++];
    if (!p) continue;
    attr(el, "style", p.style);
    attr(el, "data-tip", p.tip);
  }
  return changed;
}
