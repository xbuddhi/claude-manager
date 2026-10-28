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

use crate::core::error::{AppError, AppResult, blocking, lock};
use crate::core::events;
use crate::core::lifecycle::{self, ShutdownHook};
use crate::core::types::Project;
use crate::core::{paths, profiles, settings};
use scan::{HEADER_BYTES, Scanner, Transcript};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{App, AppHandle, Emitter, Listener, Manager};
use types::{IndexChanged, IndexSnapshot, ProfileCount, ProjectList};

/// The cache file is written at most this often while transcripts keep changing (and on exit).
const SAVE_EVERY: Duration = Duration::from_secs(45);
/// Grouped generations kept to send only the changes since one of them.
const KEPT_GENERATIONS: usize = 8;
/// How long a project folder's "missing" check is trusted (scans check again at once).
const DIRS_FOR: Duration = Duration::from_secs(30);

/// The projects of one generation. Unchanged projects share their `Arc` with the previous generation,
/// so a changed project is one whose `Arc` differs.
#[derive(Clone)]
struct Generation {
    generation: u64,
    projects: Arc<Vec<Arc<Project>>>,
    /// No two projects have the same path, so changes can be sent by path.
    unique: bool,
}

/// Which project folders exist, checked at most every [`DIRS_FOR`].
struct Dirs {
    checked: Instant,
    exists: HashMap<String, bool>,
}

