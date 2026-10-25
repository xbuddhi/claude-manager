//! The git runner: one git process per call, no console window, no prompts, English UTF-8 output.
//!
//! The webview passes the arguments as a list (never a command string) and only the subcommands the
//! source control view needs. Options that make git start another program or write a file are refused.

use crate::core::error::{AppError, AppResult};
use crate::core::{env, procs, spawn};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use ts_rs::TS;

/// What git printed and how it ended. `code` is -1 when git could not run (`stderr` says why).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Subcommands the webview may run.
const ALLOWED: &[&str] = &[
    "status",
    "diff",
    "show",
    "log",
    "add",
    "restore",
    "reset",
    "commit",
    "push",
    "pull",
    "fetch",
    "stash",
    "switch",
    "branch",
    "rev-parse",
];

/// Options that run another program or write a file. git accepts any unique prefix of a long option,
/// so an argument is refused when it is one of these or an abbreviation of one.
const DENIED: &[&str] = &[
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--output",
    "--ext-diff",
    "--open-files-in-pager",
];

/// Subcommands that talk to a remote and may wait on the network.
const NETWORK: &[&str] = &["push", "pull", "fetch"];
const LOCAL_LIMIT: Duration = Duration::from_secs(120);
const NETWORK_LIMIT: Duration = Duration::from_secs(300);
/// More output than this is dropped (a `git show` of a huge commit); the diff view shows far less.
const MAX_OUTPUT: u64 = 64 * 1024 * 1024;

/// Checks the argument list: an allowed subcommand first, then no denied option before `--`.
pub fn check_args(args: &[String]) -> AppResult<()> {
    let Some(sub) = args.first() else {
        return Err(AppError::InvalidInput("No git command was given.".into()));
    };
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(AppError::InvalidInput(format!("git {sub} is not allowed here.")));
    }
    for arg in &args[1..] {
        if arg == "--" {
            break; // the rest are paths
        }
        if arg.contains('\0') {
            return Err(AppError::InvalidInput(
                "A git argument contains a NUL character.".into(),
            ));
        }
        if let Some(name) = arg
            .strip_prefix("--")
            .map(|rest| rest.split('=').next().unwrap_or(rest))
            && !name.is_empty()
            && DENIED.iter().any(|d| d[2..].starts_with(name))
        {
            return Err(AppError::InvalidInput(format!(
                "The git option {arg} is not allowed here."
            )));
        }
    }
    Ok(())
}

/// Why git cannot run on this machine, or None when it can.
fn git_missing(git: Option<&Path>) -> Option<String> {
    let Some(git) = git else {
        return Some(if cfg!(windows) {
            "Git was not found. Install Git for Windows, then restart Claude Manager.".into()
        } else {
            "Git was not found. Install it, then restart Claude Manager.".into()
        });
    };
    // /usr/bin/git is only a stub that opens the installer until the Command Line Tools are there
    #[cfg(target_os = "macos")]
    if git == Path::new("/usr/bin/git") && !mac::command_line_tools() {
        return Some("Git is not installed. Install the Xcode Command Line Tools.".into());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = git;
    None
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::OnceLock;
    use std::time::Duration;

    /// Whether `xcode-select -p` names an installed developer folder (asked once).
    pub fn command_line_tools() -> bool {
        static INSTALLED: OnceLock<bool> = OnceLock::new();
        *INSTALLED.get_or_init(|| {
            let mut cmd = crate::core::spawn::hidden_command("/usr/bin/xcode-select");
            cmd.arg("-p");
            crate::core::spawn::output_with_timeout(&mut cmd, Duration::from_secs(5)).is_ok_and(|o| o.status.success())
        })
    }
}

/// The git command for `dir` with the runner's environment. `poll` marks a background status refresh,
/// which must not take locks the user's own git commands could trip over.
fn command(git: &Path, dir: &Path, poll: bool) -> Command {
    let mut cmd = spawn::hidden_command(git);
    cmd.current_dir(dir)
        // never wait for a password in a window nobody sees; English output for parsing
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8");
    if poll {
        cmd.env("GIT_OPTIONAL_LOCKS", "0");
    }
    cmd
}

/// Runs git in `dir`. Blocking: call it off the UI thread.
pub fn run(dir: &str, args: &[String], stdin: Option<&str>, poll: bool) -> AppResult<GitOutput> {
    check_args(args)?;
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found:\n{}", dir.display())));
    }
    let git = env::wait_env().git.as_deref();
    if let Some(why) = git_missing(git) {
        return Ok(GitOutput {
            code: -1,
            stdout: String::new(),
            stderr: why,
        });
    }
    let git = git.unwrap_or(Path::new("git"));
    let limit = if NETWORK.contains(&args[0].as_str()) {
        NETWORK_LIMIT
    } else {
        LOCAL_LIMIT
    };
    let mut cmd = command(git, &dir, poll);
    cmd.args(args);
    match execute(&mut cmd, stdin, limit) {
        Ok(out) => Ok(out),
        Err(e) => Ok(GitOutput {
            code: -1,
            stdout: String::new(),
            stderr: e.to_string(),
        }),
    }
}

