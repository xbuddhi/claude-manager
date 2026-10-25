//! Builds the command a terminal runs. The webview never supplies arguments, environment or an
//! executable: it names a folder and a profile (and a session id to resume), all validated here, and
//! the argument list is built in Rust from fixed shapes.

use crate::core::env;
use crate::core::error::{AppError, AppResult};
use crate::core::profiles;
use portable_pty::CommandBuilder;
use std::path::{Path, PathBuf};

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

/// The PTY command for `launch`, running the absolute `claude` path directly (no shell in between).
pub fn build(launch: &Launch, claude: &Path, home: &Path) -> AppResult<CommandBuilder> {
    if env::is_batch_file(claude)
        && let Some(bad) = launch.args.iter().find(|a| !is_plain_arg(a))
    {
        // a .cmd runs through cmd.exe, whose parser would interpret & | ^ % and quotes in arguments
        return Err(AppError::InvalidInput(format!(
            "Refusing to pass this argument to {}: {bad}",
            claude.display()
        )));
    }
    let mut cmd = CommandBuilder::new(claude);
    cmd.args(&launch.args);
    cmd.cwd(&launch.dir);
    env::clean_env(&mut cmd);
    env::apply_profile(&mut cmd, &launch.profile, home);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ClaudeManager");
    // apps started from Finder get no locale, and claude's tools would then run in the C locale
    if cfg!(unix) && std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    Ok(cmd)
}

fn is_plain_arg(arg: &str) -> bool {
    !arg.is_empty() && arg.bytes().all(|b| b.is_ascii_alphanumeric() || b"=_.:/-".contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ID: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    fn profile_with_session() -> (tempfile::TempDir, PathBuf) {
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
        assert!(new_session("", profile).is_err());
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
        assert!(matches!(
            resume_session("--dangerously-skip-permissions", profile.clone(), false, &dir),
            Err(AppError::InvalidInput(_))
        ));
        let other = "11111111-2222-3333-4444-555555555555";
        assert!(matches!(
            resume_session(other, profile, false, &dir),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn batch_files_get_plain_arguments_only() {
        let (root, profile) = profile_with_session();
        let dir = root.path().to_path_buf();
        let cmd_file = Path::new(r"C:\npm\claude.cmd");
        let ok = Launch {
            dir: dir.clone(),
            profile: profile.clone(),
            args: vec![format!("--resume={ID}")],
        };
        assert!(build(&ok, cmd_file, root.path()).is_ok());
        let bad = Launch {
            dir,
            profile,
            args: vec!["x&calc".into()],
        };
        assert!(matches!(
            build(&bad, cmd_file, root.path()),
            Err(AppError::InvalidInput(_))
        ));
        assert!(build(&bad, Path::new("/usr/local/bin/claude"), root.path()).is_ok());
    }

    #[test]
    fn command_carries_profile_and_terminal_env() {
        let (root, profile) = profile_with_session();
        let launch = new_session(&root.path().to_string_lossy(), profile.clone()).unwrap();
        let cmd = build(&launch, Path::new("/opt/claude"), root.path()).unwrap();
        assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), Some(profile.as_os_str()));
        assert_eq!(
            cmd.get_env("TERM_PROGRAM").and_then(|v| v.to_str()),
            Some("ClaudeManager")
        );
        assert_eq!(cmd.get_env("ANTHROPIC_API_KEY"), None);
        assert_eq!(cmd.get_argv()[0], "/opt/claude");
    }
}
