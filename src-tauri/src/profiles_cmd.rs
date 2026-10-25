//! Profile commands of the profiles UI (WP6): create a new `~/.claude-<name>` profile and show a profile's
//! folder in Explorer or Finder. Discovery, names and emails are core (`core::profiles`).

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{paths, profiles};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use ts_rs::TS;

/// Longest profile name accepted (the folder name gets a `.claude-` prefix).
const MAX_NAME: usize = 64;

/// `create_profile` result.
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreatedProfile {
    /// The new profile's folder, as discovery spells it.
    pub dir: String,
    /// The home folder: the first session of a new profile starts there (it asks to log in).
    pub home: String,
}

/// Letters, numbers, `-` and `_` only (the Windows app's `^[\w-]+$`), so the name is a plain folder name.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME
        && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

/// Creates `<home>/.claude-<name>` (an existing profile folder is fine) and returns it. A `projects`
/// folder is created inside, so discovery lists the profile before its first login.
pub fn create_in(home: &Path, name: &str) -> AppResult<PathBuf> {
    let name = name.trim();
    if !valid_name(name) {
        return Err(AppError::InvalidInput(
            "That name can't be used\nUse letters, numbers, - or _ only.".into(),
        ));
    }
    let dir = home.join(format!(".claude-{name}"));
    // discovery does not follow links, and a file of that name cannot become a profile
    if let Ok(meta) = std::fs::symlink_metadata(&dir)
        && !meta.is_dir()
    {
        return Err(AppError::InvalidInput(format!(
            "{} already exists and is not a folder.",
            dir.display()
        )));
    }
    std::fs::create_dir_all(dir.join("projects"))?;
    Ok(dir)
}

// ---- commands ----

/// Creates the profile `~/.claude-<name>`, rediscovers profiles (emits `profiles-changed`) and returns it.
#[tauri::command]
pub async fn create_profile(app: AppHandle, name: String) -> AppResult<CreatedProfile> {
    blocking(move || {
        let home = paths::home()?;
        let created = create_in(&home, &name)?;
        profiles::refresh(&app)?;
        // the discovered spelling (on Windows and macOS an existing folder may differ in case)
        let dir = profiles::resolve_profile(&created.to_string_lossy())?;
        Ok(CreatedProfile {
            dir: dir.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
        })
    })
    .await
}

/// Opens a discovered profile's folder in Explorer or Finder.
#[tauri::command]
pub async fn open_profile_folder(app: AppHandle, dir: String) -> AppResult<()> {
    blocking(move || {
        let dir = profiles::resolve_profile(&dir)?;
        if !dir.is_dir() {
            return Err(AppError::NotFound(format!(
                "The profile folder does not exist yet:\n{}",
                dir.display()
            )));
        }
        app.opener()
            .open_path(dir.to_string_lossy(), None::<&str>)
            .map_err(|e| AppError::Internal(format!("could not open the profile folder: {e}")))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_names() {
        for good in ["work", "my-team_2", "Ünïcode", "a"] {
            assert!(valid_name(good), "{good}");
        }
        let long = "x".repeat(MAX_NAME + 1);
        for bad in ["", "a b", "../x", "a/b", "a\\b", "x.y", "C:", "a*", long.as_str()] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn creates_a_discoverable_profile() {
        let home = tempfile::tempdir().unwrap();
        let dir = create_in(home.path(), " test ").unwrap();
        assert_eq!(dir, home.path().join(".claude-test"));
        assert!(dir.join("projects").is_dir());
        let found = profiles::discover(home.path(), None);
        assert!(found.iter().any(|d| paths::same(d, &dir)));
        assert_eq!(profiles::name(&dir), "test");
        // creating it again is fine and keeps what is inside
        std::fs::write(dir.join("settings.json"), "{}").unwrap();
        assert_eq!(create_in(home.path(), "test").unwrap(), dir);
        assert!(dir.join("settings.json").is_file());
    }

    #[test]
    fn refuses_bad_names_and_files_in_the_way() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["", "..", "a/../../x", "name with space"] {
            assert!(
                matches!(create_in(home.path(), bad), Err(AppError::InvalidInput(_))),
                "{bad}"
            );
        }
        std::fs::write(home.path().join(".claude-file"), "x").unwrap();
        assert!(matches!(create_in(home.path(), "file"), Err(AppError::InvalidInput(_))));
        // nothing was created outside the home folder or for the refused names
        let entries: Vec<_> = std::fs::read_dir(home.path()).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
    }
}
