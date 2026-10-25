//! The command a terminal tab inside the app runs: the absolute claude path, started directly in a PTY
//! (no shell in between), with a cleaned environment and the profile's config folder.

use super::{Launch, check_args};
use crate::core::env;
use crate::core::error::AppResult;
use portable_pty::CommandBuilder;
use std::path::Path;

/// The PTY command for `launch`. `home` decides which profile is the default one.
pub fn build(launch: &Launch, claude: &Path, home: &Path) -> AppResult<CommandBuilder> {
    // a .cmd runs through cmd.exe, whose parser would interpret & | ^ % and quotes in arguments
    if env::is_batch_file(claude) {
        check_args(launch, claude)?;
    }
    let mut cmd = CommandBuilder::new(claude);
    cmd.args(&launch.args);
    cmd.cwd(&launch.dir);
    child_env(&mut cmd, &launch.profile, home);
    Ok(cmd)
}

/// Cleaned environment, the profile's config folder, and what a terminal program expects to find.
pub fn child_env(cmd: &mut CommandBuilder, profile: &Path, home: &Path) {
    env::clean_env(cmd);
    // also whatever the builder holds beyond this process's environment
    let held: Vec<String> = cmd
        .iter_full_env_as_str()
        .map(|(k, _)| k.to_string())
        .filter(|k| env::is_stripped(k))
        .collect();
    for k in held {
        cmd.env_remove(k);
    }
    env::apply_profile(cmd, profile, home);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "ClaudeManager");
    // apps started from Finder get no locale, and claude's tools would then run in the C locale
    if cfg!(unix) && std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{ID, profile_with_session};
    use super::*;
    use crate::core::error::AppError;
    use crate::launch::new_session;

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
        let var = |k: &str| cmd.get_env(k).and_then(|v| v.to_str()).map(str::to_string);
        assert_eq!(var("TERM_PROGRAM").as_deref(), Some("ClaudeManager"));
        assert_eq!(var("TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(var("COLORTERM").as_deref(), Some("truecolor"));
        assert_eq!(cmd.get_argv()[0], "/opt/claude");
        assert_eq!(cmd.get_cwd().map(|c| c.as_os_str()), Some(root.path().as_os_str()));
    }

    #[test]
    fn env_drops_session_markers_and_credentials_and_sets_the_profile() {
        let home = tempfile::tempdir().unwrap();
        let mut cmd = CommandBuilder::new("/opt/claude");
        for k in ["CLAUDECODE", "CLAUDE_CODE_X", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"] {
            cmd.env(k, "1");
        }
        cmd.env("KEEP_ME", "1");
        let work = home.path().join(".claude-work");
        child_env(&mut cmd, &work, home.path());
        for k in ["CLAUDECODE", "CLAUDE_CODE_X", "ANTHROPIC_API_KEY"] {
            assert_eq!(cmd.get_env(k), None, "{k}");
        }
        assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), Some(work.as_os_str()));
        assert!(cmd.get_env("KEEP_ME").is_some());

        // the default profile: an inherited CLAUDE_CONFIG_DIR is removed and none is set
        let mut cmd = CommandBuilder::new("/opt/claude");
        cmd.env("CLAUDE_CONFIG_DIR", "/elsewhere");
        child_env(&mut cmd, &home.path().join(".claude"), home.path());
        assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), None);
    }
}
