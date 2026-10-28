//! Background helper processes (git, VS Code, /usr/bin/security, ...): no console window, cleaned
//! environment, resolved PATH, and a time limit when their output is awaited.

use super::error::AppResult;
use super::{env, procs};
use std::ffi::OsStr;
use std::io::Read;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

/// How long a timed-out process is given to be reaped after its tree was ended.
const REAP_WAIT: Duration = Duration::from_secs(5);

/// A `Command` for a helper process. Pass an absolute program path from `core::env` rather than a bare
/// name. Blocks while startup environment resolution runs, so build it off the UI thread.
pub fn hidden_command(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    env::clean_env(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Waits for `child` to exit, at most `limit`, on a waiting thread (no polling). On a timeout its whole
/// process tree is ended (a hung git may be waiting on an ssh it started) and `Ok(None)` is returned.
pub fn wait_or_kill(mut child: Child, limit: Duration) -> std::io::Result<Option<ExitStatus>> {
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait());
    });
    match rx.recv_timeout(limit) {
        Ok(status) => status.map(Some),
        Err(RecvTimeoutError::Disconnected) => Err(std::io::Error::other("waiting for a process failed")),
        Err(RecvTimeoutError::Timeout) => {
            // kill_tree ends the child itself too; the waiting thread then reaps it
            procs::kill_tree(pid);
            let _ = rx.recv_timeout(REAP_WAIT);
            Ok(None)
        }
    }
}

/// Runs `cmd` with no input and collects its output, like `Command::output`, but ends it after `limit`.
/// A timeout is an `AppError::Io` of kind `TimedOut`. Blocking: call it off the UI thread.
pub fn output_with_timeout(cmd: &mut Command, limit: Duration) -> AppResult<Output> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // read both pipes while waiting: a child that fills a pipe would otherwise block forever
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let Some(status) = wait_or_kill(child, limit)? else {
        let program = cmd.get_program().to_string_lossy().into_owned();
        return Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("{program} did not finish within {} s", limit.as_secs_f32()),
        )
        .into());
    };
    Ok(Output {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::error::AppError;
    use std::time::Instant;

    fn shell(script: &str) -> Command {
        let mut cmd = if cfg!(windows) {
            let mut c = hidden_command("cmd");
            c.args(["/d", "/c", script]);
            c
        } else {
            let mut c = hidden_command("sh");
            c.args(["-c", script]);
            c
        };
        cmd.stdin(Stdio::null());
        cmd
    }

    #[test]
    fn runs_without_a_console_and_captures_output() {
        let out = shell("echo ok").output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }

    #[test]
    fn collects_output_and_exit_code_within_the_limit() {
        let out =
            output_with_timeout(&mut shell("echo out&& echo err 1>&2&& exit 3"), Duration::from_secs(10)).unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
    }

    #[test]
    fn ends_a_child_that_runs_too_long() {
        let slow = if cfg!(windows) {
            "ping -n 30 127.0.0.1 >NUL"
        } else {
            "sleep 30"
        };
        let started = Instant::now();
        let err = output_with_timeout(&mut shell(slow), Duration::from_millis(300)).unwrap_err();
        assert!(matches!(err, AppError::Io(ref e) if e.kind() == std::io::ErrorKind::TimedOut));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
