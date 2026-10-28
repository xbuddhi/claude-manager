//! Claude Code profiles: `~/.claude`, `$CLAUDE_CONFIG_DIR`, and every `~/.claude-*` folder that holds
//! sessions, a login or settings. This module is also the gate for any profile path coming from the
//! webview: `resolve_profile` accepts only a discovered profile.

use super::error::{AppError, AppResult, blocking, lock};
use super::events;
use super::paths;
use super::types::Profile;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// How long `discover_cached` reuses a discovery.
const DISCOVER_TTL: Duration = Duration::from_secs(2);

/// Files or folders that make a `~/.claude-*` folder a profile.
const MARKERS: &[&str] = &["projects", ".credentials.json", "settings.json", ".claude.json"];

/// Tells whether a profile folder holds usable credentials; `None` = unknown. Registered by the usage
/// feature (WP7), which knows where each OS keeps them; it must be quick or cache its answers.
pub type SignedInFn = dyn Fn(&Path) -> Option<bool> + Send + Sync;

/// Cached emails (reading `.claude.json` can mean megabytes). Managed as state by `core::init`.
#[derive(Default)]
pub struct Profiles {
    emails: Mutex<HashMap<String, Option<String>>>,
    signed_in: Mutex<Option<Arc<SignedInFn>>>,
}

impl Profiles {
    /// Forgets cached emails; the next `list` reads them again.
    pub fn invalidate(&self) {
        lock(&self.emails).clear();
        forget_discovered();
    }

    /// Installs the source of `Profile::signed_in` (see [`SignedInFn`]).
    pub fn set_signed_in(&self, f: impl Fn(&Path) -> Option<bool> + Send + Sync + 'static) {
        *lock(&self.signed_in) = Some(Arc::new(f));
    }

    /// Discovered profiles with names, emails and, when known, whether they are signed in.
    pub fn list(&self) -> AppResult<Vec<Profile>> {
        let home = paths::home()?;
        let config_dir = launch_config_dir();
        let dirs = discover(&home, config_dir.as_deref());
        remember(&DISCOVERED, &home, config_dir.as_deref(), &dirs);
        let emails: Vec<Option<String>> = {
            let mut cache = lock(&self.emails);
            dirs.iter()
                .map(|dir| {
                    let key = paths::key(&dir.to_string_lossy());
                    cache.entry(key).or_insert_with(|| email(dir, &home)).clone()
                })
                .collect()
        };
        // asked without any lock held: it may read files or the keychain
        let signed_in = lock(&self.signed_in).clone();
        Ok(dirs
            .iter()
            .zip(emails)
            .map(|(dir, email)| Profile {
                dir: dir.to_string_lossy().into_owned(),
                name: name(dir),
                email,
                signed_in: signed_in.as_ref().and_then(|f| f(dir)),
                is_default: is_default(dir, &home),
            })
            .collect())
    }
}

/// Rediscovers profiles (emails read again) and broadcasts `profiles-changed`. For anything that learns
/// the profiles changed: the refresh command, profile creation (WP6), the index watcher seeing a new
/// `~/.claude-*` folder (WP1). Blocking: call it off the UI thread.
pub fn refresh(app: &AppHandle) -> AppResult<Vec<Profile>> {
    let profiles = app.state::<Profiles>();
    profiles.invalidate();
    let list = profiles.list()?;
    app.emit(events::PROFILES_CHANGED, &list)?;
    Ok(list)
}

/// CLAUDE_CONFIG_DIR as this app was launched with (it is removed from children, never from us).
pub fn launch_config_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

pub fn default_dir(home: &Path) -> PathBuf {
    home.join(".claude")
}

pub fn is_default(dir: &Path, home: &Path) -> bool {
    paths::same(dir, &default_dir(home))
}