/// Starts `cmd`, writes `stdin` (then closes it), reads both pipes, and ends the process tree after `limit`.
fn execute(cmd: &mut Command, stdin: Option<&str>, limit: Duration) -> AppResult<GitOutput> {
    let mut child = cmd
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let writer = child
        .stdin
        .take()
        .zip(stdin.map(str::to_owned))
        .map(|(mut pipe, text)| {
            std::thread::spawn(move || {
                // a git that exits early closes the pipe; its exit code says what went wrong
                let _ = pipe.write_all(text.as_bytes());
            })
        });
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = (&mut p).take(MAX_OUTPUT).read_to_end(&mut buf);
                // keep reading past the cap so git never blocks on a full pipe
                let _ = std::io::copy(&mut p, &mut std::io::sink());
            }
            String::from_utf8_lossy(&buf).into_owned()
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() >= limit {
            // the whole tree: git may be waiting on an ssh or credential helper it started
            procs::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("git did not finish within {} s and was stopped.", limit.as_secs()),
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    Ok(GitOutput {
        code: status.code().unwrap_or(-1),
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn allows_only_listed_subcommands() {
        for ok in [
            &["status", "-z"][..],
            &["commit", "-F", "-"],
            &["rev-parse", "--show-toplevel"],
        ] {
            assert!(check_args(&args(ok)).is_ok(), "{ok:?}");
        }
        for bad in [
            &[][..],
            &["config", "core.pager", "x"],
            &["-c", "core.sshCommand=x", "fetch"],
            &["clone"],
        ] {
            assert!(
                matches!(check_args(&args(bad)), Err(AppError::InvalidInput(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn refuses_options_that_run_programs_or_write_files() {
        for bad in [
            &["fetch", "--upload-pack=touch x"][..],
            &["pull", "--upload-p", "x"],
            &["push", "--receive-pack", "x"],
            &["push", "--exec=x"],
            &["diff", "--output=C:/x.txt"],
            &["show", "--ext-diff"],
        ] {
            assert!(
                matches!(check_args(&args(bad)), Err(AppError::InvalidInput(_))),
                "{bad:?}"
            );
        }
        // ordinary options, and anything after "--" (a file may be named like an option)
        for ok in [
            &["log", "--oneline", "-n", "5"][..],
            &["push", "-u", "origin", "HEAD"],
            &["add", "--", "--output"],
            &["diff", "--cached", "--no-color", "--", "a b.txt"],
        ] {
            assert!(check_args(&args(ok)).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn rejects_a_missing_folder() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone");
        let err = run(gone.to_str().unwrap(), &args(&["status"]), None, false).unwrap_err();
        assert!(matches!(err, AppError::NotFound(_)));
        let file = dir.path().join("f.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(matches!(
            run(file.to_str().unwrap(), &args(&["status"]), None, false),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn rejects_a_disallowed_subcommand_before_running_anything() {
        let dir = tempfile::tempdir().unwrap();
        let err = run(dir.path().to_str().unwrap(), &args(&["init"]), None, false).unwrap_err();
        assert!(matches!(err, AppError::InvalidInput(_)));
        assert!(!dir.path().join(".git").exists());
    }

    /// Runs real git when it is installed: a commit message goes in through stdin.
    #[test]
    fn runs_git_with_stdin_in_a_temp_repo() {
        let Some(git) = env::wait_env().git.clone() else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_str().unwrap();
        let setup = |a: &[&str]| {
            let out = command(&git, dir.path(), false).args(a).output().unwrap();
            assert!(out.status.success(), "{a:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        setup(&["init", "-q", "-b", "main"]);
        // identity for this repository only (never the user's global config)
        setup(&["config", "user.name", "Test"]);
        setup(&["config", "user.email", "test@example.com"]);
        setup(&["config", "commit.gpgsign", "false"]);
        setup(&["config", "core.hooksPath", "no-hooks"]);
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        let add = run(repo, &args(&["add", "-A"]), None, false).unwrap();
        assert_eq!(add.code, 0, "{}", add.stderr);
        let commit = run(repo, &args(&["commit", "-F", "-"]), Some("First line\n\nBody ü"), false).unwrap();
        assert_eq!(commit.code, 0, "{}", commit.stderr);
        let log = run(repo, &args(&["log", "-n", "1", "--pretty=format:%B"]), None, true).unwrap();
        assert_eq!(log.stdout.trim(), "First line\n\nBody ü");
        let bad = run(repo, &args(&["switch", "no-such-branch"]), None, false).unwrap();
        assert_ne!(bad.code, 0);
        assert!(!bad.stderr.is_empty());
    }
}
