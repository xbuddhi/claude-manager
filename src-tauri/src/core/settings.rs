//! Settings persistence: `<app config dir>/settings.json`, owned by Rust.
//!
//! - A missing file is created on first run from the Windows app's `%APPDATA%\ClaudeManager\settings.json`
//!   when that exists (read only; the old file is never changed).
//! - Reading is lenient: a damaged file gives defaults, and a key with a bad value falls back to its
//!   default without losing the others. Keys this version does not know are kept and written back.
//! - Updates are validated as a whole, then saved atomically (temp file + rename) after 200 ms of quiet.

use super::error::{AppError, AppResult, lock};
use super::fsio::write_atomic;
use super::lifecycle::{self, ShutdownHook};
use super::types::Settings;
use super::{env, events, paths};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{App, AppHandle, Emitter, Manager, State};

const FILE_NAME: &str = "settings.json";
const SAVE_DELAY: Duration = Duration::from_millis(200);

pub struct SettingsStore {
    inner: Arc<Inner>,
    save_tx: Mutex<Sender<()>>,
}

struct Inner {
    path: PathBuf,
    current: Mutex<Settings>,
    /// Serializes file writes between the debounce thread and `flush`.
    write_lock: Mutex<()>,
}

impl SettingsStore {
    /// Loads `path`, importing `legacy` first when `path` does not exist yet.
    pub fn open(path: PathBuf, legacy: Option<&Path>) -> Self {
        let imported = !path.exists() && legacy.is_some_and(Path::is_file);
        let settings = match (imported, legacy) {
            (true, Some(old)) => {
                log::info!("importing settings from {}", old.display());
                read_file(old)
            }
            _ => read_file(&path),
        };
        let inner = Arc::new(Inner {
            path,
            current: Mutex::new(settings),
            write_lock: Mutex::new(()),
        });
        let (save_tx, save_rx) = mpsc::channel::<()>();
        let worker = inner.clone();
        let spawned = std::thread::Builder::new().name("settings-save".into()).spawn(move || {
            // one save per burst of updates: wait until SAVE_DELAY passes without another one
            while save_rx.recv().is_ok() {
                loop {
                    match save_rx.recv_timeout(SAVE_DELAY) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
                if let Err(e) = worker.save() {
                    log::error!("could not save settings: {e}");
                }
            }
        });
        if let Err(e) = spawned {
            log::error!("could not start the settings writer; changes are saved on exit only: {e}");
        }
        let store = Self {
            inner,
            save_tx: Mutex::new(save_tx),
        };
        if imported && let Err(e) = store.flush() {
            log::error!("could not save imported settings: {e}");
        }
        store
    }

    pub fn get(&self) -> Settings {
        lock(&self.inner.current).clone()
    }

    /// Applies a partial update: each top-level key in `patch` replaces the current value. The result
    /// must be valid as a whole, otherwise nothing changes.
    pub fn update(&self, patch: Value) -> AppResult<Settings> {
        let Value::Object(patch) = patch else {
            return Err(AppError::InvalidInput("settings update must be an object".into()));
        };
        let sets_claude_path = patch.contains_key("claudePath");
        let mut current = lock(&self.inner.current);
        let mut merged = to_map(&current);
        merged.extend(patch);
        let next: Settings = serde_json::from_value(Value::Object(merged))
            .map_err(|e| AppError::InvalidInput(format!("invalid settings: {e}")))?;
        let next = sanitize(next);
        // the webview can set this path and terminals then run it: it must name claude itself and exist.
        // Checked only when this update sets it, so a bad saved path never blocks other changes.
        if sets_claude_path
            && let Some(p) = &next.claude_path
            && !env::check_claude_override(p)?.is_file()
        {
            return Err(AppError::NotFound(format!("There is no file at\n{p}")));
        }
        *current = next;
        let snapshot = current.clone();
        drop(current);
        self.schedule_save();
        Ok(snapshot)
    }

    /// Changes settings from Rust code.
    pub fn modify(&self, f: impl FnOnce(&mut Settings)) -> Settings {
        let mut current = lock(&self.inner.current);
        f(&mut current);
        *current = sanitize(current.clone());
        let snapshot = current.clone();
        drop(current);
        self.schedule_save();
        snapshot
    }

    /// Writes the current settings now.
    pub fn flush(&self) -> AppResult<()> {
        self.inner.save()
    }

    fn schedule_save(&self) {
        if lock(&self.save_tx).send(()).is_err() {
            // writer thread is gone: save right away instead of losing the change
            if let Err(e) = self.flush() {
                log::error!("could not save settings: {e}");
            }
        }
    }
}

impl Inner {
    fn save(&self) -> AppResult<()> {
        let _write = lock(&self.write_lock);
        let json = serde_json::to_string_pretty(&*lock(&self.current))
            .map_err(|e| AppError::Internal(format!("could not serialize settings: {e}")))?;
        write_atomic(&self.path, json.as_bytes())
    }
}

/// Reads settings leniently (see the module docs). Never fails.
pub fn read_file(path: &Path) -> Settings {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(e) => {
            log::warn!("could not read {}: {e}; using defaults", path.display());
            return Settings::default();
        }
    };
    // Windows PowerShell 5 wrote UTF-8 with a BOM
    match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
        Ok(value) => from_value_lenient(value),
        Err(e) => {
            log::warn!("{} is not valid JSON ({e}); using defaults", path.display());
            Settings::default()
        }
    }
}

