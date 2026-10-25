//! Finds transcripts and keeps one [`ParseState`] and built [`Session`] per file. A transcript whose length and
//! write time are unchanged is not opened; one that grew is read from where the last read stopped.
//! The states survive restarts in the cache file (see `cache.rs`), so a warm start only stats files.

use super::cache;
use super::parse::{self, ParseState};
use crate::core::error::{AppResult, lock};
use crate::core::profiles;
use crate::core::types::Session;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs::{File, Metadata};
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

/// What the fast first pass reads of a transcript it has not seen: cwd, first prompt and titles are there.
pub const HEADER_BYTES: u64 = 64 << 10;

/// A transcript file as listed: `<profile>/projects/<slug>/<uuid>.jsonl`.
#[derive(Clone, Debug)]
pub struct Transcript {
    pub path: PathBuf,
    pub profile: String,
    pub len: u64,
    pub mtime_ms: u64,
}

impl Transcript {
    fn from_meta(path: PathBuf, profile: &Path, meta: &Metadata) -> Option<Self> {
        if !meta.is_file() {
            return None; // symlinks are not followed
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        Some(Self {
            path,
            profile: profile.to_string_lossy().into_owned(),
            len: meta.len(),
            mtime_ms,
        })
    }

    /// Stats one path; None when it is gone, a symlink or not a transcript name.
    pub fn at(path: &Path, profile: &Path) -> Option<Self> {
        if !is_transcript_name(path) {
            return None;
        }
        let meta = std::fs::symlink_metadata(path).ok()?;
        Self::from_meta(path.to_path_buf(), profile, &meta)
    }
}

/// `<uuid>.jsonl`: the id is passed to `claude --resume`, so nothing else is ever listed.
pub fn is_transcript_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_suffix(".jsonl"))
        .is_some_and(profiles::is_session_id)
}

/// Every transcript of `profiles`, one folder level below `projects` (`<id>/subagents` are skipped).
pub fn transcripts(profiles: &[PathBuf]) -> Vec<Transcript> {
    let mut out = Vec::new();
    for profile in profiles {
        let root = profile.join("projects");
        if !std::fs::symlink_metadata(&root).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(slugs) = std::fs::read_dir(&root) else { continue };
        for slug in slugs.flatten() {
            if !slug.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(slug.path()) else {
                continue;
            };
            for f in files.flatten() {
                let path = f.path();
                if !is_transcript_name(&path) {
                    continue;
                }
                // DirEntry::metadata does not follow symlinks
                if let Some(t) = f.metadata().ok().and_then(|m| Transcript::from_meta(path, profile, &m)) {
                    out.push(t);
                }
            }
        }
    }
    out
}

/// What one scan did, for logs and tests.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScanStats {
    pub files: usize,
    /// Files that were opened (the rest were unchanged).
    pub opened: usize,
    pub bytes_read: u64,
    /// Files still only partly read (a budget was given).
    pub partial: usize,
    /// Some session was added, removed or changed.
    pub changed: bool,
}

struct Entry {
    state: ParseState,
    /// Built from `state` the last time the file was looked at; None for states loaded from the cache.
    session: Option<Session>,
}

/// The parse states and sessions of every transcript seen. No globals: tests make their own.
pub struct Scanner {
    cache_path: Option<PathBuf>,
    entries: Mutex<HashMap<PathBuf, Entry>>,
    /// States changed since the cache file was written.
    dirty: AtomicBool,
    /// One save at a time: the watcher, the scan and the exit hook all save, and two writers of the
    /// same temporary file could publish a mixed cache.
    save_lock: Mutex<()>,
}

enum Outcome {
    Unchanged,
    Updated {
        opened: bool,
        bytes: u64,
        partial: bool,
        changed: bool,
    },
    Gone,
}

