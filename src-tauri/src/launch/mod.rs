//! What a terminal runs. The webview never supplies arguments, environment or an executable: it names a
//! folder and a profile (and a session id to resume), all validated here, and the argument list is built
//! in Rust from fixed shapes. `embed` turns a [`Launch`] into a PTY command (a tab inside the app),
//! `external` opens it in a terminal window of the OS.

pub mod embed;
pub mod external;

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{env, profiles, settings};
use std::path::PathBuf;
use tauri::AppHandle;

/// A validated request to run claude.
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    pub dir: PathBuf,
    /// A discovered profile folder (from `profiles::resolve_profile`).
    pub profile: PathBuf,
    pub args: Vec<String>,
}

/// A new session in `dir`.
pub fn new_session(dir: &str, profile: PathBuf) -> AppResult<Launch> {
    Ok(Launch {
        dir: existing_dir(dir)?,
        profile,
        args: Vec::new(),
    })
}

/// Resumes (or forks) a session of `profile` whose transcript exists, running in `dir`.
pub fn resume_session(session_id: &str, profile: PathBuf, fork: bool, dir: &str) -> AppResult<Launch> {
    if !profiles::is_session_id(session_id) {
        return Err(AppError::InvalidInput(format!("Not a session id: {session_id}")));
    }
    if profiles::find_transcript(&profile, session_id).is_none() {
        return Err(AppError::NotFound(format!("Session not found\n{session_id}")));
    }
    // one token, so the id can never be read as a separate flag
    let mut args = vec![format!("--resume={session_id}")];
    if fork {
        args.push("--fork-session".into());
    }
    Ok(Launch {
        dir: existing_dir(dir)?,
        profile,
        args,
    })
}

pub fn existing_dir(dir: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(dir);
    if dir.trim().is_empty() || !path.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found\n{dir}")));
    }
    Ok(path)
}

/// Letters, digits and `=_.:/-` only. Every argument the app builds has this shape; anything else could
/// be read by cmd.exe (a `.cmd` claude) or a shell (an external window) as syntax.
pub fn is_plain_arg(arg: &str) -> bool {
    !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_alphanumeric() || b"=_.:/-".contains(&b))
}

/// Refuses arguments that are not plain (see [`is_plain_arg`]).
pub fn check_args(launch: &Launch, program: &std::path::Path) -> AppResult<()> {
    match launch.args.iter().find(|a| !is_plain_arg(a)) {
        Some(bad) => Err(AppError::InvalidInput(format!(
            "Refusing to pass this argument to {}: {bad}",
            program.display()
        ))),
        None => Ok(()),
    }
}

/// The validated launch for the IPC arguments shared by every way of starting claude.
pub fn launch_for(dir: &str, profile: &str, session_id: Option<&str>, fork: bool) -> AppResult<Launch> {
    let profile = profiles::resolve_profile(profile)?;
    match session_id {
        Some(id) => resume_session(id, profile, fork, dir),
        None => new_session(dir, profile),
    }
}

// ---- commands ----

/// Opens claude (or, with `shell_only`, a plain shell) in `dir` in a terminal window of the OS:
/// Windows Terminal or PowerShell on Windows, Terminal or iTerm on macOS.
#[tauri::command]
pub async fn launch_external(
    app: AppHandle,
    dir: String,
    profile: Option<String>,
    session_id: Option<String>,
    fork: Option<bool>,
    shell_only: Option<bool>,
) -> AppResult<()> {
    let claude_override = settings::get(&app).claude_path;
    blocking(move || {
        if shell_only.unwrap_or(false) {
            return external::open_shell(&existing_dir(&dir)?);
        }
        let profile = profile.ok_or_else(|| AppError::InvalidInput("No profile given.".into()))?;
        let launch = launch_for(&dir, &profile, session_id.as_deref(), fork.unwrap_or(false))?;
        let claude = env::claude_executable(claude_override.as_deref())?;
        external::open_claude(&launch, &claude)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    pub const ID: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    pub fn profile_with_session() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join(".claude-work");
        let slug = profile.join("projects").join("C--code-app");
        fs::create_dir_all(&slug).unwrap();
        fs::write(slug.join(format!("{ID}.jsonl")), "").unwrap();
        (root, profile)
    }

    #[test]
    fn new_session_needs_an_existing_folder() {
        let (root, profile) = profile_with_session();
        let dir = root.path().to_string_lossy().into_owned();
        assert_eq!(new_session(&dir, profile.clone()).unwrap().args, Vec::<String>::new());
        let missing = root.path().join("gone").to_string_lossy().into_owned();
        let err = new_session(&missing, profile.clone()).unwrap_err();
        assert_eq!(err.to_string(), format!("Folder not found\n{missing}"));
        assert!(new_session("", profile.clone()).is_err());
        assert!(new_session("  ", profile).is_err());
    }

    #[test]
    fn resume_builds_args_in_rust() {
        let (root, profile) = profile_with_session();
        let dir = root.path().to_string_lossy().into_owned();
        assert_eq!(
            resume_session(ID, profile.clone(), false, &dir).unwrap().args,
            [format!("--resume={ID}")]
        );
        assert_eq!(
            resume_session(ID, profile.clone(), true, &dir).unwrap().args,
            [format!("--resume={ID}"), "--fork-session".into()]
        );
        for bad in ["--dangerously-skip-permissions", "--x", "", "0f8c2a4e 1b2c"] {
            assert!(
                matches!(
                    resume_session(bad, profile.clone(), false, &dir),
                    Err(AppError::InvalidInput(_))
                ),
                "{bad}"
            );
        }
        let other = "11111111-2222-3333-4444-555555555555";
        assert!(matches!(
            resume_session(other, profile.clone(), false, &dir),
            Err(AppError::NotFound(_))
        ));
        // the folder is checked too
        assert!(matches!(
            resume_session(ID, profile, false, &root.path().join("gone").to_string_lossy()),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn plain_args_only() {
        for ok in [format!("--resume={ID}"), "--fork-session".into(), "C:/x".into()] {
            assert!(is_plain_arg(&ok), "{ok}");
        }
        for bad in [
            "", "x&calc", "a b", "%PATH%", "\"q\"", "^", "a|b", "$(x)", "a;b", "it's",
        ] {
            assert!(!is_plain_arg(bad), "{bad}");
        }
        let launch = Launch {
            dir: PathBuf::from("."),
            profile: PathBuf::from("."),
            args: vec!["x&calc".into()],
        };
        assert!(matches!(
            check_args(&launch, Path::new("claude")),
            Err(AppError::InvalidInput(_))
        ));
    }
}