/// Profile folders under `home`, normalized, unique by `paths::key`, sorted. `~/.claude` is always
/// included (new sessions can start there before it exists); symlinked `~/.claude-*` entries are not
/// followed.
pub fn discover(home: &Path, config_dir_env: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![default_dir(home)];
    if let Some(env_dir) = config_dir_env {
        dirs.push(std::path::absolute(env_dir).unwrap_or_else(|_| env_dir.to_path_buf()));
    }
    if let Ok(entries) = std::fs::read_dir(home) {
        for entry in entries.flatten() {
            let is_candidate = entry.file_name().to_string_lossy().starts_with(".claude-");
            // file_type() does not follow symlinks
            let is_real_dir = entry.file_type().is_ok_and(|t| t.is_dir());
            if is_candidate && is_real_dir && MARKERS.iter().any(|m| entry.path().join(m).exists()) {
                dirs.push(entry.path());
            }
        }
    }
    let mut unique: Vec<(String, PathBuf)> = Vec::new();
    for dir in dirs {
        let normalized = PathBuf::from(paths::norm(&dir.to_string_lossy()));
        let key = paths::key(&normalized.to_string_lossy());
        if !unique.iter().any(|(k, _)| *k == key) {
            unique.push((key, normalized));
        }
    }
    unique.sort_by(|a, b| a.0.cmp(&b.0));
    unique.into_iter().map(|(_, dir)| dir).collect()
}

/// One discovery: when, for which home and `CLAUDE_CONFIG_DIR`, and what was found.
struct Discovered {
    at: Instant,
    home: PathBuf,
    config_dir: Option<PathBuf>,
    dirs: Vec<PathBuf>,
}

static DISCOVERED: Mutex<Option<Discovered>> = Mutex::new(None);

/// `discover`, reused for a short while: commands check every profile path they get against it, and
/// each discovery reads the home folder. `refresh` (anything that learns profiles changed) forgets it.
/// The index watcher keeps calling `discover` itself, so it always sees the folders as they are.
pub fn discover_cached(home: &Path, config_dir_env: Option<&Path>) -> Vec<PathBuf> {
    cached_in(&DISCOVERED, home, config_dir_env, DISCOVER_TTL)
}

fn cached_in(
    cache: &Mutex<Option<Discovered>>,
    home: &Path,
    config_dir_env: Option<&Path>,
    ttl: Duration,
) -> Vec<PathBuf> {
    if let Some(d) = lock(cache).as_ref()
        && d.at.elapsed() < ttl
        && d.home == home
        && d.config_dir.as_deref() == config_dir_env
    {
        return d.dirs.clone();
    }
    let dirs = discover(home, config_dir_env);
    remember(cache, home, config_dir_env, &dirs);
    dirs
}

fn remember(cache: &Mutex<Option<Discovered>>, home: &Path, config_dir_env: Option<&Path>, dirs: &[PathBuf]) {
    *lock(cache) = Some(Discovered {
        at: Instant::now(),
        home: home.to_path_buf(),
        config_dir: config_dir_env.map(Path::to_path_buf),
        dirs: dirs.to_vec(),
    });
}

/// Drops the discovery `discover_cached` reuses.
pub fn forget_discovered() {
    *lock(&DISCOVERED) = None;
}

/// "default" for `~/.claude`, else the folder name without a leading `.claude-` or `claude-`.
pub fn name(dir: &Path) -> String {
    let leaf = dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if leaf == ".claude" {
        return "default".into();
    }
    match leaf.strip_prefix(".claude-").or_else(|| leaf.strip_prefix("claude-")) {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => leaf,
    }
}

/// The signed-in account's email. The default profile keeps its account in `~/.claude.json`, any other
/// profile in `<dir>/.claude.json`.
pub fn email(dir: &Path, home: &Path) -> Option<String> {
    let file = if is_default(dir, home) {
        home.join(".claude.json")
    } else {
        dir.join(".claude.json")
    };
    let text = std::fs::read_to_string(file).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("oauthAccount")?.get("emailAddress")?.as_str().map(str::to_string));
    // a file Claude Code was writing at that moment can be cut short: find the field by hand
    parsed.or_else(|| email_by_scan(&text)).filter(|e| !e.is_empty())
}

