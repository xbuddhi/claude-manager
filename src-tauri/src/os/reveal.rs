//! Explorer / Finder: show a file or folder selected in its parent, or open a folder. The webview has no
//! opener permissions; these commands take only existing absolute paths, and `open_path` only folders
//! (opening a file would run it).

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::paths;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// `path` as an absolute path that exists; `folder` also requires a directory.
pub fn checked(path: &str, folder: bool) -> AppResult<PathBuf> {
    let p = PathBuf::from(paths::norm(path.trim()));
    let ok = p.is_absolute() && if folder { p.is_dir() } else { p.exists() };
    if !ok {
        let what = if folder { "folder" } else { "file or folder" };
        return Err(AppError::NotFound(format!("This {what} no longer exists:\n{path}")));
    }
    Ok(p)
}

// ---- commands ----

/// Shows a file or folder selected in Explorer / Finder.
#[tauri::command]
pub async fn reveal_path(app: AppHandle, path: String) -> AppResult<()> {
    blocking(move || {
        let p = checked(&path, false)?;
        app.opener()
            .reveal_item_in_dir(&p)
            .map_err(|e| AppError::Internal(format!("Could not show it: {e}")))
    })
    .await
}

/// Opens a folder in Explorer / Finder.
#[tauri::command]
pub async fn open_path(app: AppHandle, dir: String) -> AppResult<()> {
    blocking(move || {
        let p = checked(&dir, true)?;
        // Finder by name: `open` alone would launch an app bundle, which is a folder too
        let with = cfg!(target_os = "macos").then_some("Finder");
        app.opener()
            .open_path(p.to_string_lossy(), with)
            .map_err(|e| AppError::Internal(format!("Could not open the folder: {e}")))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_existing_absolute_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("f.jsonl");
        std::fs::write(&file, "{}").unwrap();
        let dir = tmp.path().to_string_lossy();
        let file_text = file.to_string_lossy();

        assert!(checked(&file_text, false).is_ok());
        assert!(checked(&dir, false).is_ok());
        assert!(checked(&dir, true).is_ok());
        // a file is never "opened": that would run it
        assert!(matches!(checked(&file_text, true), Err(AppError::NotFound(_))));
        assert!(checked(&tmp.path().join("missing").to_string_lossy(), false).is_err());
        assert!(checked("relative", false).is_err());
        assert!(checked("", true).is_err());
    }
}