impl Scanner {
    /// Starts from the states in `cache_path` (if any; a missing or unreadable cache starts empty).
    pub fn new(cache_path: Option<PathBuf>) -> Self {
        let states = cache_path.as_deref().map(cache::load).unwrap_or_default();
        let entries = states
            .into_iter()
            .map(|(path, state)| (path, Entry { state, session: None }))
            .collect();
        Self {
            cache_path,
            entries: Mutex::new(entries),
            dirty: AtomicBool::new(false),
            save_lock: Mutex::new(()),
        }
    }

    /// Brings every transcript of `profiles` up to date and forgets files that are gone. With a `budget`,
    /// reads at most that many new bytes per file (the rest is read by a later scan without one).
    pub fn scan(&self, profiles: &[PathBuf], budget: Option<u64>) -> ScanStats {
        let list = transcripts(profiles);
        let seen: HashSet<&Path> = list.iter().map(|t| t.path.as_path()).collect();
        let mut pruned = false;
        lock(&self.entries).retain(|path, e| {
            let keep = seen.contains(path.as_path());
            pruned |= !keep && e.session.as_ref().is_some_and(|s| s.count > 0);
            if !keep {
                self.dirty.store(true, Ordering::Relaxed);
            }
            keep
        });
        let mut stats = self.update(&list, budget);
        stats.changed |= pruned;
        stats
    }

    /// Brings these transcripts up to date, largest unread part first, in parallel.
    pub fn update(&self, list: &[Transcript], budget: Option<u64>) -> ScanStats {
        let mut work: Vec<(u64, &Transcript)> = {
            let entries = lock(&self.entries);
            list.iter()
                .map(|t| {
                    let offset = entries.get(&t.path).map_or(0, |e| e.state.offset);
                    (t.len.saturating_sub(offset), t)
                })
                .collect()
        };
        work.sort_by(|a, b| b.0.cmp(&a.0));
        let opened = AtomicU64::new(0);
        let bytes = AtomicU64::new(0);
        let partial = AtomicU64::new(0);
        let changed = AtomicBool::new(false);
        work.par_iter().for_each(|(_, t)| match self.update_one(t, budget) {
            Outcome::Unchanged => {}
            Outcome::Gone => changed.store(true, Ordering::Relaxed),
            Outcome::Updated {
                opened: o,
                bytes: b,
                partial: p,
                changed: c,
            } => {
                opened.fetch_add(o as u64, Ordering::Relaxed);
                bytes.fetch_add(b, Ordering::Relaxed);
                partial.fetch_add(p as u64, Ordering::Relaxed);
                if c {
                    changed.store(true, Ordering::Relaxed);
                }
            }
        });
        ScanStats {
            files: list.len(),
            opened: opened.into_inner() as usize,
            bytes_read: bytes.into_inner(),
            partial: partial.into_inner() as usize,
            changed: changed.into_inner(),
        }
    }