fn email_by_scan(text: &str) -> Option<String> {
    let after = &text[text.find("\"emailAddress\"")? + "\"emailAddress\"".len()..];
    let value = after.trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    Some(value[..value.find('"')?].to_string())
}

/// Accepts `dir` only when it names a discovered profile, and returns that profile's folder.
/// Every command that receives a profile from the webview goes through this.
pub fn resolve_profile(dir: &str) -> AppResult<PathBuf> {
    let home = paths::home()?;
    resolve_among(dir, discover_cached(&home, launch_config_dir().as_deref()))
}

pub fn resolve_profile_in(dir: &str, home: &Path, config_dir_env: Option<&Path>) -> AppResult<PathBuf> {
    resolve_among(dir, discover(home, config_dir_env))
}

fn resolve_among(dir: &str, discovered: Vec<PathBuf>) -> AppResult<PathBuf> {
    let wanted = paths::key(dir);
    discovered
        .into_iter()
        .find(|d| paths::key(&d.to_string_lossy()) == wanted)
        .ok_or_else(|| AppError::InvalidInput(format!("Unknown profile: {dir}")))
}

/// A session id as Claude Code writes it: a lowercase or uppercase hyphenated UUID. Transcript names
/// that are not UUIDs are ignored everywhere, so a crafted file name can never become a CLI flag.
pub fn is_session_id(s: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == GROUPS.len()
        && parts
            .iter()
            .zip(GROUPS)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The transcript `<profile>/projects/<slug>/<id>.jsonl`, if it exists (one folder level deep only).
pub fn find_transcript(profile: &Path, session_id: &str) -> Option<PathBuf> {
    if !is_session_id(session_id) {
        return None;
    }
    let file_name = format!("{session_id}.jsonl");
    std::fs::read_dir(profile.join("projects"))
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path().join(&file_name))
        .find(|p| p.is_file())
}

// ---- commands ----

#[tauri::command]
pub async fn list_profiles(app: AppHandle) -> AppResult<Vec<Profile>> {
    blocking(move || app.state::<Profiles>().list()).await
}

