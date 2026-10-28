//! The git runner: one git process per call, no console window, no prompts, English UTF-8 output.
//!
//! The webview passes the arguments as a list (never a command string) and only the subcommands the
//! source control view needs. Options that make git start another program, write a file or read a file
//! outside the repository are refused, paths must stay inside the repository, push/pull/fetch may name
//! only a configured remote, and git runs only in a repository root outside the home and profile folders
//! (see `guard`).

use super::guard;
use crate::core::error::{AppError, AppResult};
use crate::core::{env, procs, spawn};
use serde::Serialize;
use std::io::{Read, Write};
use std::path::Path;
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
    // read a file from anywhere
    "--no-index",
    "--file",
    "--template",
    "--pathspec-from-file",
    "--orderfile",
    // point git at another repository or remote
    "--repo",
    "--git-dir",
    "--work-tree",
];

/// `rev-parse` arguments the view uses (it only finds the repository root).
const REV_PARSE: &[&str] = &["--show-toplevel", "--is-inside-work-tree", "--abbrev-ref", "HEAD"];

/// Subcommands that talk to a remote and may wait on the network.
const NETWORK: &[&str] = &["push", "pull", "fetch"];
const LOCAL_LIMIT: Duration = Duration::from_secs(120);
const NETWORK_LIMIT: Duration = Duration::from_secs(300);
/// More output than this is dropped (a `git show` of a huge commit); the diff view shows far less.
const MAX_OUTPUT: u64 = 64 * 1024 * 1024;

/// True for an argument that names a place outside the repository: an absolute path, a drive or UNC
/// path, or one with a `..` part. (git diff compares any two files when a path lies outside the work
/// tree, as if `--no-index` were given.) Pathspec magic (`:(literal)x`, `:/x`) is looked through.
pub fn outside_path(arg: &str) -> bool {
    let plain = |p: &str| {
        let b = p.as_bytes();
        p.starts_with(['/', '\\'])
            || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
            || p.split(['/', '\\']).any(|part| part == "..")
    };
    let body = if let Some(rest) = arg.strip_prefix(":(") {
        rest.split_once(')').map_or("", |(_, b)| b)
    } else if let Some(rest) = arg.strip_prefix(':') {
        let rest = rest.trim_start_matches(['/', '!', '^']);
        rest.strip_prefix(':').unwrap_or(rest)
    } else {
        arg
    };
    plain(arg) || plain(body)
}

/// Checks the argument list: an allowed subcommand first, then no denied option before `--`, and no
/// argument (option value, revision or path) that points outside the repository.
pub fn check_args(args: &[String]) -> AppResult<()> {
    let Some(sub) = args.first() else {
        return Err(AppError::InvalidInput("No git command was given.".into()));
    };
    if !ALLOWED.contains(&sub.as_str()) {
        return Err(AppError::InvalidInput(format!("git {sub} is not allowed here.")));
    }
    let refuse = |arg: &str| {
        Err(AppError::InvalidInput(format!(
            "The git argument {arg} is not allowed here."
        )))
    };
    if sub == "rev-parse" && args[1..].iter().any(|a| !REV_PARSE.contains(&a.as_str())) {
        return refuse(&args[1..].join(" "));
    }
    let mut options = true;
    for (i, arg) in args.iter().enumerate().skip(1) {
        if arg.contains('\0') {
            return Err(AppError::InvalidInput(
                "A git argument contains a NUL character.".into(),
            ));
        }
        if outside_path(arg) {
            return refuse(arg);
        }
        if !options {
            continue; // paths, already checked
        }
        if arg == "--" {
            options = false; // the rest are paths
            continue;
        }
        if let Some(name) = arg
            .strip_prefix("--")
            .map(|rest| rest.split('=').next().unwrap_or(rest))
        {
            if !name.is_empty() && DENIED.iter().any(|d| d[2..].starts_with(name)) {
                return Err(AppError::InvalidInput(format!(
                    "The git option {arg} is not allowed here."
                )));
            }
        } else if let Some(flags) = arg.strip_prefix('-').filter(|f| !f.is_empty()) {
            // short options: commit -F <file> / -t <template> read a file (only -F - , stdin, is fine);
            // -O<file> reads an order file
            let stdin_message = arg == "-F" && args.get(i + 1).is_some_and(|n| n == "-");
            let reads_file = match sub.as_str() {
                "commit" => !stdin_message && flags.contains(['F', 't']),
                "diff" | "show" | "log" => flags.starts_with('O'),
                _ => false,
            };
            if reads_file {
                return refuse(arg);
            }
        }
    }
    Ok(())
}

