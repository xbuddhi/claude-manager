//! Live sessions: which claude sessions run now (in the app or elsewhere), every 2 s on a background
//! thread over all profiles. Emits `live-changed` only when some session's id or level changed, and runs
//! the finish notifications on every tick. Also "switch to running session" and orphan cleanup.

pub mod focus;
pub mod orphans;
pub mod reach;
pub mod scan;
pub mod snapshot;
pub mod types;

use crate::core::error::{AppError, AppResult, blocking, lock};
use crate::core::types::LiveSession;
use crate::core::{events, paths, procs::Procs, profiles, terms};
use reach::Hosts;
use scan::Found;
use snapshot::Snapshot;
use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, SystemTime};
use tauri::{App, AppHandle, Emitter, Manager};
use types::{LiveChanged, Orphan};

const TICK: Duration = Duration::from_secs(2);

/// Managed state: the last scan's result and a way to ask for the next one early.
pub struct Live {
    current: Mutex<Current>,
    wake: Mutex<Sender<()>>,
}

#[derive(Default)]
struct Current {
    live: LiveChanged,
    signature: String,
}

impl Live {
    fn session(&self, session_id: &str) -> Option<LiveSession> {
        let current = lock(&self.current);
        current
            .live
            .sessions
            .iter()
            .find(|s| s.session_id == session_id)
            .cloned()
    }

    /// Runs the next scan now instead of at the next tick.
    fn wake(&self) {
        let _ = lock(&self.wake).send(());
    }
}

pub fn init(app: &mut App) -> AppResult<()> {
    let (tx, rx) = mpsc::channel::<()>();
    app.manage(Live {
        current: Mutex::new(Current::default()),
        wake: Mutex::new(tx),
    });
    let handle = app.handle().clone();
    std::thread::Builder::new()
        .name("live-scan".into())
        .spawn(move || {
            loop {
                tick(&handle);
                match rx.recv_timeout(TICK) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| AppError::Internal(format!("could not start the live-session scan: {e}")))?;
    Ok(())
}

/// One scan of every profile: the validated sessions (duplicates included), the process table and the hosts.
struct Scan {
    found: Vec<Found>,
    snap: Snapshot,
    hosts: Hosts,
}

fn scan_now(app: &AppHandle) -> AppResult<Scan> {
    let home = paths::home()?;
    let markers: Vec<_> = profiles::discover(&home, profiles::launch_config_dir().as_deref())
        .into_iter()
        .map(|p| {
            let m = scan::read_markers(&p);
            (p, m)
        })
        .collect();
    let cmd_for: HashSet<u32> = markers.iter().flat_map(|(_, m)| m.key_pids()).collect();
    let snap = Snapshot::take(&app.state::<Procs>(), &cmd_for);
    let found = scan::evaluate(&markers, &snap, SystemTime::now());
    let hosts = Hosts::collect(terms::pids(app));
    Ok(Scan { found, snap, hosts })
}

fn tick(app: &AppHandle) {
    let scan = match scan_now(app) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("live-session scan failed: {e}");
            return;
        }
    };
    let sessions = dedupe(
        scan.found
            .iter()
            .map(|f| (f, scan.hosts.reachable(&scan.snap, f.pid)))
            .collect(),
    );
    let live = LiveChanged {
        live_cwd: live_cwd(&sessions),
        sessions,
    };
    let signature = signature(&live.sessions);
    let state = app.state::<Live>();
    let changed = {
        let mut current = lock(&state.current);
        let changed = current.signature != signature;
        current.live = live.clone();
        current.signature = signature;
        changed
    };
    if changed && let Err(e) = app.emit(events::LIVE_CHANGED, &live) {
        log::error!("could not report live sessions: {e}");
    }
    crate::notify::on_tick(app, &live.sessions, &scan.snap);
}

/// One entry per session: a process the app can bring to the front wins, else the busier one.
fn dedupe(found: Vec<(&Found, bool)>) -> Vec<LiveSession> {
    let mut out: Vec<LiveSession> = Vec::new();
    for (f, reachable) in found {
        let entry = LiveSession {
            session_id: f.session_id.clone(),
            pid: f.pid,
            level: f.level,
            cwd: f.cwd.clone(),
            profile: f.profile.to_string_lossy().into_owned(),
            reachable,
        };
        match out.iter_mut().find(|s| s.session_id == f.session_id) {
            None => out.push(entry),
            Some(prev) => {
                let better = if prev.reachable != reachable {
                    reachable
                } else {
                    f.level > prev.level
                };
                if better {
                    *prev = entry;
                }
            }
        }
    }
    out
}

/// Highest level per folder, keyed like the frontend's `pathKey`.
fn live_cwd(sessions: &[LiveSession]) -> BTreeMap<String, u8> {
    let mut map = BTreeMap::new();
    for s in sessions {
        if let Some(cwd) = &s.cwd {
            let level = map.entry(paths::key(cwd)).or_insert(0);
            *level = (*level).max(s.level);
        }
    }
    map
}

