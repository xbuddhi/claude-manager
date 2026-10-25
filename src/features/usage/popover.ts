// The usage popover's content (Windows app: UsagePanel): plan limits first (real numbers), then this
// computer's token counts as a small footnote with a 7-day bar chart.

import type { PlanLimit } from "../../bindings/PlanLimit";
import type { PlanReport } from "../../bindings/PlanReport";
import type { UsageReport } from "../../bindings/UsageReport";
import { html, type SafeHtml } from "../../core/dom";
import { fmtTokens, levelColor, resetText } from "../../core/format";
import { headerText, statusLine } from "./model";

export interface PanelData {
  scope: string;
  plans: PlanReport[];
  plansBusy: boolean;
  local: UsageReport | null;
  localBusy: boolean;
}

const skeleton = html`<div class="use-skel" aria-hidden="true"><i></i><i></i><i></i></div>`;

function limitRow(l: PlanLimit, now: number): SafeHtml {
  const f = Math.max(0, Math.min(1, l.percent / 100));
  const color = levelColor(l.percent);
  // the fill is never thinner than the track is tall, so a small value still shows
  const fill =
    f > 0.002
      ? html`<span class="use-fill" style="width: max(6px, ${(f * 100).toFixed(2)}%); background: ${color}"></span>`
      : "";
  return html`<div class="use-limit">
    <div class="use-limit-top"><span class="use-label">${l.label}</span><b style="color: ${color}">${Math.round(l.percent)}% used</b></div>
    <div class="use-track-bar">${fill}</div>
    <div class="use-reset">${resetText(l.resets, now)}</div>
  </div>`;
}

function profileBlock(p: PlanReport, many: boolean, now: number): SafeHtml {
  const head = many ? html`<div class="use-profile">${p.name}</div>` : "";
  const body = p.error !== null ? html`<div class="use-error">${p.error}</div>` : p.limits.map((l) => limitRow(l, now));
  return html`${head}${body}`;
}

function footer(local: UsageReport | null): SafeHtml {
  if (!local) return html`<div class="use-foot"><span>This PC: counting...</span></div>`;
  const max = Math.max(1, ...local.days);
  const bars = local.days.map(
    (d, i) =>
      html`<i class="${i === 6 ? "today" : ""}" style="height: ${Math.max(2, (18 * d) / max).toFixed(1)}px"></i>`,
  );
  return html`<div class="use-foot">
    <span>This PC  ·  today ${fmtTokens(local.today)}  ·  week ${fmtTokens(local.week)}</span>
    <div class="use-bars" aria-hidden="true">${bars}</div>
  </div>`;
}

export function panelHtml(d: PanelData, now = Date.now()): SafeHtml {
  const spinner = d.plansBusy || d.localBusy ? html`<span class="use-spinner" aria-label="Refreshing"></span>` : "";
  const plans = d.plans.length ? d.plans.map((p) => profileBlock(p, d.plans.length > 1, now)) : [skeleton, skeleton];
  return html`<div class="use-head"><span class="use-title">USAGE</span><span class="use-scope">${headerText(d.scope, d.plans)}</span>${spinner}</div>
    <div class="use-status" role="status">${statusLine(d.plans, d.plansBusy, now)}</div>
    ${plans}
    ${footer(d.local)}`;
}
