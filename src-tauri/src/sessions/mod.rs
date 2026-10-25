//! Session index (WP1): every transcript of every profile, kept current by a file watcher instead of polling.
//!
//! Start: a fast pass reads at most 64 KB of each new transcript (cwd, first prompt, titles) and the list is
//! shown; a second pass reads the rest, largest files first. Afterwards only changed files are read, and
//! only their new lines. Every change bumps a generation and emits `index-changed`; the frontend then
//! fetches with `get_index(sinceGen)` and gets nothing back when nothing changed.

pub mod cache;
pub mod group;
pub mod parse;
pub mod scan;
pub mod types;
pub mod watch;

use crate::core::error::{AppResult, blocking, lock};
use crate::core::events;
use crate::core::lifecycle::{self, ShutdownHook};
use crate::core::types::Project;
use crate::core::{paths, profiles, settings};
use scan::{HEADER_BYTES, Scanner, Transcript};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{App, AppHandle, Emitter, Listener, Manager};
use types::{IndexChanged, IndexSnapshot, ProfileCount};

/// The cache file is written at most this often while transcripts keep changing (and on exit).
const SAVE_EVERY: Duration = Duration::from_secs(10);

/// The index. Managed as state.
pub struct Index {
    scanner: Scanner,
    /// One scan at a time, so an older result never lands after a newer one.
    scan_lock: Mutex<()>,
    generation: AtomicU64,
    ready: AtomicBool,
    pinned: Mutex<Vec<String>>,
    /// Projects grouped for one generation.
    grouped: Mutex<Option<(u64, Arc<Vec<Project>>)>>,
    last_save: Mutex<Instant>,
}