/// `id=level;...` sorted by id: what the UI shows, so only a change here is reported.
fn signature(sessions: &[LiveSession]) -> String {
    let mut parts: Vec<String> = sessions
        .iter()
        .map(|s| format!("{}={}", s.session_id, s.level))
        .collect();
    parts.sort();
    parts.join(";")
}

// ---- commands ----

/// The last scan's sessions (the same value `live-changed` carries).
#[tauri::command]
pub async fn get_live(app: AppHandle) -> AppResult<LiveChanged> {
    Ok(lock(&app.state::<Live>().current).live.clone())
}

/// The running session's process and its ancestors, nearest first (empty when it is not running).
/// The frontend matches them against its terminal tabs.
#[tauri::command]
pub async fn live_ancestors(app: AppHandle, session_id: String) -> AppResult<Vec<u32>> {
    let Some(session) = app.state::<Live>().session(&session_id) else {
        return Ok(Vec::new());
    };
    blocking(move || {
        let snap = Snapshot::take(&app.state::<Procs>(), &HashSet::new());
        Ok(snap.chain(session.pid, reach::TERM_DEPTH))
    })
    .await
}

/// Brings the window a running session lives in to the front (after the frontend found no tab for it).
#[tauri::command]
pub async fn focus_live(app: AppHandle, session_id: String) -> AppResult<bool> {
    let Some(session) = app.state::<Live>().session(&session_id) else {
        return Ok(false);
    };
    blocking(move || {
        let snap = Snapshot::take(&app.state::<Procs>(), &HashSet::new());
        Ok(focus::bring_forward(&app, &snap, session.pid))
    })
    .await
}

/// Running sessions no window can reach, of `profile` (a profile folder) or of every profile (null).
#[tauri::command]
pub async fn find_orphans(app: AppHandle, profile: Option<String>) -> AppResult<Vec<Orphan>> {
    let profile = profile.map(|p| profiles::resolve_profile(&p)).transpose()?;
    blocking(move || {
        let scan = scan_now(&app)?;
        Ok(orphans::find(&scan.found, &scan.snap, &scan.hosts, profile.as_deref()))
    })
    .await
}

/// Ends the given orphans. Each pid is checked again: only a running claude session that is still
/// unreachable is ended. Returns how many were ended; the live state refreshes right after.
#[tauri::command]
pub async fn close_orphans(app: AppHandle, pids: Vec<u32>) -> AppResult<u32> {
    blocking(move || {
        let scan = scan_now(&app)?;
        let current = orphans::find(&scan.found, &scan.snap, &scan.hosts, None);
        let closed = orphans::close(&pids, &current, &scan.snap);
        log::info!("closed {closed} background session(s)");
        app.state::<Live>().wake();
        Ok(closed)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn found(id: &str, pid: u32, level: u8, cwd: &str) -> Found {
        Found {
            session_id: id.into(),
            pid,
            level,
            cwd: Some(cwd.into()),
            profile: PathBuf::from("/h/.claude"),
        }
    }

    #[test]
    fn dedupes_preferring_reachable_then_busier() {
        let a1 = found("a", 1, 2, "C:\\x");
        let a2 = found("a", 2, 1, "C:\\x");
        let b1 = found("b", 3, 1, "C:\\y");
        let b2 = found("b", 4, 2, "C:\\y");
        let c1 = found("c", 5, 1, "C:\\X\\");
        let c2 = found("c", 6, 2, "C:\\x");
        let out = dedupe(vec![
            (&a1, false),
            (&a2, true),
            (&b1, true),
            (&b2, true),
            (&c1, true),
            (&c2, false),
        ]);
        let got: Vec<(&str, u32)> = out.iter().map(|s| (s.session_id.as_str(), s.pid)).collect();
        assert_eq!(got, [("a", 2), ("b", 4), ("c", 5)]);
        let cwd = live_cwd(&out);
        // "C:\X\" and "C:\x" are one folder on Windows and macOS
        if cfg!(any(windows, target_os = "macos")) {
            assert_eq!(cwd.len(), 2);
            assert_eq!(cwd[&paths::key("C:\\x")], 1);
        }
        assert_eq!(cwd[&paths::key("C:\\y")], 2);
    }

    #[test]
    fn signature_changes_only_with_ids_and_levels() {
        let s = |id: &str, pid: u32, level: u8| LiveSession {
            session_id: id.into(),
            pid,
            level,
            cwd: None,
            profile: String::new(),
            reachable: false,
        };
        let one = signature(&[s("b", 1, 1), s("a", 2, 2)]);
        assert_eq!(one, "a=2;b=1");
        assert_eq!(one, signature(&[s("a", 9, 2), s("b", 8, 1)]));
        assert_ne!(one, signature(&[s("a", 2, 1), s("b", 1, 1)]));
        assert_ne!(one, signature(&[s("a", 2, 2)]));
        assert_eq!(signature(&[]), "");
    }
}
