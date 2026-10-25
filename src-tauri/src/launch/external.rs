//! "New window" mode: claude (or a plain shell, "Terminal here") in a terminal window of the OS. The window
//! is not the app's: it is not in the job object and keeps running when the app quits.
//!
//! - Windows: Windows Terminal (`wt.exe -d <dir> <shell> ...`) when it is installed, else PowerShell in a
//!   new console. The command PowerShell runs is passed as `-EncodedCommand` (base64 of UTF-16LE), so no
//!   quoting layer of wt.exe or CreateProcess can change it. As in the Windows app, claude starts before the
//!   PowerShell profiles (they take about a second) and the profiles load once claude ends.
//! - macOS: Terminal (or iTerm when installed) through osascript. The command line is an argument of the
//!   script (`on run argv`), never part of its source; it is built from POSIX single-quoted values.
//!
//! Every value in a command line is validated first: an existing folder, a discovered profile, the claude
//! path, and arguments of the plain shape (`launch::is_plain_arg`).

use super::{Launch, check_args};
use crate::core::error::{AppError, AppResult};
use crate::core::paths;
use std::path::Path;

/// Opens claude for `launch` in a new terminal window.
pub fn open_claude(launch: &Launch, claude: &Path) -> AppResult<()> {
    check_args(launch, claude)?;
    let home = paths::home()?;
    imp::open_claude(launch, claude, &home)
}

/// Opens the user's shell in `dir` in a new terminal window.
pub fn open_shell(dir: &Path) -> AppResult<()> {
    imp::open_shell(dir)
}

fn is_default_profile(profile: &Path, home: &Path) -> bool {
    paths::same(profile, &home.join(".claude"))
}

// ---- Windows ----

/// Loads the PowerShell profiles by hand, for a shell started with -NoProfile.
#[cfg(any(windows, test))]
const LOAD_PROFILES: &str = "foreach ($p in @($PROFILE.AllUsersAllHosts, $PROFILE.AllUsersCurrentHost, \
     $PROFILE.CurrentUserAllHosts, $PROFILE.CurrentUserCurrentHost)) { if (Test-Path $p) { . $p } }";

/// A PowerShell single-quoted string literal. PowerShell also reads the typographic single quotes as
/// quotes, so they are doubled as well.
#[cfg(any(windows, test))]
fn ps_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// What PowerShell runs: set the profile's config folder, run claude, and load the PowerShell profiles
/// once it ends (`finally`: also after Ctrl+C). CLAUDE_CONFIG_DIR is also set on the process, but a
/// Windows Terminal tab may not get the caller's environment, so the script sets it too.
#[cfg(any(windows, test))]
fn ps_claude_script(launch: &Launch, claude: &Path, home: &Path) -> String {
    let config = if is_default_profile(&launch.profile, home) {
        "Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue".to_string()
    } else {
        format!(
            "$env:CLAUDE_CONFIG_DIR = {}",
            ps_quote(&launch.profile.to_string_lossy())
        )
    };
    let mut call = format!("& {}", ps_quote(&claude.to_string_lossy()));
    for a in &launch.args {
        call.push(' ');
        call.push_str(a);
    }
    format!("{config}; try {{ {call} }} finally {{ {LOAD_PROFILES} }}")
}