impl Index {
    pub fn new(cache_path: Option<PathBuf>, pinned: Vec<String>) -> Self {
        Self {
            scanner: Scanner::new(cache_path),
            scan_lock: Mutex::new(()),
            generation: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            pinned: Mutex::new(pinned),
            grouped: Mutex::new(None),
            last_save: Mutex::new(Instant::now()),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    fn bump(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// The first scan (and a full rescan): a fast pass over the start of new files, then the rest.
    /// `fresh` reads every file again from the start. Calls `changed` after each pass that changed something.
    pub fn full_scan(&self, profiles: &[PathBuf], fresh: bool, changed: impl Fn(u64)) {
        let _scan = lock(&self.scan_lock);
        if fresh {
            self.scanner.reset();
        }
        let started = Instant::now();
        let first = self.scanner.scan(profiles, Some(HEADER_BYTES));
        let was_ready = self.ready.swap(true, Ordering::SeqCst);
        if first.changed || !was_ready || fresh {
            changed(self.bump());
        }
        log::info!(
            "session index: {} transcripts, {} read ({} KB) in {:?}",
            first.files,
            first.opened,
            first.bytes_read >> 10,
            started.elapsed()
        );
        if first.partial > 0 {
            let rest = self.scanner.scan(profiles, None);
            log::info!(
                "session index: {} large transcripts read ({} MB) in {:?}",
                rest.opened,
                rest.bytes_read >> 20,
                started.elapsed()
            );
            if rest.changed {
                changed(self.bump());
            }
        }
        self.save(true);
    }

    /// Re-reads the given transcript paths (changed, created or deleted). Paths outside `profiles`
    /// are ignored.
    pub fn update_paths(&self, profiles: &[PathBuf], paths: &[PathBuf], changed: impl Fn(u64)) {
        let _scan = lock(&self.scan_lock);
        let mut list = Vec::new();
        let mut gone = false;
        for path in paths {
            let Some((profile, path)) = locate(path, profiles) else {
                continue;
            };
            match Transcript::at(&path, profile) {
                Some(t) => list.push(t),
                None => gone |= self.scanner.remove(&path),
            }
        }
        let stats = self.scanner.update(&list, None);
        if stats.changed || gone {
            changed(self.bump());
        }
        self.save(false);
    }

    /// Stats every transcript and reads what changed (after folder moves, watcher overflows, new profiles).
    pub fn rescan(&self, profiles: &[PathBuf], changed: impl Fn(u64)) {
        let _scan = lock(&self.scan_lock);
        if self.scanner.scan(profiles, None).changed {
            changed(self.bump());
        }
        self.save(false);
    }

    /// Takes the pinned folders from settings; true when they changed.
    pub fn set_pinned(&self, pinned: Vec<String>) -> bool {
        let mut current = lock(&self.pinned);
        if *current == pinned {
            return false;
        }
        *current = pinned;
        true
    }

    /// Writes the cache file when states changed (`now`, or at most every [`SAVE_EVERY`]).
    fn save(&self, now: bool) {
        let mut last = lock(&self.last_save);
        if !now && last.elapsed() < SAVE_EVERY {
            return;
        }
        *last = Instant::now();
        if let Err(e) = self.scanner.save() {
            log::warn!("could not save the session cache: {e}");
        }
    }

    /// Projects of the current generation (grouped once per generation).
    pub fn projects(&self) -> (u64, Arc<Vec<Project>>) {
        let generation = self.generation();
        let mut grouped = lock(&self.grouped);
        if let Some((g, projects)) = grouped.as_ref()
            && *g == generation
        {
            return (generation, projects.clone());
        }
        let pinned = lock(&self.pinned).clone();
        let projects = Arc::new(group::group(self.scanner.sessions(), &pinned, |p| {
            Path::new(p).is_dir()
        }));
        *grouped = Some((generation, projects.clone()));
        (generation, projects)
    }

    pub fn snapshot(&self, since_gen: Option<u64>) -> IndexSnapshot {
        if !self.ready.load(Ordering::SeqCst) {
            return IndexSnapshot {
                generation: 0,
                ready: false,
                projects: None,
                counts: Vec::new(),
            };
        }
        let (generation, projects) = self.projects();
        IndexSnapshot {
            generation,
            ready: true,
            projects: (since_gen != Some(generation)).then(|| projects.as_ref().clone()),
            counts: self.counts(),
        }
    }

    pub fn counts(&self) -> Vec<ProfileCount> {
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        self.scanner
            .for_each(|s| *counts.entry(s.profile.clone()).or_default() += 1);
        counts
            .into_iter()
            .map(|(profile, count)| ProfileCount { profile, count })
            .collect()
    }

    /// Listed sessions of `profile` (None = all profiles).
    pub fn count_for(&self, profile: Option<&str>) -> u32 {
        let wanted = profile.map(paths::key);
        let mut n = 0;
        self.scanner.for_each(|s| {
            if wanted.as_ref().is_none_or(|w| *w == paths::key(&s.profile)) {
                n += 1;
            }
        });
        n
    }

    pub fn label_for(&self, session_id: &str) -> Option<String> {
        let mut found = None;
        self.scanner.for_each(|s| {
            if found.is_none() && s.id.eq_ignore_ascii_case(session_id) {
                found = Some(s.label.clone());
            }
        });
        found
    }
}

/// For a path `<profile>/projects/<slug>/<file>` under one of `profiles`: that profile, and the path spelled
/// the way a scan lists it (a watcher may report another spelling of the same folder).
pub fn locate<'a>(path: &Path, profiles: &'a [PathBuf]) -> Option<(&'a Path, PathBuf)> {
    let file = path.file_name()?;
    let slug_dir = path.parent()?;
    let projects = slug_dir.parent()?;
    if projects.file_name()? != "projects" {
        return None;
    }
    let owner = projects.parent()?;
    let profile = profiles.iter().find(|p| paths::same(p, owner))?;
    let listed = profile.join("projects").join(slug_dir.file_name()?).join(file);
    Some((profile.as_path(), listed))
}

/// The profiles to index right now.
pub fn current_profiles() -> Vec<PathBuf> {
    match paths::home() {
        Ok(home) => profiles::discover(&home, profiles::launch_config_dir().as_deref()),
        Err(_) => Vec::new(),
    }
}

/// Emits `index-changed` for a new generation.
pub fn notify(app: &AppHandle, generation: u64) {
    if let Err(e) = app.emit(events::INDEX_CHANGED, IndexChanged { generation }) {
        log::warn!("could not emit {}: {e}", events::INDEX_CHANGED);
    }
}

struct SaveOnExit(AppHandle);

impl ShutdownHook for SaveOnExit {
    fn shutdown(&self) {
        if let Err(e) = self.0.state::<Index>().scanner.save() {
            log::warn!("could not save the session cache on exit: {e}");
        }
    }
}

pub fn init(app: &mut App) -> AppResult<()> {
    let cache_path = paths::app_cache_dir(app.handle())?.join(cache::FILE_NAME);
    app.manage(Index::new(Some(cache_path), settings::get(app.handle()).pinned));
    lifecycle::register(app.handle(), SaveOnExit(app.handle().clone()));

    let handle = app.handle().clone();
    app.listen(events::SETTINGS_CHANGED, move |_| {
        let index = handle.state::<Index>();
        if index.set_pinned(settings::get(&handle).pinned) {
            notify(&handle, index.bump());
        }
    });

    let watcher = watch::start(app.handle().clone());
    app.listen(events::PROFILES_CHANGED, move |_| watcher.resync());

    let handle = app.handle().clone();
    std::thread::Builder::new()
        .name("session-index".into())
        .spawn(move || {
            let index = handle.state::<Index>();
            index.full_scan(&current_profiles(), false, |g| notify(&handle, g));
        })?;
    Ok(())
}

/// The display label of session `session_id`, for notifications (WP3). None when it is not indexed.
pub fn label_for(app: &AppHandle, session_id: &str) -> Option<String> {
    app.try_state::<Index>()?.label_for(session_id)
}

// ---- commands ----

/// The index: projects only when they changed since generation `since_gen`.
#[tauri::command]
pub async fn get_index(app: AppHandle, since_gen: Option<u64>) -> AppResult<IndexSnapshot> {
    blocking(move || Ok(app.state::<Index>().snapshot(since_gen))).await
}

/// Forgets every read position and reads all transcripts again (F5). Returns at once; `index-changed`
/// follows each pass.
#[tauri::command]
pub async fn rescan_full(app: AppHandle) -> AppResult<()> {
    std::thread::Builder::new()
        .name("session-rescan".into())
        .spawn(move || {
            let index = app.state::<Index>();
            index.full_scan(&current_profiles(), true, |g| notify(&app, g));
        })?;
    Ok(())
}

/// Listed sessions of `profile` (null = all profiles).
#[tauri::command]
pub async fn count_for(app: AppHandle, profile: Option<String>) -> AppResult<u32> {
    Ok(app.state::<Index>().count_for(profile.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use scan::tests::{ID, ID2, transcript, user_line};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn generations_grow_only_on_change() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let profiles = vec![profile];
        let index = Index::new(None, vec![]);
        assert!(!index.snapshot(None).ready);
        let events = AtomicUsize::new(0);
        let count = |_| {
            events.fetch_add(1, Ordering::SeqCst);
        };
        index.full_scan(&profiles, false, count);
        let snap = index.snapshot(None);
        assert!(snap.ready && snap.generation >= 1);
        assert_eq!(snap.projects.as_ref().map(Vec::len), Some(1));
        assert_eq!(
            snap.counts,
            [ProfileCount {
                profile: profiles[0].to_string_lossy().into_owned(),
                count: 1
            }]
        );
        assert!(index.snapshot(Some(snap.generation)).projects.is_none());

        let before = events.load(Ordering::SeqCst);
        index.rescan(&profiles, count);
        index.update_paths(&profiles, std::slice::from_ref(&file), count);
        assert_eq!(events.load(Ordering::SeqCst), before, "nothing changed");

        std::fs::remove_file(&file).unwrap();
        index.update_paths(&profiles, std::slice::from_ref(&file), count);
        assert_eq!(events.load(Ordering::SeqCst), before + 1);
        assert_eq!(index.snapshot(None).projects.map(|p| p.len()), Some(0));
    }

    #[test]
    fn watched_paths_outside_the_profiles_are_ignored() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let elsewhere = home
            .path()
            .join("x")
            .join("projects")
            .join("s")
            .join(format!("{ID2}.jsonl"));
        let profiles = vec![profile.clone()];
        let inside = profile.join("projects").join("s").join("f.jsonl");
        assert_eq!(locate(&inside, &profiles), Some((profile.as_path(), inside.clone())));
        assert_eq!(locate(&elsewhere, &profiles), None);
        assert_eq!(locate(&profile.join("projects").join("f.jsonl"), &profiles), None);
        if cfg!(windows) {
            // the watcher may spell the profile folder differently; the listed spelling is used
            let spelled = PathBuf::from(profile.to_string_lossy().to_uppercase())
                .join("projects")
                .join("s")
                .join("f.jsonl");
            assert_eq!(locate(&spelled, &profiles), Some((profile.as_path(), inside)));
        }
    }

    #[test]
    fn pinned_changes_and_counts() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        transcript(home.path(), "b", ID2, &user_line("two", "/b"));
        let index = Index::new(None, vec![]);
        index.full_scan(std::slice::from_ref(&profile), false, |_| {});
        assert!(!index.set_pinned(vec![]));
        assert!(index.set_pinned(vec!["/pinned".into()]));
        index.bump();
        let names: Vec<String> = index.projects().1.iter().map(|p| p.name.clone()).collect();
        assert_eq!(names[0], "pinned");
        assert_eq!(index.count_for(None), 2);
        assert_eq!(index.count_for(Some(&profile.to_string_lossy())), 2);
        assert_eq!(index.count_for(Some("/nope")), 0);
        assert_eq!(index.label_for(ID2).as_deref(), Some("two"));
    }
}