/// The index. Managed as state.
pub struct Index {
    scanner: Scanner,
    /// One scan at a time, so an older result never lands after a newer one.
    scan_lock: Mutex<()>,
    generation: AtomicU64,
    ready: AtomicBool,
    pinned: Mutex<Vec<String>>,
    /// Projects grouped for the last few generations asked for, newest last.
    grouped: Mutex<VecDeque<Generation>>,
    dirs: Mutex<Dirs>,
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
            grouped: Mutex::new(VecDeque::new()),
            dirs: Mutex::new(Dirs {
                checked: Instant::now(),
                exists: HashMap::new(),
            }),
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
        let scan = lock(&self.scan_lock);
        self.forget_dirs();
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
        drop(scan);
        self.save(true);
    }

    /// Re-reads the given transcript paths (changed, created or deleted). Paths outside `profiles`
    /// are ignored.
    pub fn update_paths(&self, profiles: &[PathBuf], paths: &[PathBuf], changed: impl Fn(u64)) {
        let scan = lock(&self.scan_lock);
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
        drop(scan);
        self.save(false);
    }

    /// Stats every transcript and reads what changed (after folder moves, watcher overflows, new profiles).
    pub fn rescan(&self, profiles: &[PathBuf], changed: impl Fn(u64)) {
        let scan = lock(&self.scan_lock);
        self.forget_dirs();
        if self.scanner.scan(profiles, None).changed {
            changed(self.bump());
        }
        drop(scan);
        self.save(false);
    }

    /// The next grouping checks every project folder again.
    fn forget_dirs(&self) {
        lock(&self.dirs).exists.clear();
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
    pub fn projects(&self) -> (u64, Arc<Vec<Arc<Project>>>) {
        let g = self.current();
        (g.generation, g.projects)
    }

    fn current(&self) -> Generation {
        let generation = self.generation();
        let mut grouped = lock(&self.grouped);
        if let Some(g) = grouped.back()
            && g.generation == generation
        {
            return g.clone();
        }
        let pinned = lock(&self.pinned).clone();
        let fresh = {
            let mut dirs = lock(&self.dirs);
            if dirs.checked.elapsed() >= DIRS_FOR {
                dirs.exists.clear();
                dirs.checked = Instant::now();
            }
            group::group(self.scanner.sessions_with_folders(), &pinned, |p| {
                *dirs
                    .exists
                    .entry(p.to_string())
                    .or_insert_with(|| Path::new(p).is_dir())
            })
        };
        // a project equal to the one of the previous generation keeps its Arc
        let previous: HashMap<&str, &Arc<Project>> = grouped
            .back()
            .map(|g| g.projects.iter().map(|p| (p.path.as_str(), p)).collect())
            .unwrap_or_default();
        let projects: Vec<Arc<Project>> = fresh
            .into_iter()
            .map(|p| match previous.get(p.path.as_str()) {
                Some(old) if ***old == p => Arc::clone(old),
                _ => Arc::new(p),
            })
            .collect();
        drop(previous);
        let mut seen = HashSet::new();
        let unique = projects.iter().all(|p| seen.insert(p.path.as_str()));
        let g = Generation {
            generation,
            projects: Arc::new(projects),
            unique,
        };
        // generations only grow; an older one is never added after a newer one
        if grouped.back().is_none_or(|b| b.generation < generation) {
            grouped.push_back(g.clone());
            while grouped.len() > KEPT_GENERATIONS {
                grouped.pop_front();
            }
        }
        g
    }

    /// The index for a frontend that holds generation `since_gen`: nothing when that is current, only the
    /// changes when that generation is still kept, else every project.
    pub fn snapshot(&self, since_gen: Option<u64>) -> IndexSnapshot {
        let mut snap = IndexSnapshot {
            generation: 0,
            ready: false,
            projects: None,
            counts: Vec::new(),
            base: None,
            changed: None,
            order: None,
        };
        if !self.ready.load(Ordering::SeqCst) {
            return snap;
        }
        let current = self.current();
        snap.generation = current.generation;
        snap.ready = true;
        snap.counts = self.counts();
        if since_gen == Some(current.generation) {
            return snap;
        }
        let base = since_gen.and_then(|since| {
            let grouped = lock(&self.grouped);
            grouped.iter().find(|g| g.generation == since).cloned()
        });
        match base.filter(|b| b.unique && current.unique) {
            Some(base) => {
                let old: HashMap<&str, &Arc<Project>> = base.projects.iter().map(|p| (p.path.as_str(), p)).collect();
                let changed = current
                    .projects
                    .iter()
                    .filter(|p| old.get(p.path.as_str()).is_none_or(|o| !Arc::ptr_eq(o, p)))
                    .cloned()
                    .collect();
                snap.base = Some(base.generation);
                snap.changed = Some(ProjectList(changed));
                snap.order = Some(current.projects.iter().map(|p| p.path.clone()).collect());
            }
            None => snap.projects = Some(ProjectList(current.projects.as_ref().clone())),
        }
        snap
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

    /// Transcripts of `profile` last written after `since` (path, last write). None until the first scan
    /// is done. Only listed sessions (with a user message) are included.
    pub fn transcripts_since(&self, profile: &Path, since: SystemTime) -> Option<Vec<(PathBuf, SystemTime)>> {
        if !self.ready.load(Ordering::SeqCst) {
            return None;
        }
        let since_ms = since.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let mut out = Vec::new();
        self.scanner.for_each(|s| {
            if s.modified > since_ms && Path::new(&s.profile) == profile {
                out.push((PathBuf::from(&s.file), UNIX_EPOCH + Duration::from_millis(s.modified)));
            }
        });
        Some(out)
    }

    /// The shown text (at most 600 characters) of session `id` in `profile`; None when it is not listed.
    pub fn text_for(&self, profile: &Path, id: &str) -> Option<String> {
        self.scanner.text_of(profile, id)
    }

    /// Ids of the listed sessions of `profile` (None = all) whose shown text contains `query`, case-insensitively
    /// (both sides lower-cased, as the webview did), newest first, at most `limit`. Sessions without a text
    /// ("(no prompt)") never match.
    pub fn search(&self, query: &str, profile: Option<&Path>, limit: usize) -> Vec<String> {
        let q = query.trim().to_lowercase();
        if q.is_empty() || limit == 0 {
            return Vec::new();
        }
        let mut hits: Vec<(u64, String)> = Vec::new();
        self.scanner.for_each_text(|s, text| {
            if profile.is_some_and(|p| !paths::same(Path::new(&s.profile), p)) || text == "(no prompt)" {
                return;
            }
            if text.to_lowercase().contains(&q) {
                hits.push((s.modified, s.id.clone()));
            }
        });
        hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        hits.into_iter().take(limit).map(|(_, id)| id).collect()
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

/// Transcripts of `profile` last written after `since`, from the index (for the live scan, which would
/// otherwise list them from disk every tick). None while the first scan runs.
pub fn transcripts_since(app: &AppHandle, profile: &Path, since: SystemTime) -> Option<Vec<(PathBuf, SystemTime)>> {
    app.try_state::<Index>()?.transcripts_since(profile, since)
}

/// The display label of session `session_id`, for notifications (WP3). None when it is not indexed.
pub fn label_for(app: &AppHandle, session_id: &str) -> Option<String> {
    app.try_state::<Index>()?.label_for(session_id)
}

// ---- commands ----

/// The index: nothing when generation `since_gen` is current, only the changed projects when the backend
/// still knows that generation, else every project.
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

/// Most ids `search_sessions` returns.
const SEARCH_LIMIT: usize = 500;

/// The text a session is shown with (title, summary or first prompt), at most 600 characters, for the
/// details pane. Null when the session is not listed.
#[tauri::command]
pub async fn session_text(app: AppHandle, profile: String, id: String) -> AppResult<Option<String>> {
    if !profiles::is_session_id(&id) {
        return Err(AppError::InvalidInput(format!("Not a session id: {id}")));
    }
    let profile = profiles::resolve_profile(&profile)?;
    blocking(move || Ok(app.state::<Index>().text_for(&profile, &id))).await
}

/// Ids of the sessions whose text contains `query` (case-insensitive), newest first, at most 500; `profile`
/// null = all profiles. The webview matches labels itself and merges both.
#[tauri::command]
pub async fn search_sessions(app: AppHandle, query: String, profile: Option<String>) -> AppResult<Vec<String>> {
    let profile = profile.as_deref().map(profiles::resolve_profile).transpose()?;
    blocking(move || Ok(app.state::<Index>().search(&query, profile.as_deref(), SEARCH_LIMIT))).await
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
        assert_eq!(snap.projects.as_ref().map(|p| p.0.len()), Some(1));
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
        assert_eq!(index.snapshot(None).projects.map(|p| p.0.len()), Some(0));
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

    fn paths_of(list: &ProjectList) -> Vec<&str> {
        list.0.iter().map(|p| p.path.as_str()).collect()
    }

    #[test]
    fn sends_only_the_projects_that_changed_since_a_kept_generation() {
        let home = tempfile::tempdir().unwrap();
        let (profile, a) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let (_, b) = transcript(home.path(), "b", ID2, &user_line("two", "/b"));
        let profiles = vec![profile];
        let index = Index::new(None, vec![]);
        index.full_scan(&profiles, false, |_| {});
        let first = index.snapshot(None);
        let full = first.projects.clone().unwrap();
        assert!(first.base.is_none() && first.changed.is_none() && first.order.is_none());

        // /a grows and becomes the newest project: only it is sent, with the new order
        let mut f = std::fs::OpenOptions::new().append(true).open(&a).unwrap();
        std::io::Write::write_all(&mut f, user_line("more", "/a").as_bytes()).unwrap();
        let later = std::fs::metadata(&b).unwrap().modified().unwrap() + Duration::from_secs(5);
        f.set_modified(later).unwrap();
        drop(f);
        index.update_paths(&profiles, std::slice::from_ref(&a), |_| {});
        let delta = index.snapshot(Some(first.generation));
        assert!(delta.generation > first.generation);
        assert_eq!(delta.base, Some(first.generation));
        assert!(delta.projects.is_none());
        let changed = delta.changed.as_ref().unwrap();
        assert_eq!(paths_of(changed), ["/a"]);
        assert_eq!(changed.0[0].sessions[0].count, 2);
        assert_eq!(delta.order.as_deref(), Some(&["/a".to_string(), "/b".to_string()][..]));
        // the unchanged project is the same shared value as before
        let now = index.projects().1;
        let old_b = full.0.iter().find(|p| p.path == "/b").unwrap();
        assert!(Arc::ptr_eq(old_b, now.iter().find(|p| p.path == "/b").unwrap()));

        // a removed project is left out of the order
        std::fs::remove_file(&b).unwrap();
        index.update_paths(&profiles, std::slice::from_ref(&b), |_| {});
        let removed = index.snapshot(Some(delta.generation));
        assert_eq!(removed.base, Some(delta.generation));
        assert_eq!(removed.changed.map(|c| c.0.len()), Some(0));
        assert_eq!(removed.order.as_deref(), Some(&["/a".to_string()][..]));

        // nothing changed: nothing is sent
        let same = index.snapshot(Some(removed.generation));
        assert!(same.projects.is_none() && same.base.is_none() && same.changed.is_none());
    }

    #[test]
    fn unknown_or_forgotten_generations_get_every_project() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let index = Index::new(None, vec![]);
        index.full_scan(std::slice::from_ref(&profile), false, |_| {});
        let first = index.snapshot(None);
        // a generation the backend never grouped
        let odd = index.snapshot(Some(first.generation + 100));
        assert!(odd.base.is_none());
        assert_eq!(odd.projects.map(|p| p.0.len()), Some(1));
        // more generations than are kept
        for i in 0..KEPT_GENERATIONS + 1 {
            assert!(index.set_pinned(vec![format!("/pin{i}")]));
            index.bump();
            index.snapshot(None);
        }
        let old = index.snapshot(Some(first.generation));
        assert!(old.base.is_none());
        assert_eq!(old.projects.map(|p| p.0.len()), Some(2));
    }

    #[test]
    fn same_paths_twice_are_sent_whole() {
        let home = tempfile::tempdir().unwrap();
        // a transcript without a folder is listed under its slug; a pinned folder spelled like it collides
        let (profile, _) = transcript(
            home.path(),
            "slug",
            ID,
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
        );
        let index = Index::new(None, vec!["slug".into()]);
        index.full_scan(std::slice::from_ref(&profile), false, |_| {});
        let first = index.snapshot(None);
        assert_eq!(paths_of(first.projects.as_ref().unwrap()), ["slug", "slug"]);
        index.bump();
        let next = index.snapshot(Some(first.generation));
        assert!(next.base.is_none() && next.projects.is_some());
    }

    #[test]
    fn transcripts_since_come_from_the_index() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let index = Index::new(None, vec![]);
        assert!(index.transcripts_since(&profile, UNIX_EPOCH).is_none());
        index.full_scan(std::slice::from_ref(&profile), false, |_| {});
        let all = index.transcripts_since(&profile, UNIX_EPOCH).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, file);
        let future = SystemTime::now() + Duration::from_secs(3600);
        assert!(index.transcripts_since(&profile, future).unwrap().is_empty());
        assert!(
            index
                .transcripts_since(&home.path().join("x"), UNIX_EPOCH)
                .unwrap()
                .is_empty()
        );
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

    #[test]
    fn finds_sessions_by_text_and_gives_one_session_its_text() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("Fix the LOGIN form", "/a"));
        let (_, b) = transcript(home.path(), "b", ID2, &user_line("Straße login", "/b"));
        // a command line only: listed as "(no prompt)"
        let id3 = "2f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
        transcript(
            home.path(),
            "c",
            id3,
            &user_line("<command-name>/clear</command-name>", "/c"),
        );
        let later = std::fs::metadata(&b).unwrap().modified().unwrap() + Duration::from_secs(5);
        std::fs::File::options()
            .append(true)
            .open(&b)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let index = Index::new(None, vec![]);
        index.full_scan(std::slice::from_ref(&profile), false, |_| {});
        assert_eq!(index.search("login", None, SEARCH_LIMIT), [ID2, ID], "newest first");
        assert_eq!(index.search("  LOGIN ", Some(&profile), SEARCH_LIMIT), [ID2, ID]);
        assert_eq!(
            index.search("login", Some(Path::new("/nope")), SEARCH_LIMIT),
            Vec::<String>::new()
        );
        assert_eq!(index.search("login", None, 1), [ID2]);
        assert_eq!(
            index.search("STRASSE", None, SEARCH_LIMIT),
            Vec::<String>::new(),
            "lower-cased, not folded"
        );
        assert_eq!(index.search("straße", None, SEARCH_LIMIT), [ID2]);
        assert_eq!(index.search("", None, SEARCH_LIMIT), Vec::<String>::new());
        assert_eq!(
            index.search("prompt", None, SEARCH_LIMIT),
            Vec::<String>::new(),
            "no '(no prompt)' match"
        );
        assert_eq!(index.count_for(None), 3);
        assert_eq!(index.text_for(&profile, id3).as_deref(), Some("(no prompt)"));
        assert_eq!(index.text_for(&profile, ID).as_deref(), Some("Fix the LOGIN form"));
        assert_eq!(
            index.text_for(&profile, &ID.to_uppercase()).as_deref(),
            Some("Fix the LOGIN form")
        );
        assert_eq!(index.text_for(Path::new("/nope"), ID), None);
    }
}
