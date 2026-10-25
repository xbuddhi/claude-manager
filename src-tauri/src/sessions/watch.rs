//! Watches every profile's `projects` folder (300 ms debounce) and re-reads only the transcripts that
//! changed. A profile without `projects` yet is watched itself until the folder appears. On Windows the
//! home folder is watched too, so a new `~/.claude-*` profile shows up (on macOS FSEvents would deliver
//! every change under the home folder for that, so new profiles appear on F5 or a restart there).

use super::scan::is_transcript_name;
use super::{Index, current_profiles, locate, notify};
use crate::core::{paths, profiles};
use notify_debouncer_full::notify::event::ModifyKind;
use notify_debouncer_full::notify::{self, Event, EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Sender, channel};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const DEBOUNCE: Duration = Duration::from_millis(300);

enum Msg {
    Fs(DebounceEventResult),
    Resync,
}

/// Handle to the watcher thread.
pub struct Watcher {
    tx: Sender<Msg>,
}

impl Watcher {
    /// The profile set may have changed: watch the right folders and pick up their sessions.
    pub fn resync(&self) {
        let _ = self.tx.send(Msg::Resync);
    }
}

pub fn start(app: AppHandle) -> Watcher {
    let (tx, rx) = channel();
    let fs_tx = tx.clone();
    let spawned = std::thread::Builder::new().name("session-watch".into()).spawn(move || {
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            move |r| {
                let _ = fs_tx.send(Msg::Fs(r));
            },
            NoCache,
            notify::Config::default(),
        );
        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => {
                log::error!("no file watcher, the session list updates on F5 only: {e}");
                return;
            }
        };
        let home = paths::home().ok();
        let mut profiles = current_profiles();
        let mut watched = HashMap::new();
        sync(&mut debouncer, &mut watched, home.as_deref(), &profiles);
        let index = app.state::<Index>();
        let changed = |g| notify(&app, g);
        for msg in rx {
            let plan = match msg {
                Msg::Resync => Plan {
                    resync: true,
                    ..Plan::default()
                },
                Msg::Fs(Ok(events)) => {
                    let events: Vec<Event> = events.into_iter().map(|e| e.event).collect();
                    classify(&events, home.as_deref(), &profiles)
                }
                Msg::Fs(Err(errors)) => {
                    for e in errors {
                        log::warn!("file watcher: {e}");
                    }
                    Plan {
                        rescan: true,
                        ..Plan::default()
                    }
                }
            };
            if plan.resync {
                profiles = current_profiles();
                sync(&mut debouncer, &mut watched, home.as_deref(), &profiles);
            }
            if plan.resync || plan.rescan {
                index.rescan(&profiles, changed);
            } else if !plan.paths.is_empty() {
                index.update_paths(&profiles, &plan.paths, changed);
            }
            // a `~/.claude-*` folder came or went: tell everyone when the profile set really changed
            if plan.profiles
                && current_profiles() != profiles
                && let Err(e) = profiles::refresh(&app)
            {
                log::warn!("could not refresh profiles: {e}");
            }
        }
    });
    if let Err(e) = spawned {
        log::error!("could not start the file watcher: {e}");
    }
    Watcher { tx }
}

/// What a batch of file events asks for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    /// Transcripts to re-read (changed, created or deleted).
    pub paths: Vec<PathBuf>,
    /// A transcript folder came or went, or events were lost: stat every transcript.
    pub rescan: bool,
    /// A `projects` folder came or went: watch again.
    pub resync: bool,
    /// Something named `.claude-*` changed in the home folder.
    pub profiles: bool,
}

pub fn classify(events: &[Event], home: Option<&Path>, profiles: &[PathBuf]) -> Plan {
    let mut plan = Plan::default();
    let is_profile = |p: &Path| profiles.iter().any(|q| paths::same(p, q));
    for event in events {
        if event.need_rescan() {
            plan.rescan = true;
        }
        // folders only matter when they appear, go or are renamed
        let structural = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
        );
        for path in &event.paths {
            let parent = path.parent();
            let name = path.file_name().map(|n| n.to_string_lossy());
            if is_transcript_name(path) && locate(path, profiles).is_some() {
                if !plan.paths.contains(path) {
                    plan.paths.push(path.clone());
                }
            } else if home.is_some_and(|h| parent.is_some_and(|p| paths::same(p, h)))
                && name.as_deref().is_some_and(|n| n.starts_with(".claude-"))
            {
                plan.profiles = true;
            } else if name.as_deref() == Some("projects") && parent.is_some_and(is_profile) {
                plan.resync |= structural;
            } else if structural
                && parent.is_some_and(|p| {
                    p.file_name().is_some_and(|n| n == "projects") && p.parent().is_some_and(is_profile)
                })
            {
                plan.rescan = true; // a project folder was added, removed or renamed
            }
        }
    }
    plan
}

