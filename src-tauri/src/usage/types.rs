//! IPC types of the usage feature. None of them ever holds a token.

use serde::Serialize;
use ts_rs::TS;

/// One plan limit as Claude Code's /usage shows it.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanLimit {
    /// "Current session", "Weekly · all models", "Weekly · Opus", ...
    pub label: String,
    pub percent: f64,
    /// When the limit resets, ms since the Unix epoch.
    pub resets: Option<i64>,
}

/// Plan limits of one profile, or why there are none.
#[derive(Serialize, TS, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanReport {
    /// Profile folder.
    pub profile: String,
    /// Profile display name.
    pub name: String,
    /// Plan name, capitalized ("Max", "Pro"); null when unknown.
    pub plan: Option<String>,
    /// Why there are no numbers ("Not signed in", "Usage service busy", ...).
    pub error: Option<String>,
    /// Set when these are the last good numbers and the latest fetch failed with this transient error.
    pub stale: Option<String>,
    /// When the numbers were fetched, ms since the Unix epoch.
    pub fetched: i64,
    pub limits: Vec<PlanLimit>,
}

/// Payload of `usage-plans` and result of `usage_plans`: the plans in view and the refresh state.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlansUpdate {
    pub plans: Vec<PlanReport>,
    /// A refresh is running; more numbers follow in another `usage-plans` event.
    pub busy: bool,
    /// No plans yet, or some profile has no numbers for a reason other than not being signed in.
    pub needs_retry: bool,
}

/// Token counts from the transcripts on this computer (nothing is sent anywhere).
#[derive(Serialize, TS, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageReport {
    /// Start of the current 5-hour window (ms since the Unix epoch); null when none is active.
    pub block_start: Option<i64>,
    pub block_tokens: u64,
    pub block_replies: u32,
    /// Biggest 5-hour window of the last 8 days, the current one included.
    pub peak_block: u64,
    pub today: u64,
    pub today_replies: u32,
    pub week: u64,
    /// Tokens per day for the last 7 days; index 6 is today.
    pub days: [u64; 7],
    /// Current window's tokens / peak window, 0..1 (0 when no window is active).
    pub fraction: f64,
    /// When the current window ends (ms since the Unix epoch); null when none is active.
    pub resets_at: Option<i64>,
}
