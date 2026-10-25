//! `<app data dir>/usage-cache.json`: the last good plan numbers, so the popover is never empty at start.
//! Holds percentages and reset times only, never a token. Same shape as the Windows app's file:
//! `[{profile, plan, fetched, limits: [{label, percent, resets}]}]` with ISO 8601 times.

use super::types::{PlanLimit, PlanReport};
use crate::core::{fsio, paths, profiles};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Entry {
    profile: String,
    plan: Option<String>,
    fetched: String,
    limits: Vec<Limit>,
}

#[derive(Serialize, Deserialize)]
struct Limit {
    label: String,
    percent: f64,
    resets: Option<String>,
}

fn iso(ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(ms).map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn ms(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| t.timestamp_millis())
}

/// Saves the reports that have numbers. Errors are logged only: the cache is a convenience.
pub fn save(file: &Path, plans: &[PlanReport]) {
    let entries: Vec<Entry> = plans
        .iter()
        .filter(|p| !p.limits.is_empty())
        .filter_map(|p| {
            Some(Entry {
                profile: p.profile.clone(),
                plan: p.plan.clone(),
                fetched: iso(p.fetched)?,
                limits: p
                    .limits
                    .iter()
                    .map(|l| Limit {
                        label: l.label.clone(),
                        percent: l.percent,
                        resets: l.resets.and_then(iso),
                    })
                    .collect(),
            })
        })
        .collect();
    let result = serde_json::to_vec(&entries)
        .map_err(|e| e.to_string())
        .and_then(|bytes| fsio::write_atomic(file, &bytes).map_err(|e| e.to_string()));
    if let Err(e) = result {
        log::warn!("saving the usage cache failed: {e}");
    }
}

/// The saved reports of `profiles`, in that order; a missing or broken file gives none.
pub fn load(file: &Path, profiles: &[String]) -> Vec<PlanReport> {
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let entries: Vec<Entry> = serde_json::from_str(&text).unwrap_or_default();
    profiles
        .iter()
        .filter_map(|dir| {
            let key = paths::key(dir);
            let e = entries.iter().find(|e| paths::key(&e.profile) == key)?;
            Some(PlanReport {
                profile: dir.clone(),
                name: profiles::name(Path::new(dir)),
                plan: e.plan.clone(),
                error: None,
                stale: None,
                fetched: ms(&e.fetched)?,
                limits: e
                    .limits
                    .iter()
                    .map(|l| PlanLimit {
                        label: l.label.clone(),
                        percent: l.percent,
                        resets: l.resets.as_deref().and_then(ms),
                    })
                    .collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(profile: &str, limits: Vec<PlanLimit>) -> PlanReport {
        PlanReport {
            profile: profile.into(),
            name: profiles::name(Path::new(profile)),
            plan: Some("Max".into()),
            error: None,
            stale: None,
            fetched: 1_761_400_000_123,
            limits,
        }
    }

    #[test]
    fn round_trips_reports_with_numbers_only() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("usage-cache.json");
        let work = "/h/.claude-work".to_string();
        let home = "/h/.claude".to_string();
        let limit = PlanLimit {
            label: "Current session".into(),
            percent: 42.5,
            resets: Some(1_761_410_000_000),
        };
        let plans = vec![report(&work, vec![limit.clone()]), report(&home, vec![])];
        save(&file, &plans);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("\"fetched\":\"2025-10-25T13:46:40.123Z\""));
        assert!(!text.contains(".claude\""));
        let loaded = load(&file, &[home.clone(), work.clone()]);
        assert_eq!(loaded, vec![plans[0].clone()]);
        assert_eq!(loaded[0].name, "work");
        assert!(load(&file, &[home]).is_empty());
    }

    #[test]
    fn a_broken_file_gives_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("usage-cache.json");
        assert!(load(&file, &["/h/.claude".into()]).is_empty());
        std::fs::write(&file, "[{\"profile\":").unwrap();
        assert!(load(&file, &["/h/.claude".into()]).is_empty());
    }
}
