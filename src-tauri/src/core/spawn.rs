//! Background helper processes (git, VS Code, ...): no console window, cleaned environment, resolved PATH.

use super::env;
use std::ffi::OsStr;
use std::process::Command;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_without_a_console_and_captures_output() {
        let (program, args): (&str, &[&str]) = if cfg!(windows) {
            ("cmd", &["/d", "/c", "echo ok"])
        } else {
            ("sh", &["-c", "echo ok"])
        };
        let out = hidden_command(program).args(args).output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }
}