    fn update_one(&self, t: &Transcript, budget: Option<u64>) -> Outcome {
        let (mut st, old) = match lock(&self.entries).get(&t.path) {
            Some(e) => (e.state.clone(), e.session.clone()),
            None => (ParseState::default(), None),
        };
        let unchanged = st.len == t.len && st.mtime_ms == t.mtime_ms && st.len > 0;
        if unchanged && old.as_ref().is_some_and(|s| s.profile == t.profile) {
            return Outcome::Unchanged;
        }
        let mut opened = false;
        let mut bytes = 0;
        let mut at_end = true;
        let mut view = st.clone();
        // a last line without newline is not in the state: an unchanged file is opened only to read it
        if !(unchanged && st.offset == st.len) {
            if t.len < st.offset {
                st = ParseState::default(); // rewritten shorter: start over
            }
            let start = st.offset;
            let read = File::open(&t.path).and_then(|mut f| {
                f.seek(SeekFrom::Start(start))?;
                let r = parse::read_on(&mut f, &mut st, budget)?;
                Ok((r, f.stream_position()?))
            });
            match read {
                Ok((r, end)) => {
                    opened = true;
                    bytes = end.saturating_sub(start);
                    at_end = r.at_end;
                    view = r.view;
                    // the length read up to: if the file grew since it was listed, the next scan reads on
                    (st.len, st.mtime_ms) = if at_end { (end, t.mtime_ms) } else { (0, 0) };
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return if self.remove(&t.path) {
                        Outcome::Gone
                    } else {
                        Outcome::Unchanged
                    };
                }
                Err(e) => {
                    log::warn!("could not read a transcript: {e}");
                    return Outcome::Unchanged;
                }
            }
        }
        let session = parse::session(&t.path, &t.profile, &view, t.len, t.mtime_ms, !at_end);
        // only sessions with user messages are listed
        let changed = match (old.as_ref().filter(|o| o.count > 0), session.count > 0) {
            (None, listed) => listed,
            (Some(o), true) => !same(o, &session),
            (Some(_), false) => true,
        };
        let mut entries = lock(&self.entries);
        let e = entries.entry(t.path.clone()).or_insert_with(|| Entry {
            state: ParseState::default(),
            session: None,
        });
        if e.state != st {
            e.state = st;
            self.dirty.store(true, Ordering::Relaxed);
        }
        e.session = Some(session);
        Outcome::Updated {
            opened,
            bytes,
            partial: !at_end,
            changed,
        }
    }

    /// Forgets one transcript. True when it was listed (had user messages).
    pub fn remove(&self, path: &Path) -> bool {
        let removed = lock(&self.entries).remove(path);
        if removed.is_some() {
            self.dirty.store(true, Ordering::Relaxed);
        }
        removed.and_then(|e| e.session).is_some_and(|s| s.count > 0)
    }

    /// Forgets every read position, so the next scan reads every file again from the start. The sessions
    /// stay listed until then.
    pub fn reset(&self) {
        for e in lock(&self.entries).values_mut() {
            e.state = ParseState::default();
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Every session with at least one user message.
    pub fn sessions(&self) -> Vec<Session> {
        lock(&self.entries)
            .values()
            .filter_map(|e| e.session.as_ref())
            .filter(|s| s.count > 0)
            .cloned()
            .collect()
    }

    /// Calls `f` with every listed session, without copying them.
    pub fn for_each(&self, mut f: impl FnMut(&Session)) {
        for s in lock(&self.entries).values().filter_map(|e| e.session.as_ref()) {
            if s.count > 0 {
                f(s);
            }
        }
    }

    /// Writes the states to the cache file when they changed since the last save.
    pub fn save(&self) -> AppResult<()> {
        let Some(path) = &self.cache_path else { return Ok(()) };
        let _one = lock(&self.save_lock);
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let states: Vec<(PathBuf, ParseState)> = lock(&self.entries)
            .iter()
            .map(|(p, e)| (p.clone(), e.state.clone()))
            .collect();
        cache::save(path, states).inspect_err(|_| self.dirty.store(true, Ordering::Relaxed))
    }
}

/// Same visible content (the profile and path are fixed for one entry).
fn same(a: &Session, b: &Session) -> bool {
    a.count == b.count
        && a.modified == b.modified
        && a.size_kb == b.size_kb
        && a.partial == b.partial
        && a.label == b.label
        && a.full == b.full
        && a.cwd == b.cwd
        && a.profile == b.profile
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::time::{Duration, Instant};

    pub const ID: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    pub const ID2: &str = "1f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    pub fn user_line(text: &str, cwd: &str) -> String {
        serde_json::json!({"type":"user","cwd":cwd,"message":{"role":"user","content":text}}).to_string() + "\n"
    }

    /// `<home>/.claude-t/projects/<slug>/<id>.jsonl` with `content`; returns (profile, file).
    pub fn transcript(home: &Path, slug: &str, id: &str, content: &str) -> (PathBuf, PathBuf) {
        let profile = home.join(".claude-t");
        let dir = profile.join("projects").join(slug);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{id}.jsonl"));
        fs::write(&file, content).unwrap();
        (profile, file)
    }

    fn append(file: &Path, text: &str) {
        let mut f = fs::OpenOptions::new().append(true).open(file).unwrap();
        f.write_all(text.as_bytes()).unwrap();
        // the write time must differ even on file systems with coarse timestamps
        let later = fs::metadata(file).unwrap().modified().unwrap() + Duration::from_secs(2);
        f.set_modified(later).unwrap();
    }

    #[test]
    fn lists_only_uuid_transcripts_one_level_deep() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "C--code-app", ID, &user_line("hi", "C:/code/app"));
        let slug = profile.join("projects").join("C--code-app");
        fs::write(slug.join("--dangerously-skip-permissions.jsonl"), user_line("x", "/")).unwrap();
        fs::write(slug.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(slug.join(ID).join("subagents")).unwrap();
        fs::write(slug.join(ID).join("subagents").join(format!("{ID2}.jsonl")), "x").unwrap();
        let found = transcripts(&[profile]);
        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with(format!("{ID}.jsonl")));
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_transcripts_and_folders() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(home.path(), "a", ID, &user_line("hi", "/a"));
        let slug = file.parent().unwrap();
        std::os::unix::fs::symlink(&file, slug.join(format!("{ID2}.jsonl"))).unwrap();
        std::os::unix::fs::symlink(slug, profile.join("projects").join("linked")).unwrap();
        assert_eq!(transcripts(&[profile]).len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn skips_symlinked_transcripts() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(home.path(), "a", ID, &user_line("hi", "/a"));
        // creating symlinks needs developer mode or admin rights on Windows; skip when not allowed
        if std::os::windows::fs::symlink_file(&file, file.with_file_name(format!("{ID2}.jsonl"))).is_err() {
            return;
        }
        assert_eq!(transcripts(&[profile]).len(), 1);
    }