/// The remote a push, pull or fetch names (its first argument that is not an option), if any.
fn named_remote(args: &[String]) -> Option<&str> {
    if !NETWORK.contains(&args.first()?.as_str()) {
        return None;
    }
    args[1..]
        .iter()
        .take_while(|a| *a != "--")
        .find(|a| !a.starts_with('-'))
        .map(String::as_str)
}

/// Whether `name` is one of the remotes configured in the repository (`git remote`).
fn is_remote(git: &Path, dir: &Path, name: &str) -> bool {
    let mut cmd = command(git, dir, true);
    cmd.arg("remote");
    spawn::output_with_timeout(&mut cmd, LOCAL_LIMIT)
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == name))
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
pub(super) fn command(git: &Path, dir: &Path, poll: bool) -> Command {
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
    // rev-parse finds the repository of a sidebar folder; everything else runs in a repository root
    let dir = guard::folder(dir, args[0] != "rev-parse")?;
    let git = env::wait_env().git.as_deref();
    if let Some(why) = git_missing(git) {
        return Ok(GitOutput {
            code: -1,
            stdout: String::new(),
            stderr: why,
        });
    }
    let git = git.unwrap_or(Path::new("git"));
    if let Some(remote) = named_remote(args)
        && !is_remote(git, &dir, remote)
    {
        return Err(AppError::InvalidInput(format!(
            "git {} {remote}: only a remote configured in this repository can be named.",
            args[0]
        )));
    }
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
    fn refuses_reading_files_outside_the_repository() {
        for bad in [
            &["diff", "--no-index", "--", "a", "b"][..],
            &["diff", "--no-i", "a", "b"],
            &["diff", "--", "C:/Users/u/.claude/.credentials.json", "NUL"],
            &["diff", "--", "/home/u/.claude/.credentials.json", "/dev/null"],
            &["diff", "--", "..\\..\\secret", "x"],
            &["diff", "\\\\server\\share\\x", "y"],
            &["diff", "--", ":(literal)C:/x", "NUL"],
            &["diff", "--", ":(top)../x"],
            &["diff", "--", ":/../x"],
            &["commit", "-F", "notes.txt"],
            &["commit", "-aF", "-"],
            &["commit", "--file=-"],
            &["commit", "-t", "tpl"],
            &["commit", "--template=tpl"],
            &["add", "--pathspec-from-file=list"],
            &["diff", "-Oorder"],
            &["log", "--orderfile=x"],
            &["push", "--repo=https://example.test/x"],
            &["rev-parse", "--git-path", "x"],
            &["rev-parse", "--resolve-git-dir", "x"],
        ] {
            assert!(
                matches!(check_args(&args(bad)), Err(AppError::InvalidInput(_))),
                "{bad:?}"
            );
        }
        for ok in [
            &["commit", "-F", "-"][..],
            &["commit", "--amend", "--no-edit"],
            &["restore", "--", ":/"],
            &["reset", "--soft", "HEAD~1"],
            &["log", "HEAD~3..HEAD"],
            &["stash", "push", "-u", "-m", "2026-10-25 12:00 from Claude Manager"],
            &["switch", "-c", "feature/x"],
        ] {
            assert!(check_args(&args(ok)).is_ok(), "{ok:?}");
        }
    }

    #[test]
    fn finds_the_remote_a_network_command_names() {
        assert_eq!(named_remote(&args(&["push"])), None);
        assert_eq!(named_remote(&args(&["fetch", "--prune"])), None);
        assert_eq!(named_remote(&args(&["push", "-u", "origin", "HEAD"])), Some("origin"));
        assert_eq!(
            named_remote(&args(&["fetch", "https://example.test/x"])),
            Some("https://example.test/x")
        );
        assert_eq!(named_remote(&args(&["log", "HEAD"])), None);
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
        // only configured remotes; nothing goes to a URL the caller names
        assert!(matches!(
            run(repo, &args(&["push", "https://example.test/x", "HEAD"]), None, false),
            Err(AppError::InvalidInput(_))
        ));
        setup(&["remote", "add", "origin", "https://example.test/repo.git"]);
        assert!(named_remote(&args(&["push", "origin"])).is_some_and(|r| is_remote(&git, dir.path(), r)));
        // a sub-folder: rev-parse finds the root, other commands need the root itself
        let sub = dir.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        let sub = sub.to_str().unwrap();
        assert_eq!(
            run(sub, &args(&["rev-parse", "--show-toplevel"]), None, false)
                .unwrap()
                .code,
            0
        );
        assert!(matches!(
            run(sub, &args(&["status"]), None, false),
            Err(AppError::InvalidInput(_))
        ));
    }
}
