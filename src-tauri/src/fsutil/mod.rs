//! Small file-system questions from the sidebar (WP4): is a pinned or grouped folder still there, and is a
//! path dropped on the window a folder. Read-only: nothing here creates, changes or opens anything.

use crate::core::error::{AppError, AppResult, blocking};
use serde::Serialize;
use std::path::Path;
use ts_rs::TS;

/// Most paths one call may ask about (a drop or the sidebar's pinned and grouped folders).
const MAX_PATHS: usize = 1000;

/// What a path names on disk.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PathKind {
    Dir,
    File,
    /// Not there, not reachable, or not an absolute path.
    Missing,
}

/// The kind of one path. Relative paths are never resolved (against the app's own working folder).
pub fn kind_of(path: &str) -> PathKind {
    let p = Path::new(path);
    if path.trim().is_empty() || !p.is_absolute() {
        return PathKind::Missing;
    }
    match std::fs::metadata(p) {
        Ok(m) if m.is_dir() => PathKind::Dir,
        Ok(_) => PathKind::File,
        Err(_) => PathKind::Missing,
    }
}

// ---- commands ----

/// The kind of each path, in the same order.
#[tauri::command]
pub async fn path_kinds(paths: Vec<String>) -> AppResult<Vec<PathKind>> {
    if paths.len() > MAX_PATHS {
        return Err(AppError::InvalidInput(format!(
            "Too many paths at once ({}; at most {MAX_PATHS}).",
            paths.len()
        )));
    }
    blocking(move || Ok(paths.iter().map(|p| kind_of(p)).collect())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_folders_files_and_missing_paths_apart() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let d = dir.path().to_string_lossy().to_string();
        assert_eq!(kind_of(&d), PathKind::Dir);
        // a trailing separator still names the folder
        assert_eq!(kind_of(&format!("{d}{}", std::path::MAIN_SEPARATOR)), PathKind::Dir);
        assert_eq!(kind_of(&file.to_string_lossy()), PathKind::File);
        assert_eq!(kind_of(&dir.path().join("gone").to_string_lossy()), PathKind::Missing);
    }

    #[test]
    fn never_resolves_relative_or_empty_paths() {
        for p in ["", "  ", ".", "src", "../x"] {
            assert_eq!(kind_of(p), PathKind::Missing, "{p:?}");
        }
    }

    #[test]
    fn serializes_lowercase() {
        let v = serde_json::to_value([PathKind::Dir, PathKind::File, PathKind::Missing]).unwrap();
        assert_eq!(v, serde_json::json!(["dir", "file", "missing"]));
    }

    #[test]
    fn refuses_too_many_paths() {
        let many = vec![String::new(); MAX_PATHS + 1];
        let res = tauri::async_runtime::block_on(path_kinds(many));
        assert!(matches!(res, Err(AppError::InvalidInput(_))));
    }
}