/// Drops cached emails, rediscovers, and broadcasts `profiles-changed`.
#[tauri::command]
pub async fn refresh_profiles(app: AppHandle) -> AppResult<Vec<Profile>> {
    blocking(move || refresh(&app)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn home_with(profiles: &[(&str, &str)]) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        for (dir, marker) in profiles {
            let d = home.path().join(dir);
            fs::create_dir_all(&d).unwrap();
            if marker.contains('.') {
                fs::write(d.join(marker), "{}").unwrap();
            } else if !marker.is_empty() {
                fs::create_dir(d.join(marker)).unwrap();
            }
        }
        home
    }

    #[test]
    fn discovers_marked_profiles_and_always_the_default() {
        let home = home_with(&[
            (".claude-work", "projects"),
            (".claude-personal", ".credentials.json"),
            (".claude-team", "settings.json"),
            (".claude-empty", ""),
            (".claudex", "projects"),
        ]);
        fs::write(home.path().join(".claude-file"), "not a dir").unwrap();
        let found: Vec<String> = discover(home.path(), None).iter().map(|d| name(d)).collect();
        assert_eq!(found, ["default", "personal", "team", "work"]);
    }

    #[test]
    fn includes_config_dir_env_once() {
        let home = home_with(&[(".claude-work", "projects")]);
        let elsewhere = tempfile::tempdir().unwrap();
        let with_env = discover(home.path(), Some(elsewhere.path()));
        assert_eq!(with_env.len(), 3);
        // the same folder spelled with a trailing separator is not listed twice
        let spelled = format!(
            "{}{}",
            home.path().join(".claude-work").display(),
            std::path::MAIN_SEPARATOR
        );
        assert_eq!(discover(home.path(), Some(Path::new(&spelled))).len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinked_profiles() {
        let home = home_with(&[]);
        let target = tempfile::tempdir().unwrap();
        fs::create_dir(target.path().join("projects")).unwrap();
        std::os::unix::fs::symlink(target.path(), home.path().join(".claude-link")).unwrap();
        assert_eq!(discover(home.path(), None).len(), 1);
    }

    #[test]
    fn names_profiles() {
        assert_eq!(name(Path::new("/h/.claude")), "default");
        assert_eq!(name(Path::new("/h/.claude-work")), "work");
        assert_eq!(name(Path::new("/h/claude-team")), "team");
        assert_eq!(name(Path::new("/elsewhere/configs")), "configs");
    }

    #[test]
    fn reads_email_from_the_right_file() {
        let home = home_with(&[(".claude", ""), (".claude-work", "projects")]);
        let h = home.path();
        fs::write(
            h.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"me@home.test"}}"#,
        )
        .unwrap();
        fs::write(
            h.join(".claude-work/.claude.json"),
            r#"{"x":1, "oauthAccount": {"emailAddress" : "me@work.test", "#,
        )
        .unwrap();
        assert_eq!(email(&h.join(".claude"), h).as_deref(), Some("me@home.test"));
        assert_eq!(email(&h.join(".claude-work"), h).as_deref(), Some("me@work.test"));
        assert_eq!(email(&h.join(".claude-none"), h), None);
    }

    #[test]
    fn recognizes_session_ids() {
        assert!(is_session_id("0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6"));
        assert!(is_session_id("0F8C2A4E-1B2C-4D5E-8F90-A1B2C3D4E5F6"));
        for bad in [
            "",
            "--dangerously-skip-permissions",
            "0f8c2a4e1b2c4d5e8f90a1b2c3d4e5f6",
            "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5fg",
        ] {
            assert!(!is_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn finds_transcripts_one_level_deep() {
        let home = home_with(&[(".claude-work", "projects")]);
        let profile = home.path().join(".claude-work");
        let id = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
        let slug = profile.join("projects").join("C--code-app");
        fs::create_dir_all(slug.join("deeper")).unwrap();
        fs::write(slug.join("deeper").join(format!("{id}.jsonl")), "").unwrap();
        assert_eq!(find_transcript(&profile, id), None);
        fs::write(slug.join(format!("{id}.jsonl")), "").unwrap();
        assert_eq!(find_transcript(&profile, id), Some(slug.join(format!("{id}.jsonl"))));
        assert_eq!(find_transcript(&profile, "../x"), None);
    }

    #[test]
    fn resolves_only_discovered_profiles() {
        let home = home_with(&[(".claude-work", "projects"), (".claude-x", "")]);
        let h = home.path();
        let work = h.join(".claude-work");
        assert_eq!(resolve_profile_in(&work.to_string_lossy(), h, None).unwrap(), work);
        let spelled = format!("{}{}", work.display(), std::path::MAIN_SEPARATOR);
        assert_eq!(resolve_profile_in(&spelled, h, None).unwrap(), work);
        for bad in [h.join(".claude-x"), h.join("evil"), h.to_path_buf()] {
            assert!(matches!(
                resolve_profile_in(&bad.to_string_lossy(), h, None),
                Err(AppError::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn reuses_a_discovery_for_a_short_while() {
        let cache = Mutex::new(None);
        let home = home_with(&[]);
        let h = home.path();
        let ttl = Duration::from_secs(60);
        assert_eq!(cached_in(&cache, h, None, ttl).len(), 1);
        fs::create_dir_all(h.join(".claude-new").join("projects")).unwrap();
        assert_eq!(cached_in(&cache, h, None, ttl).len(), 1);
        // another CLAUDE_CONFIG_DIR or home is discovered again
        let elsewhere = tempfile::tempdir().unwrap();
        assert_eq!(cached_in(&cache, h, Some(elsewhere.path()), ttl).len(), 3);
        let other = home_with(&[]);
        assert_eq!(cached_in(&cache, other.path(), None, ttl).len(), 1);
        assert_eq!(cached_in(&cache, h, None, Duration::ZERO).len(), 2);
        *lock(&cache) = None;
        assert_eq!(cached_in(&cache, h, None, ttl), discover(h, None));
    }
}