/// Starts from defaults and takes each key of `value` that keeps the whole valid.
pub fn from_value_lenient(value: Value) -> Settings {
    let Value::Object(map) = value else {
        log::warn!("settings file does not hold an object; using defaults");
        return Settings::default();
    };
    let mut accepted = to_map(&Settings::default());
    for (key, val) in map {
        let mut trial = accepted.clone();
        trial.insert(key.clone(), val);
        if serde_json::from_value::<Settings>(Value::Object(trial.clone())).is_ok() {
            accepted = trial;
        } else {
            log::warn!("settings: ignoring invalid value for '{key}'");
        }
    }
    let mut settings = sanitize(serde_json::from_value(Value::Object(accepted)).unwrap_or_default());
    if let Some(p) = &settings.claude_path
        && let Err(e) = env::check_claude_override(p)
    {
        log::warn!("settings: ignoring the Claude path: {e}");
        settings.claude_path = None;
    }
    settings
}

fn to_map(settings: &Settings) -> Map<String, Value> {
    match serde_json::to_value(settings) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Repairs values that parse but make no sense, the same way the Windows app did on load.
fn sanitize(mut s: Settings) -> Settings {
    s.claude_path = s.claude_path.filter(|p| !p.trim().is_empty());
    s.pinned.retain(|p| !p.trim().is_empty());
    s.hidden.retain(|p| !p.trim().is_empty());
    s.archived.retain(|id| !id.trim().is_empty());
    for g in &mut s.groups {
        g.folders.retain(|f| !f.trim().is_empty());
    }
    s
}

/// The Windows app's settings file, if this platform had one.
fn legacy_path() -> Option<PathBuf> {
    if cfg!(windows) {
        dirs::config_dir().map(|d| d.join("ClaudeManager").join(FILE_NAME))
    } else {
        None
    }
}

struct FlushOnExit(AppHandle);

impl ShutdownHook for FlushOnExit {
    fn shutdown(&self) {
        if let Err(e) = self.0.state::<SettingsStore>().flush() {
            log::error!("could not save settings on exit: {e}");
        }
    }
}

pub fn init(app: &mut App) -> AppResult<()> {
    let path = paths::app_config_dir(app.handle())?.join(FILE_NAME);
    app.manage(SettingsStore::open(path, legacy_path().as_deref()));
    lifecycle::register(app.handle(), FlushOnExit(app.handle().clone()));
    Ok(())
}

/// Current settings, for Rust features.
pub fn get(app: &AppHandle) -> Settings {
    app.state::<SettingsStore>().get()
}

/// Changes settings from Rust and broadcasts `settings-changed`.
pub fn modify(app: &AppHandle, f: impl FnOnce(&mut Settings)) -> AppResult<Settings> {
    let next = app.state::<SettingsStore>().modify(f);
    app.emit(events::SETTINGS_CHANGED, &next)?;
    Ok(next)
}

// ---- commands ----

#[tauri::command]
pub async fn get_settings(store: State<'_, SettingsStore>) -> AppResult<Settings> {
    Ok(store.get())
}

/// Merges `patch` (top-level keys replace current values), saves, and broadcasts `settings-changed`.
#[tauri::command]
pub async fn update_settings(app: AppHandle, store: State<'_, SettingsStore>, patch: Value) -> AppResult<Settings> {
    let next = store.update(patch)?;
    app.emit(events::SETTINGS_CHANGED, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::types::{Group, OpenIn};
    use serde_json::json;
    use std::fs;

    fn saved(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn missing_or_bad_json_gives_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert_eq!(SettingsStore::open(path.clone(), None).get(), Settings::default());
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(SettingsStore::open(path.clone(), None).get(), Settings::default());
        fs::write(&path, "[1, 2]").unwrap();
        assert_eq!(SettingsStore::open(path, None).get(), Settings::default());
    }

    #[test]
    fn one_bad_value_does_not_lose_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(
            &path,
            r#"{"openIn":"sideways","showPicker":"yes","pinned":["C:/a",""],"notify":false}"#,
        )
        .unwrap();
        let s = SettingsStore::open(path, None).get();
        assert_eq!(s.open_in, OpenIn::External);
        assert!(s.show_picker);
        assert_eq!(s.pinned, ["C:/a"]);
        assert!(!s.notify);
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{"futureKey":{"x":1},"scrollback":9000}"#).unwrap();
        let store = SettingsStore::open(path.clone(), None);
        store.update(json!({ "sidebarWidth": 300 })).unwrap();
        store.flush().unwrap();
        let v = saved(&path);
        assert_eq!(v["futureKey"], json!({ "x": 1 }));
        assert_eq!(v["scrollback"], json!(9000));
        assert_eq!(v["sidebarWidth"], json!(300));
        assert_eq!(
            SettingsStore::open(path, None).get().extra["futureKey"],
            json!({ "x": 1 })
        );
    }

    #[test]
    fn invalid_update_is_rejected_whole() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join(FILE_NAME), None);
        let err = store.update(json!({ "notify": false, "openIn": 3 })).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(store.get().notify);
        assert!(store.update(json!(["not", "an", "object"])).is_err());
        let next = store.update(json!({ "openIn": "embed", "claudePath": null })).unwrap();
        assert_eq!(next.open_in, OpenIn::Embed);
    }

    #[test]
    fn claude_path_must_name_claude() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::open(dir.path().join(FILE_NAME), None);
        let exe = if cfg!(windows) { "claude.exe" } else { "claude" };
        let good = dir.path().join("bin").join(exe).to_string_lossy().into_owned();
        // it must exist when the webview saves it
        assert!(matches!(
            store.update(json!({ "claudePath": good })),
            Err(AppError::NotFound(_))
        ));
        fs::create_dir_all(dir.path().join("bin")).unwrap();
        fs::write(&good, b"").unwrap();
        assert_eq!(
            store
                .update(json!({ "claudePath": good }))
                .unwrap()
                .claude_path
                .as_deref(),
            Some(good.as_str())
        );
        let calc = dir.path().join("calc.exe").to_string_lossy().into_owned();
        for bad in [calc.as_str(), exe, "bin/claude"] {
            assert!(
                matches!(
                    store.update(json!({ "claudePath": bad })),
                    Err(AppError::InvalidInput(_))
                ),
                "{bad}"
            );
        }
        assert_eq!(store.get().claude_path.as_deref(), Some(good.as_str()));
        assert_eq!(store.update(json!({ "claudePath": "  " })).unwrap().claude_path, None);
    }

    #[test]
    fn a_bad_saved_claude_path_is_dropped_and_never_blocks_other_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, r#"{"claudePath":"bin/not-claude","sidebarWidth":250}"#).unwrap();
        let store = SettingsStore::open(path, None);
        assert_eq!(store.get().claude_path, None);
        assert_eq!(store.get().sidebar_width, 250);
        // a bad value set from Rust code does not block updates of other keys either
        store.modify(|s| s.claude_path = Some("relative/claude".into()));
        assert_eq!(store.update(json!({ "sidebarWidth": 300 })).unwrap().sidebar_width, 300);
    }

    #[test]
    fn updates_are_saved_after_the_debounce() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        let store = SettingsStore::open(path.clone(), None);
        store.update(json!({ "notify": false })).unwrap();
        store.modify(|s| s.pinned.push("/p".into()));
        let start = std::time::Instant::now();
        while !path.exists() && start.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let v = saved(&path);
        assert_eq!(v["notify"], json!(false));
        assert_eq!(v["pinned"], json!(["/p"]));
        assert!(!dir.path().join("settings.json.tmp").exists());
    }

    #[test]
    fn imports_the_legacy_file_once_without_touching_it() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("legacy.json");
        // shape written by ClaudeManager.ps1 (ConvertTo-Json), with a BOM
        let legacy_text = "\u{feff}{\"pinned\":[\"C:\\\\code\\\\app\"],\"account\":\"C:\\\\Users\\\\me\\\\.claude-work\",\
            \"openIn\":\"embed\",\"showPicker\":false,\"lastProfile\":\"all\",\
            \"groups\":[{\"name\":\"Work\",\"folders\":[\"C:\\\\code\\\\app\",\"\"],\"collapsed\":true}],\
            \"ungroupedCollapsed\":true,\"showUsage\":false,\"notify\":true,\"bgTerms\":[{\"pid\":1}]}";
        fs::write(&legacy, legacy_text).unwrap();
        let path = dir.path().join("new").join(FILE_NAME);

        let s = SettingsStore::open(path.clone(), Some(&legacy)).get();
        assert_eq!(s.pinned, [r"C:\code\app"]);
        assert_eq!(s.account.as_deref(), Some(r"C:\Users\me\.claude-work"));
        assert_eq!(s.open_in, OpenIn::Embed);
        assert!(!s.show_picker);
        assert_eq!(s.last_profile.as_deref(), Some("all"));
        assert_eq!(
            s.groups,
            [Group {
                name: "Work".into(),
                folders: vec![r"C:\code\app".into()],
                collapsed: true
            }]
        );
        assert!(s.ungrouped_collapsed);
        assert!(!s.show_usage);
        assert_eq!(s.bg_terms, [json!({ "pid": 1 })]);
        assert_eq!(s.sidebar_width, 340);
        assert!(path.is_file(), "imported settings are saved right away");
        assert_eq!(fs::read_to_string(&legacy).unwrap(), legacy_text);

        // once the new file exists, the legacy file is ignored
        fs::write(&legacy, r#"{"pinned":["other"]}"#).unwrap();
        assert_eq!(SettingsStore::open(path, Some(&legacy)).get().pinned, [r"C:\code\app"]);
    }

    #[test]
    fn real_legacy_file_imports_if_present() {
        // read-only check against this machine's Windows app settings, copied to a temp folder first
        let Some(real) = legacy_path().filter(|p| p.is_file()) else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let copy = dir.path().join("legacy.json");
        fs::copy(&real, &copy).unwrap();
        let value: Value =
            serde_json::from_str(fs::read_to_string(&copy).unwrap().trim_start_matches('\u{feff}')).unwrap();
        let s = SettingsStore::open(dir.path().join("new.json"), Some(&copy)).get();
        if let Some(pinned) = value.get("pinned").and_then(Value::as_array) {
            assert_eq!(
                s.pinned.len(),
                pinned
                    .iter()
                    .filter(|p| p.as_str().is_some_and(|p| !p.trim().is_empty()))
                    .count()
            );
        }
        if let Some(groups) = value.get("groups").and_then(Value::as_array) {
            assert_eq!(s.groups.len(), groups.len());
        }
    }
}