    #[test]
    fn unchanged_files_are_not_opened_again() {
        let home = tempfile::tempdir().unwrap();
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        transcript(home.path(), "b", ID2, &user_line("two", "/b"));
        let scanner = Scanner::new(None);
        let first = scanner.scan(std::slice::from_ref(&profile), None);
        assert_eq!((first.files, first.opened, first.changed), (2, 2, true));
        let second = scanner.scan(&[profile], None);
        assert_eq!((second.opened, second.bytes_read, second.changed), (0, 0, false));
        assert_eq!(scanner.sessions().len(), 2);
    }

    #[test]
    fn appended_lines_are_read_from_the_offset() {
        let home = tempfile::tempdir().unwrap();
        let first = user_line("one", "/a");
        let (profile, file) = transcript(home.path(), "a", ID, &first);
        let scanner = Scanner::new(None);
        scanner.scan(std::slice::from_ref(&profile), None);
        let second = user_line("two", "/a");
        append(&file, &second);
        let stats = scanner.scan(&[profile], None);
        assert_eq!(stats.bytes_read, second.len() as u64);
        assert!(stats.changed);
        let s = &scanner.sessions()[0];
        assert_eq!((s.count, s.label.as_str()), (2, "one"));
    }

    #[test]
    fn a_shorter_file_is_read_from_the_start() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(
            home.path(),
            "a",
            ID,
            &(user_line("one", "/a") + &user_line("two", "/a")),
        );
        let scanner = Scanner::new(None);
        scanner.scan(std::slice::from_ref(&profile), None);
        fs::write(&file, user_line("new", "/b")).unwrap();
        scanner.scan(&[profile], None);
        let s = &scanner.sessions()[0];
        assert_eq!((s.count, s.label.as_str(), s.cwd.as_deref()), (1, "new", Some("/b")));
    }

    #[test]
    fn deleted_and_empty_transcripts_are_not_listed() {
        let home = tempfile::tempdir().unwrap();
        let (profile, file) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        transcript(
            home.path(),
            "b",
            ID2,
            "{\"type\":\"summary\",\"summary\":\"no users\"}\n",
        );
        let scanner = Scanner::new(None);
        scanner.scan(std::slice::from_ref(&profile), None);
        assert_eq!(scanner.sessions().len(), 1);
        fs::remove_file(&file).unwrap();
        assert!(scanner.scan(&[profile], None).changed);
        assert!(scanner.sessions().is_empty());
    }

    #[test]
    fn a_budget_gives_partial_sessions_that_a_later_scan_completes() {
        let home = tempfile::tempdir().unwrap();
        let mut text = user_line("first", "/a");
        while text.len() < 3 * HEADER_BYTES as usize {
            text += &user_line("more", "/a");
        }
        let lines = text.lines().count() as u32;
        let (profile, _) = transcript(home.path(), "a", ID, &text);
        let scanner = Scanner::new(None);
        let a = scanner.scan(std::slice::from_ref(&profile), Some(HEADER_BYTES));
        assert_eq!(a.partial, 1);
        let s = scanner.sessions().remove(0);
        assert!(s.partial && s.count < lines && s.label == "first");
        let b = scanner.scan(&[profile], None);
        assert!(b.changed);
        let s = scanner.sessions().remove(0);
        assert!(!s.partial);
        assert_eq!(s.count, lines);
    }

    #[test]
    fn states_survive_a_restart_through_the_cache() {
        let home = tempfile::tempdir().unwrap();
        let cache_file = home.path().join("cache").join("sessions-cache.json");
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let scanner = Scanner::new(Some(cache_file.clone()));
        scanner.scan(std::slice::from_ref(&profile), None);
        scanner.save().unwrap();
        let warm = Scanner::new(Some(cache_file));
        let stats = warm.scan(&[profile], Some(HEADER_BYTES));
        assert_eq!((stats.opened, stats.changed), (0, true));
        assert_eq!(warm.sessions()[0].label, "one");
    }

    #[test]
    fn saves_from_several_threads_at_once_leave_a_readable_cache() {
        let home = tempfile::tempdir().unwrap();
        let cache_file = home.path().join("cache").join("sessions-cache.json");
        let (profile, _) = transcript(home.path(), "a", ID, &user_line("one", "/a"));
        let scanner = Scanner::new(Some(cache_file.clone()));
        scanner.scan(std::slice::from_ref(&profile), None);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    for _ in 0..20 {
                        scanner.dirty.store(true, Ordering::Relaxed);
                        scanner.save().unwrap();
                    }
                });
            }
        });
        let warm = Scanner::new(Some(cache_file));
        assert_eq!(warm.scan(&[profile], Some(HEADER_BYTES)).opened, 0);
    }

    /// Acceptance bench: a second scan of an unchanged 300 MB set takes under 50 ms (stat only).
    /// Writes 300 MB to a temp folder, so it runs only on request: `cargo test -- --ignored bench`.
    #[test]
    #[ignore]
    fn bench_second_scan_of_unchanged_300_mb() {
        let home = tempfile::tempdir().unwrap();
        let filler = user_line(&"x".repeat(4000), "/a");
        let per_file = 300 * (1 << 20) / 126;
        let mut profile = PathBuf::new();
        for i in 0..126 {
            let id = format!("{i:08x}-1b2c-4d5e-8f90-a1b2c3d4e5f6");
            let mut text = String::with_capacity(per_file + filler.len());
            while text.len() < per_file {
                text += &filler;
            }
            profile = transcript(home.path(), &format!("slug{}", i % 20), &id, &text).0;
        }
        let scanner = Scanner::new(None);
        let started = Instant::now();
        let cold = scanner.scan(std::slice::from_ref(&profile), None);
        println!("cold scan: {:?} for {} MB", started.elapsed(), cold.bytes_read >> 20);
        let started = Instant::now();
        let warm = scanner.scan(&[profile], None);
        let took = started.elapsed();
        println!("second scan: {took:?}");
        assert_eq!(warm.opened, 0);
        assert!(took < Duration::from_millis(50), "{took:?}");
    }
}