#[cfg(any(windows, test))]
fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ABC[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// PowerShell's `-EncodedCommand` form of `script`: base64 of its UTF-16LE bytes.
#[cfg(any(windows, test))]
fn encode_command(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

/// The shell's arguments: an interactive window, with `script` run first when there is one.
#[cfg(any(windows, test))]
fn powershell_args(script: Option<&str>) -> Vec<String> {
    let mut args = vec!["-NoExit".to_string(), "-NoLogo".to_string()];
    if let Some(script) = script {
        args.extend(["-NoProfile".into(), "-EncodedCommand".into(), encode_command(script)]);
    }
    args
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::core::env;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;
    use windows_sys::Win32::System::Threading::CREATE_NEW_CONSOLE;

    pub fn open_claude(launch: &Launch, claude: &Path, home: &Path) -> AppResult<()> {
        let script = ps_claude_script(launch, claude, home);
        open(&launch.dir, Some(&script), Some((&launch.profile, home)))
    }

    pub fn open_shell(dir: &Path) -> AppResult<()> {
        open(dir, None, None)
    }

    /// wt.exe is an app execution alias: a reparse point that `is_file` does not accept, but that starts.
    fn windows_terminal() -> Option<PathBuf> {
        let path = std::env::var_os("PATH");
        let on_path = path
            .iter()
            .flat_map(std::env::split_paths)
            .map(|d| d.join("wt.exe"))
            .find(|p| p.symlink_metadata().is_ok());
        on_path.or_else(|| {
            let alias = dirs::data_local_dir()?.join(r"Microsoft\WindowsApps\wt.exe");
            alias.symlink_metadata().is_ok().then_some(alias)
        })
    }

    fn open(dir: &Path, script: Option<&str>, profile: Option<(&Path, &Path)>) -> AppResult<()> {
        let shell = &env::wait_env().shell;
        let shell_args = powershell_args(script);
        // wt.exe reads ';' as the start of its next command, even inside a quoted folder
        let wt = windows_terminal().filter(|_| !dir.to_string_lossy().contains(';'));
        let mut cmd = match &wt {
            Some(wt) => {
                let mut c = Command::new(wt);
                c.arg("-d").arg(dir).arg(shell).args(&shell_args);
                c
            }
            None => {
                let mut c = Command::new(shell);
                c.args(&shell_args).creation_flags(CREATE_NEW_CONSOLE);
                c
            }
        };
        cmd.current_dir(dir);
        env::clean_env(&mut cmd);
        if let Some((profile, home)) = profile {
            env::apply_profile(&mut cmd, profile, home);
        }
        // not waited for and not in the job object: the window belongs to the user from here on
        cmd.spawn()
            .map(drop)
            .map_err(|e| AppError::Internal(format!("Could not open a terminal window: {e}")))
    }
}

// ---- macOS ----

/// A POSIX shell single-quoted word (also read correctly by fish).
#[cfg(any(target_os = "macos", test))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// `cd <dir> && env CLAUDE_CONFIG_DIR=<profile> <claude> <args>`. `env` works in every shell (fish and csh
/// have no `VAR=value command`); for the default profile it removes an inherited CLAUDE_CONFIG_DIR.
#[cfg(any(target_os = "macos", test))]
fn mac_claude_line(launch: &Launch, claude: &Path, home: &Path) -> String {
    let env = if is_default_profile(&launch.profile, home) {
        "env -u CLAUDE_CONFIG_DIR".to_string()
    } else {
        format!("env CLAUDE_CONFIG_DIR={}", sh_quote(&launch.profile.to_string_lossy()))
    };
    let mut line = format!(
        "cd {} && {env} {}",
        sh_quote(&launch.dir.to_string_lossy()),
        sh_quote(&claude.to_string_lossy())
    );
    for a in &launch.args {
        line.push(' ');
        line.push_str(a);
    }
    line
}

#[cfg(any(target_os = "macos", test))]
fn mac_shell_line(dir: &Path) -> String {
    format!("cd {}", sh_quote(&dir.to_string_lossy()))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use crate::core::spawn;
    use std::time::Duration;

    const TERMINAL: &str = "on run argv
    tell application \"Terminal\"
        activate
        do script (item 1 of argv)
    end tell
end run";

    const ITERM: &str = "on run argv
    tell application \"iTerm\"
        activate
        set w to (create window with default profile)
        tell current session of w to write text (item 1 of argv)
    end tell
end run";

    pub fn open_claude(launch: &Launch, claude: &Path, home: &Path) -> AppResult<()> {
        run(&mac_claude_line(launch, claude, home))
    }

    pub fn open_shell(dir: &Path) -> AppResult<()> {
        run(&mac_shell_line(dir))
    }

    fn run(line: &str) -> AppResult<()> {
        // a script naming iTerm only compiles where iTerm is installed
        let (script, name) = if Path::new("/Applications/iTerm.app").is_dir() {
            (ITERM, "iTerm")
        } else {
            (TERMINAL, "Terminal")
        };
        let mut cmd = spawn::hidden_command("/usr/bin/osascript");
        cmd.arg("-e").arg(script).arg(line);
        // the first time, macOS asks whether the app may control Terminal; the user may take a while
        let out = spawn::output_with_timeout(&mut cmd, Duration::from_secs(120))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(AppError::Internal(format!(
                "{name} could not be opened.\n{}",
                err.trim()
            )));
        }
        Ok(())
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::*;

    pub fn open_claude(_launch: &Launch, _claude: &Path, _home: &Path) -> AppResult<()> {
        Err(AppError::InvalidInput(
            "Opening a terminal window is not supported here.".into(),
        ))
    }

    pub fn open_shell(_dir: &Path) -> AppResult<()> {
        Err(AppError::InvalidInput(
            "Opening a terminal window is not supported here.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ID: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    fn launch(dir: &str, profile: &str, args: &[&str]) -> Launch {
        Launch {
            dir: PathBuf::from(dir),
            profile: PathBuf::from(profile),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    #[test]
    fn base64_matches_the_standard_alphabet() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd]), "//79");
        // PowerShell's own: [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('dir'))
        assert_eq!(encode_command("dir"), "ZABpAHIA");
    }

    #[test]
    fn powershell_literals_double_every_quote() {
        assert_eq!(ps_quote(r"C:\Users\me\.claude-work"), r"'C:\Users\me\.claude-work'");
        assert_eq!(ps_quote("it's"), "'it''s'");
        assert_eq!(ps_quote("a\u{2019}b"), "'a\u{2019}\u{2019}b'");
        assert_eq!(ps_quote("$env:X; calc"), "'$env:X; calc'");
    }

    // Windows paths: on macOS the test home is not a home folder, so the default profile is not recognised
    #[cfg(windows)]
    #[test]
    fn powershell_script_sets_the_profile_and_loads_profiles_after_claude() {
        let home = Path::new(r"C:\Users\me");
        let work = launch(r"C:\code", r"C:\Users\me\.claude-o'brien", &[&format!("--resume={ID}")]);
        let script = ps_claude_script(&work, Path::new(r"C:\bin\claude.exe"), home);
        assert_eq!(
            script,
            format!(
                "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\me\\.claude-o''brien'; try {{ & 'C:\\bin\\claude.exe' --resume={ID} }} finally {{ {LOAD_PROFILES} }}"
            )
        );
        let default = launch(r"C:\code", r"C:\Users\me\.claude", &[]);
        let script = ps_claude_script(&default, Path::new(r"C:\bin\claude.exe"), home);
        assert!(script.starts_with("Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue; try { & "));
    }

    #[test]
    fn powershell_args_encode_the_script() {
        assert_eq!(powershell_args(None), ["-NoExit", "-NoLogo"]);
        let args = powershell_args(Some("dir"));
        assert_eq!(
            args,
            ["-NoExit", "-NoLogo", "-NoProfile", "-EncodedCommand", "ZABpAHIA"]
        );
    }

    #[test]
    fn posix_words_survive_quotes_and_metacharacters() {
        assert_eq!(sh_quote("/Users/me/My Code"), "'/Users/me/My Code'");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(sh_quote("$(rm -rf ~); `x` && y"), "'$(rm -rf ~); `x` && y'");
    }

    #[test]
    fn mac_command_line_quotes_every_value() {
        let home = Path::new("/Users/me");
        let work = launch(
            "/Users/me/it's",
            "/Users/me/.claude-work",
            &[&format!("--resume={ID}"), "--fork-session"],
        );
        assert_eq!(
            mac_claude_line(&work, Path::new("/Users/me/.local/bin/claude"), home),
            format!(
                r"cd '/Users/me/it'\''s' && env CLAUDE_CONFIG_DIR='/Users/me/.claude-work' '/Users/me/.local/bin/claude' --resume={ID} --fork-session"
            )
        );
        let default = launch("/tmp", "/Users/me/.claude", &[]);
        assert_eq!(
            mac_claude_line(&default, Path::new("/opt/homebrew/bin/claude"), home),
            "cd '/tmp' && env -u CLAUDE_CONFIG_DIR '/opt/homebrew/bin/claude'"
        );
        assert_eq!(mac_shell_line(Path::new("/a b")), "cd '/a b'");
    }

    #[test]
    fn unplain_arguments_never_reach_a_window() {
        let bad = launch(".", ".", &["x;calc"]);
        assert!(matches!(
            open_claude(&bad, Path::new("claude")),
            Err(AppError::InvalidInput(_))
        ));
    }
}
