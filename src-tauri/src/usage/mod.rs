//! Usage: plan limits (as Claude Code's /usage shows them) and local token counts (WP7).
//! The sign-in token never leaves Rust; the webview gets percentages, reset times and error texts.

pub mod cache;
pub mod creds;
pub mod local;
pub mod plan;
pub mod types;

use crate::core::error::{AppError, AppResult, blocking, lock};
use crate::core::{events, paths, profiles};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{App, AppHandle, Emitter, Manager};
use types::{PlanReport, PlansUpdate, UsageReport};

/// Plan state shared by every window: what is shown, and whether a refresh runs.
pub struct Usage {
    fetcher: plan::Fetcher,
    plans: Mutex<Vec<PlanReport>>,
    busy: AtomicBool,
    local: local::LocalUsage,
    cache_file: PathBuf,
}

pub fn init(app: &mut App) -> AppResult<()> {
    let fetcher =
        plan::Fetcher::new(plan::USAGE_URL).map_err(|e| AppError::Internal(format!("could not set up HTTPS: {e}")))?;
    app.manage(Usage {
        fetcher,
        plans: Mutex::default(),
        busy: AtomicBool::new(false),
        local: local::LocalUsage::default(),
        cache_file: paths::app_data_dir(app.handle())?.join("usage-cache.json"),
    });
    app.state::<profiles::Profiles>().set_signed_in(creds::signed_in);
    Ok(())
}

/// Profile folders from the webview, each checked to be a discovered profile.
fn resolve_all(dirs: &[String]) -> AppResult<Vec<PathBuf>> {
    dirs.iter().map(|d| profiles::resolve_profile(d)).collect()
}

fn snapshot(usage: &Usage) -> PlansUpdate {
    let plans = lock(&usage.plans).clone();
    PlansUpdate {
        needs_retry: plan::needs_retry(&plans),
        plans,
        busy: usage.busy.load(Ordering::SeqCst),
    }
}

fn publish(app: &AppHandle, update: &PlansUpdate) {
    if let Err(e) = app.emit(events::USAGE_PLANS, update) {
        log::warn!("emitting usage plans failed: {e}");
    }
}

/// Clears the busy flag when a refresh ends, however it ends.
struct BusyGuard<'a>(&'a AtomicBool);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

// ---- commands ----

/// Saved plan numbers of `profiles`, for showing something at once.
#[tauri::command]
pub async fn usage_cached(app: AppHandle, profiles: Vec<String>) -> AppResult<Vec<PlanReport>> {
    blocking(move || {
        let dirs = resolve_all(&profiles)?;
        let dirs: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect();
        Ok(cache::load(&app.state::<Usage>().cache_file, &dirs))
    })
    .await
}

/// Refreshes the plan limits of `profiles` (one after another) and returns them; `usage-plans` reports
/// the start and the end. Skipped while a refresh runs, and, unless `force`, when the same profiles were
/// fetched under 5 minutes ago and nothing needs a retry.
#[tauri::command]
pub async fn usage_plans(app: AppHandle, profiles: Vec<String>, force: Option<bool>) -> AppResult<PlansUpdate> {
    let dirs = blocking(move || resolve_all(&profiles)).await?;
    let wanted: Vec<String> = dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect();
    let usage = app.state::<Usage>();
    if usage.busy.swap(true, Ordering::SeqCst) {
        return Ok(snapshot(&usage));
    }
    let busy = BusyGuard(&usage.busy);
    let shown = lock(&usage.plans).clone();
    if !force.unwrap_or(false) && plan::can_skip(&shown, &wanted, plan::now_ms()) {
        return Ok(PlansUpdate {
            busy: false,
            ..snapshot(&usage)
        });
    }
    // other profiles than shown: their saved numbers first, while the fresh ones load
    let same = shown.len() == wanted.len() && shown.iter().zip(&wanted).all(|(p, d)| p.profile == *d);
    let mut old = shown;
    if !same {
        let file = usage.cache_file.clone();
        let names = wanted.clone();
        old = blocking(move || Ok(cache::load(&file, &names))).await?;
        *lock(&usage.plans) = old.clone();
    }
    publish(&app, &snapshot(&usage));

    let mut fresh = Vec::with_capacity(dirs.len());
    for (dir, profile) in dirs.into_iter().zip(&wanted) {
        let key = paths::key(profile);
        let name = profiles::name(&dir);
        let creds = blocking(move || Ok(creds::read(&dir))).await?;
        fresh.push(usage.fetcher.fetch(&key, profile, &name, creds).await);
    }
    let merged = plan::merge(&old, fresh);
    let file = usage.cache_file.clone();
    let to_save = merged.clone();
    blocking(move || {
        cache::save(&file, &to_save);
        Ok(())
    })
    .await?;
    *lock(&usage.plans) = merged;
    drop(busy);
    let update = snapshot(&usage);
    publish(&app, &update);
    Ok(update)
}

/// Token counts from the transcripts of `profiles`.
#[tauri::command]
pub async fn usage_local(app: AppHandle, profiles: Vec<String>) -> AppResult<UsageReport> {
    blocking(move || {
        let roots: Vec<PathBuf> = resolve_all(&profiles)?
            .into_iter()
            .map(|d| d.join("projects"))
            .collect();
        Ok(app.state::<Usage>().local.report(&roots))
    })
    .await
}
