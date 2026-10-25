//! Open in VS Code: a folder, or every folder of a project in one window (multi-root).
//!
//! Windows: `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`, `%ProgramFiles%\Microsoft VS Code\Code.exe`,
//! then `code` on PATH. macOS: the `code` command (on the login PATH or inside the app bundle), which
//! opens several folders as one window; else `open -a` with the app in /Applications.

use crate::core::env;
use crate::core::error::{AppError, AppResult, blocking};
use crate::core::paths;
use crate::core::spawn::hidden_command;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const NOT_FOUND: &str = "VS Code was not found.";

/// Absolute paths that exist, without duplicates (missing ones are skipped, as the Windows app did).
pub fn existing(paths: &[String]) -> Vec<PathBuf> {
    let mut seen = Vec::new();
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(paths::norm(p.trim()));
        // absolute paths cannot be mistaken for VS Code options
        if !path.is_absolute() || !path.exists() {
            continue;
        }
        let key = paths::key(&path.to_string_lossy());
        if !seen.contains(&key) {
            seen.push(key);
            out.push(path);
        }
    }
    out
}

fn open(paths: &[String]) -> AppResult<()> {
    let list = existing(paths);
    if list.is_empty() {
        return Err(AppError::NotFound("This folder no longer exists.".into()));
    }
    let mut cmd = command().ok_or_else(|| AppError::NotFound(NOT_FOUND.into()))?;
    cmd.args(&list)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    // the launcher exits once VS Code is up; reap it so it does not linger as a zombie
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(windows)]
fn command() -> Option<Command> {
    let installs = [
        ("LOCALAPPDATA", r"Programs\Microsoft VS Code\Code.exe"),
        ("ProgramFiles", r"Microsoft VS Code\Code.exe"),
    ];
    let mut candidates: Vec<PathBuf> = installs
        .iter()
        .filter_map(|(var, rest)| std::env::var_os(var).map(|base| PathBuf::from(base).join(rest)))
        .collect();
    candidates.extend(env::wait_env().code.clone());
    candidates.into_iter().find(|p| p.is_file()).map(hidden_command)
}

#[cfg(not(windows))]
fn command() -> Option<Command> {
    // hidden_command gives it the login PATH, which the `code` script needs
    if let Some(code) = env::wait_env().code.clone().filter(|p| p.is_file()) {
        return Some(hidden_command(code));
    }
    let home = dirs::home_dir().unwrap_or_default();
    let app = [
        PathBuf::from("/Applications/Visual Studio Code.app"),
        home.join("Applications/Visual Studio Code.app"),
    ]
    .into_iter()
    .find(|p| p.is_dir())?;
    let mut cmd = hidden_command("/usr/bin/open");
    cmd.arg("-a").arg(app);
    Some(cmd)
}

// ---- commands ----

/// Opens existing files or folders in VS Code; several folders open as one multi-root window.
#[tauri::command]
pub async fn open_in_code(paths: Vec<String>) -> AppResult<()> {
    blocking(move || open(&paths)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_existing_absolute_paths_once() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        std::fs::create_dir(&a).unwrap();
        let a_text = a.to_string_lossy().into_owned();
        let list = existing(&[
            a_text.clone(),
            format!("{a_text}/"),
            tmp.path().join("missing").to_string_lossy().into_owned(),
            "relative".into(),
            "--disable-extensions".into(),
            String::new(),
        ]);
        assert_eq!(list, vec![PathBuf::from(paths::norm(&a_text))]);
    }

    #[test]
    fn nothing_to_open_is_an_error() {
        assert!(matches!(open(&["relative".into()]), Err(AppError::NotFound(_))));
    }
}
