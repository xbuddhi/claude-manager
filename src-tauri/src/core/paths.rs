//! Path helpers shared by every feature: app folders, normalization and comparison keys.
//!
//! Windows and default macOS volumes (APFS) are case-insensitive, so two spellings of one folder must
//! compare equal there. `key()` is the only place that decides this.

use super::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn home() -> AppResult<PathBuf> {
    dirs::home_dir().ok_or_else(|| AppError::NotFound("Your home folder could not be found.".into()))
}

/// `<app config dir>`: settings.json lives here.
pub fn app_config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_config_dir()?)
}

/// `<app cache dir>`: caches that can be rebuilt (session index, usage).
pub fn app_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_cache_dir()?)
}

/// `<app data dir>`: state that should survive but is not a setting.
pub fn app_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_data_dir()?)
}

/// `<app log dir>`: written by tauri-plugin-log.
pub fn app_log_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_log_dir()?)
}

/// Trims trailing `/` and `\`, keeping a root such as `/` or `C:\` intact.
pub fn norm(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        // "/" or "C:\" itself: keep one separator so it still names the root
        return path.get(..trimmed.len() + 1).unwrap_or(path).to_string();
    }
    trimmed.to_string()
}

/// Comparison key for a path: normalized, and on Windows and macOS case-folded with one separator style.
pub fn key(path: &str) -> String {
    let n = norm(path);
    if cfg!(windows) {
        n.replace('/', "\\").to_lowercase()
    } else if cfg!(target_os = "macos") {
        n.to_lowercase()
    } else {
        n
    }
}

pub fn same(a: &Path, b: &Path) -> bool {
    key(&a.to_string_lossy()) == key(&b.to_string_lossy())
}

/// True when `child` lies strictly inside `root` (not equal to it). Lexical only: paths containing
/// `..` are rejected, so a path cannot climb out of `root` after passing the check.
pub fn is_within(child: &Path, root: &Path) -> bool {
    if child.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    let sep = if cfg!(windows) { '\\' } else { '/' };
    let mut root_key = key(&root.to_string_lossy());
    if !root_key.ends_with(sep) {
        root_key.push(sep);
    }
    let child_key = key(&child.to_string_lossy());
    child_key.len() > root_key.len() && child_key.starts_with(&root_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn norm_trims_but_keeps_roots() {
        assert_eq!(norm("/Users/x/"), "/Users/x");
        assert_eq!(norm(r"C:\code\app\\"), r"C:\code\app");
        assert_eq!(norm("/"), "/");
        assert_eq!(norm(r"C:\"), r"C:\");
        assert_eq!(norm("C:/"), "C:/");
    }

    #[test]
    fn key_matches_platform_case_rules() {
        let same_folder = key("/Users/X/Proj/") == key("/users/x/proj");
        assert_eq!(same_folder, cfg!(any(windows, target_os = "macos")));
        if cfg!(windows) {
            assert_eq!(key("C:/Code/App"), key(r"c:\code\app\"));
        }
    }

    #[test]
    fn is_within_is_strict_and_rejects_parent_components() {
        let root = Path::new(if cfg!(windows) {
            r"C:\Users\me\.claude"
        } else {
            "/Users/me/.claude"
        });
        assert!(is_within(&root.join("projects").join("a.jsonl"), root));
        assert!(!is_within(root, root));
        assert!(!is_within(&root.join("..").join("x"), root));
        let sibling = PathBuf::from(format!("{}-work", root.display())).join("x");
        assert!(!is_within(&sibling, root));
    }
}