/// Watches each profile's `projects` (or the profile itself while it has none), and the home folder on
/// Windows; stops watching what is no longer wanted.
fn sync(
    debouncer: &mut Debouncer<RecommendedWatcher, NoCache>,
    watched: &mut HashMap<PathBuf, RecursiveMode>,
    home: Option<&Path>,
    profiles: &[PathBuf],
) {
    let mut wanted: HashMap<PathBuf, RecursiveMode> = HashMap::new();
    if cfg!(windows)
        && let Some(home) = home
    {
        wanted.insert(home.to_path_buf(), RecursiveMode::NonRecursive);
    }
    for profile in profiles {
        let projects = profile.join("projects");
        if std::fs::symlink_metadata(&projects).is_ok_and(|m| m.is_dir()) {
            wanted.insert(projects, RecursiveMode::Recursive);
        } else if profile.is_dir() {
            wanted.insert(profile.clone(), RecursiveMode::NonRecursive);
        }
    }
    watched.retain(|path, mode| {
        if wanted.get(path) == Some(mode) {
            return true;
        }
        if let Err(e) = debouncer.unwatch(path.as_path()) {
            log::debug!("unwatch {}: {e}", path.display());
        }
        false
    });
    for (path, mode) in wanted {
        if watched.contains_key(&path) {
            continue;
        }
        match debouncer.watch(&path, mode) {
            Ok(()) => {
                watched.insert(path, mode);
            }
            Err(e) => log::warn!("could not watch {}: {e}", path.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, DataChange, RemoveKind};

    const ID: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    fn ev(kind: EventKind, path: PathBuf) -> Event {
        Event::new(kind).add_path(path)
    }

    #[test]
    fn sorts_events_into_reads_rescans_and_resyncs() {
        let home = PathBuf::from(if cfg!(windows) { r"C:\Users\me" } else { "/Users/me" });
        let work = home.join(".claude-work");
        let profiles = vec![home.join(".claude"), work.clone()];
        let file = work.join("projects").join("C--code-app").join(format!("{ID}.jsonl"));
        let write = EventKind::Modify(ModifyKind::Data(DataChange::Any));
        let classify = |events: &[Event]| classify(events, Some(&home), &profiles);

        let plan = classify(&[ev(write, file.clone()), ev(write, file.clone())]);
        assert_eq!(plan.paths, std::slice::from_ref(&file));
        assert!(!plan.rescan && !plan.resync && !plan.profiles);

        // subagents, memory files, other folders and non-UUID names are ignored
        let ignored = [
            work.join("projects")
                .join("C--code-app")
                .join(ID)
                .join("subagents")
                .join(format!("{ID}.jsonl")),
            work.join("projects")
                .join("C--code-app")
                .join("memory")
                .join("MEMORY.md"),
            work.join("projects").join("C--code-app").join("notes.jsonl"),
            home.join("elsewhere")
                .join("projects")
                .join("x")
                .join(format!("{ID}.jsonl")),
            home.join(".claude.json"),
        ];
        for path in ignored {
            assert_eq!(
                classify(&[ev(write, path.clone())]),
                Plan::default(),
                "{}",
                path.display()
            );
        }

        let slug = work.join("projects").join("C--code-app");
        assert!(classify(&[ev(EventKind::Remove(RemoveKind::Folder), slug.clone())]).rescan);
        assert!(
            !classify(&[ev(write, slug)]).rescan,
            "a folder's own write time does not matter"
        );
        assert!(
            classify(&[ev(
                EventKind::Create(CreateKind::Folder),
                home.join(".claude").join("projects")
            )])
            .resync
        );
        assert!(classify(&[ev(EventKind::Create(CreateKind::Folder), home.join(".claude-new"))]).profiles);
        let lost = Event::new(EventKind::Other).set_flag(notify::event::Flag::Rescan);
        assert!(classify(&[lost]).rescan);
    }
}
