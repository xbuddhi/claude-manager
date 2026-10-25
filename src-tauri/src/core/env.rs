//! The environment children run in: where `claude`, the shell, git and VS Code are, the PATH to give
//! them, and which inherited variables must not leak into them.
//!
//! Resolved once on a background thread at startup (`start`). Apps started from Finder or the Dock get
//! a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so on macOS the user's login + interactive shell is
//! asked once for its PATH and `claude` location; children are then started directly with that PATH,
//! never through a shell command string.

use super::error::{AppError, AppResult, lock};
use super::paths;
use super::types::{EnvStatus, PlatformInfo};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

/// How long anything waits for startup resolution, and how long the macOS shell probe may run.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);

/// Inherited variables that are removed from every child:
/// - markers a parent Claude Code session passes down (children would think they are sub-sessions),
/// - NO_COLOR and GIT_TERMINAL_PROMPT, which change how tools behave,
/// - CLAUDE_CONFIG_DIR, which is set per profile instead,
/// - API credentials and endpoints, which would override each profile's own login.
const STRIPPED: &[&str] = &[
    "NO_COLOR",
    "CLAUDECODE",
    "CLAUDE_PID",
    "GIT_TERMINAL_PROMPT",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
];
const STRIPPED_PREFIX: &str = "CLAUDE_CODE_";

#[derive(Debug, Clone)]
pub struct ResolvedEnv {
    pub claude: Option<PathBuf>,
    pub shell: PathBuf,
    pub git: Option<PathBuf>,
    pub code: Option<PathBuf>,
    /// PATH to give children; `None` = inherit ours unchanged.
    pub path: Option<OsString>,
}

static RESOLVED: OnceLock<ResolvedEnv> = OnceLock::new();
static READY: (Mutex<()>, Condvar) = (Mutex::new(()), Condvar::new());
static STARTED: AtomicBool = AtomicBool::new(false);

/// Starts resolution on a background thread. Called once from `core::init`.
pub fn start() {
    STARTED.store(true, Ordering::SeqCst);
    let spawned = std::thread::Builder::new().name("env-resolve".into()).spawn(|| {
        let env = resolve();
        log::info!(
            "environment: claude={:?} shell={:?} git={:?} code={:?}",
            env.claude,
            env.shell,
            env.git,
            env.code
        );
        let _ = RESOLVED.set(env);
        let _guard = lock(&READY.0);
        READY.1.notify_all();
    });
    if let Err(e) = spawned {
        log::error!("could not start environment resolution: {e}");
        STARTED.store(false, Ordering::SeqCst);
    }
}

/// The resolved environment. Blocks for at most 5 s while startup resolution is still running, then
/// falls back to a quick lookup without the shell probe. Never call it on the UI thread.
pub fn wait_env() -> &'static ResolvedEnv {
    if let Some(env) = RESOLVED.get() {
        return env;
    }
    if !STARTED.load(Ordering::SeqCst) {
        // nothing running in the background (tests, or the thread could not start): resolve here
        return RESOLVED.get_or_init(resolve);
    }
    let guard = lock(&READY.0);
    let _ = READY
        .1
        .wait_timeout_while(guard, RESOLVE_TIMEOUT, |_| RESOLVED.get().is_none());
    RESOLVED.get_or_init(|| {
        log::warn!("environment resolution is slow; using a quick lookup");
        resolve_quick()
    })
}

/// File names the Settings override may have. The webview can set that path and terminals run it, so it
/// must name claude itself, never some other program.
const CLAUDE_NAMES: &[&str] = if cfg!(windows) {
    &["claude.exe", "claude.cmd"]
} else {
    &["claude"]
};

/// Checks the shape of a claude path from Settings: absolute, on a local drive (Windows: no UNC or device
/// path, so terminals never run a program from a network share), and named like claude. Existence is
/// checked at launch and when the webview saves the path.
pub fn check_claude_override(path: &str) -> AppResult<PathBuf> {
    let p = Path::new(path.trim());
    let named_claude = p
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|n| CLAUDE_NAMES.iter().any(|c| n.eq_ignore_ascii_case(c)));
    if !p.is_absolute() || !named_claude || !on_local_drive(p) {
        return Err(AppError::InvalidInput(format!(
            "The Claude path must be the full path to {}:\n{path}",
            CLAUDE_NAMES.join(" or ")
        )));
    }
    Ok(p.to_path_buf())
}

/// Windows: the path starts with a drive letter (`C:` or `\\?\C:`), not a UNC share or a device.
fn on_local_drive(p: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        matches!(
            p.components().next(),
            Some(Component::Prefix(pre)) if matches!(pre.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
        )
    }
    #[cfg(not(windows))]
    {
        let _ = p;
        true
    }
}

/// The claude executable to run: the Settings override when it is set, else the discovered one.
pub fn claude_executable(override_path: Option<&str>) -> AppResult<PathBuf> {
    match override_path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            let path = check_claude_override(p)?;
            if path.is_file() {
                Ok(path)
            } else {
                Err(AppError::NotFound(format!(
                    "The Claude path set in Settings does not exist:\n{p}"
                )))
            }
        }
        None => wait_env().claude.clone().ok_or(AppError::ClaudeNotFound),
    }
}

/// The signed-in user's account name (the macOS keychain item's account): from the password database on
/// Unix (not $USER, which a parent may have changed), USERNAME on Windows.
pub fn user_name() -> Option<String> {
    #[cfg(unix)]
    {
        unix::passwd_field(|pw| pw.pw_name)
    }
    #[cfg(windows)]
    {
        std::env::var("USERNAME").ok().filter(|n| !n.is_empty())
    }
}

/// True for a Windows batch file, which CreateProcess runs through cmd.exe. Arguments then pass through
/// cmd's parser, so callers must restrict them to plain characters (see `pty::command`).
pub fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Something a child environment can be applied to: `std::process::Command` or a PTY `CommandBuilder`.
pub trait EnvTarget {
    fn remove_var(&mut self, key: &OsStr);
    fn set_var(&mut self, key: &OsStr, value: &OsStr);
}

impl EnvTarget for std::process::Command {
    fn remove_var(&mut self, key: &OsStr) {
        self.env_remove(key);
    }
    fn set_var(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
}

impl EnvTarget for portable_pty::CommandBuilder {
    fn remove_var(&mut self, key: &OsStr) {
        self.env_remove(key);
    }
    fn set_var(&mut self, key: &OsStr, value: &OsStr) {
        self.env(key, value);
    }
}

/// Removes the inherited variables listed in [`STRIPPED`] and applies the resolved PATH.
/// Blocks like [`wait_env`] while startup resolution runs.
pub fn clean_env(target: &mut impl EnvTarget) {
    for (key, _) in std::env::vars_os() {
        if key.to_str().is_some_and(is_stripped) {
            target.remove_var(&key);
        }
    }
    if let Some(path) = &wait_env().path {
        target.set_var(OsStr::new("PATH"), path);
    }
}

/// Points the child at `profile`: CLAUDE_CONFIG_DIR for any profile except the default `~/.claude`.
/// Call after [`clean_env`], which removes an inherited CLAUDE_CONFIG_DIR.
pub fn apply_profile(target: &mut impl EnvTarget, profile: &Path, home: &Path) {
    if !paths::same(profile, &home.join(".claude")) {
        target.set_var(OsStr::new("CLAUDE_CONFIG_DIR"), profile.as_os_str());
    }
}

pub fn is_stripped(key: &str) -> bool {
    // Windows variable names are case-insensitive
    let key = if cfg!(windows) {
        key.to_ascii_uppercase()
    } else {
        key.to_string()
    };
    STRIPPED.contains(&key.as_str()) || (key.starts_with(STRIPPED_PREFIX) && key.len() > STRIPPED_PREFIX.len())
}

pub fn platform() -> PlatformInfo {
    let build = if cfg!(windows) {
        // kernel_version() is the build number on Windows
        sysinfo::System::kernel_version()
    } else {
        sysinfo::System::os_version()
    };
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        build: build.unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

/// First `name` found in the directories of `path_var`.
pub fn find_in_path(path_var: Option<&OsStr>, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path_var?)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

fn first_existing(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file())
}

#[cfg(windows)]
fn resolve() -> ResolvedEnv {
    let path = std::env::var_os("PATH");
    let path = path.as_deref();
    let home = dirs::home_dir().unwrap_or_default();
    // claude.exe (native installer) anywhere on PATH wins over the npm claude.cmd shim, which runs through cmd.exe
    let claude = find_in_path(path, "claude.exe")
        .or_else(|| find_in_path(path, "claude.cmd"))
        .or_else(|| first_existing([home.join(".local").join("bin").join("claude.exe")]));
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let shell = find_in_path(path, "pwsh.exe")
        .or_else(|| first_existing([system_root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")]))
        .unwrap_or_else(|| PathBuf::from("powershell.exe"));
    let git = find_in_path(path, "git.exe");
    // VS Code puts bin\code.cmd on PATH; prefer the Code.exe next to it so no cmd.exe is involved
    let code = find_in_path(path, "code.cmd")
        .map(|cmd| {
            cmd.parent()
                .and_then(Path::parent)
                .map(|d| d.join("Code.exe"))
                .filter(|p| p.is_file())
                .unwrap_or(cmd)
        })
        .or_else(|| {
            let local = dirs::data_local_dir()?;
            first_existing([local.join(r"Programs\Microsoft VS Code\Code.exe")])
        });
    ResolvedEnv {
        claude,
        shell,
        git,
        code,
        path: None,
    }
}

#[cfg(windows)]
fn resolve_quick() -> ResolvedEnv {
    resolve()
}

#[cfg(unix)]
fn resolve() -> ResolvedEnv {
    let shell = unix::login_shell();
    let probed = unix::probe(&shell).or_else(|| {
        let zsh = PathBuf::from("/bin/zsh");
        // fish, nu or a broken rc file can defeat the probe; zsh is on every Mac
        (shell != zsh && zsh.is_file()).then(|| unix::probe(&zsh)).flatten()
    });
    match probed {
        Some(p) => {
            let claude = p
                .claude
                .filter(|c| c.is_absolute() && c.is_file())
                .or_else(|| find_in_path(Some(&p.path), "claude"))
                .or_else(unix::claude_fallback);
            unix::finish(shell, claude, p.path)
        }
        None => {
            log::warn!("login shell probe failed; using the default PATH plus common install folders");
            resolve_quick_with(shell)
        }
    }
}

#[cfg(unix)]
fn resolve_quick() -> ResolvedEnv {
    resolve_quick_with(unix::login_shell())
}

#[cfg(unix)]
fn resolve_quick_with(shell: PathBuf) -> ResolvedEnv {
    let path = unix::fallback_path();
    let claude = find_in_path(Some(&path), "claude").or_else(unix::claude_fallback);
    unix::finish(shell, claude, path)
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    const MARK: &str = "__CM__";

    pub struct Probe {
        pub claude: Option<PathBuf>,
        pub path: OsString,
    }

    /// One string field of this user's password database entry.
    pub fn passwd_field(field: fn(&libc::passwd) -> *mut libc::c_char) -> Option<String> {
        // getpwuid returns a pointer into storage that the next getpw* call overwrites: the lock keeps
        // this app's own calls apart, and the value is copied out before it is released.
        static PASSWD: Mutex<()> = Mutex::new(());
        let _guard = lock(&PASSWD);
        // SAFETY: both pointers are checked for null and read while the lock is held.
        unsafe {
            let pw = libc::getpwuid(libc::getuid());
            if pw.is_null() {
                return None;
            }
            let value = field(&*pw);
            if value.is_null() {
                return None;
            }
            std::ffi::CStr::from_ptr(value).to_str().ok().map(str::to_string)
        }
    }

    /// The user's login shell from the password database (not $SHELL, which a parent may have changed).
    pub fn login_shell() -> PathBuf {
        passwd_field(|pw| pw.pw_shell)
            .map(PathBuf::from)
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("/bin/zsh"))
    }

    /// Runs `<shell> -ilc` so both profile and rc files are read (nvm, the native installer and most
    /// PATH edits live in ~/.zshrc, which a non-interactive login shell skips).
    pub fn probe(shell: &Path) -> Option<Probe> {
        let script = format!(r#"printf "{MARK}%s{MARK}%s{MARK}" "$(command -v claude)" "$PATH""#);
        let mut child = Command::new(shell)
            .arg("-ilc")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0) // so a timeout can end everything the rc files started
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut out = String::new();
            let _ = stdout.read_to_string(&mut out);
            out
        });
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < RESOLVE_TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    log::warn!("login shell {shell:?} did not answer within {RESOLVE_TIMEOUT:?}");
                    // SAFETY: plain syscall on the process group this function created
                    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
                    let _ = child.wait();
                    return None;
                }
            }
        }
        parse_probe(&reader.join().ok()?)
    }

    /// Reads `__CM__<claude>__CM__<PATH>__CM__`, ignoring anything rc files printed around it.
    pub fn parse_probe(out: &str) -> Option<Probe> {
        let end = out.rfind(MARK)?;
        let path_start = out[..end].rfind(MARK)?;
        let claude_start = out[..path_start].rfind(MARK)?;
        let path = &out[path_start + MARK.len()..end];
        let claude = out[claude_start + MARK.len()..path_start].trim();
        if path.is_empty() {
            return None;
        }
        Some(Probe {
            claude: (!claude.is_empty()).then(|| PathBuf::from(claude)),
            path: OsString::from(path),
        })
    }

    /// Install locations of the native installer, Homebrew, npm, Volta and Bun.
    pub fn claude_fallback() -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        first_existing([
            home.join(".local/bin/claude"),
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".npm-global/bin/claude"),
            home.join(".volta/bin/claude"),
            home.join(".bun/bin/claude"),
        ])
    }

    /// Our PATH plus the usual user and Homebrew folders, for when the shell probe fails.
    pub fn fallback_path() -> OsString {
        let mut entries: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        let home = dirs::home_dir().unwrap_or_default();
        for extra in [
            home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ] {
            if !entries.contains(&extra) {
                entries.push(extra);
            }
        }
        std::env::join_paths(entries).unwrap_or_default()
    }

    pub fn finish(shell: PathBuf, claude: Option<PathBuf>, path: OsString) -> ResolvedEnv {
        let git = find_in_path(Some(&path), "git");
        let code = find_in_path(Some(&path), "code").or_else(|| {
            first_existing([PathBuf::from(
                "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            )])
        });
        ResolvedEnv {
            claude,
            shell,
            git,
            code,
            path: Some(path),
        }
    }
}

// ---- commands ----

#[tauri::command]
pub async fn env_status(app: tauri::AppHandle) -> AppResult<EnvStatus> {
    let override_path = super::settings::get(&app).claude_path;
    super::error::blocking(move || {
        let env = wait_env();
        let shown = |p: &Option<PathBuf>| p.as_ref().map(|p| p.to_string_lossy().into_owned());
        Ok(EnvStatus {
            claude_path: claude_executable(override_path.as_deref())
                .ok()
                .map(|p| p.to_string_lossy().into_owned()),
            shell_path: env.shell.to_string_lossy().into_owned(),
            git_path: shown(&env.git),
            code_path: shown(&env.code),
        })
    })
    .await
}

#[tauri::command]
pub async fn platform_info() -> PlatformInfo {
    platform()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_session_markers_and_credentials_only() {
        for k in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
            "NO_COLOR",
        ] {
            assert!(is_stripped(k), "{k}");
        }
        for k in ["PATH", "HOME", "CLAUDE_CODE_", "ANTHROPIC_VERTEX_PROJECT", "CLAUDE"] {
            assert!(!is_stripped(k), "{k}");
        }
        assert_eq!(is_stripped("claudecode"), cfg!(windows));
    }

    #[test]
    fn finds_first_match_in_path_order() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(b.path().join("tool.exe"), b"").unwrap();
        let path = std::env::join_paths([a.path(), b.path()]).unwrap();
        assert_eq!(find_in_path(Some(&path), "tool.exe"), Some(b.path().join("tool.exe")));
        std::fs::write(a.path().join("tool.exe"), b"").unwrap();
        assert_eq!(find_in_path(Some(&path), "tool.exe"), Some(a.path().join("tool.exe")));
        assert_eq!(find_in_path(Some(&path), "missing.exe"), None);
        assert_eq!(find_in_path(None, "tool.exe"), None);
    }

    #[test]
    fn override_must_exist_and_name_claude() {
        let dir = tempfile::tempdir().unwrap();
        let name = if cfg!(windows) { "claude.exe" } else { "claude" };
        let exe = dir.path().join(name);
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(claude_executable(Some(exe.to_str().unwrap())).unwrap(), exe);
        let missing = dir.path().join("gone").join(name);
        assert!(matches!(
            claude_executable(Some(missing.to_str().unwrap())),
            Err(AppError::NotFound(_))
        ));
        // an existing file that is not claude, and a relative path, are refused before anything runs
        let other = dir.path().join(if cfg!(windows) { "calc.exe" } else { "sh" });
        std::fs::write(&other, b"").unwrap();
        for bad in [other.to_str().unwrap(), name] {
            assert!(
                matches!(claude_executable(Some(bad)), Err(AppError::InvalidInput(_))),
                "{bad}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn override_must_not_be_on_a_network_share() {
        for bad in [
            r"\\attacker\s\claude.cmd",
            r"\\?\UNC\attacker\s\claude.exe",
            r"\\.\C:\claude.exe",
            "//attacker/s/claude.cmd",
        ] {
            assert!(
                matches!(check_claude_override(bad), Err(AppError::InvalidInput(_))),
                "{bad}"
            );
        }
        assert!(check_claude_override(r"C:\Tools\claude.exe").is_ok());
        assert!(check_claude_override(r"\\?\C:\Tools\claude.exe").is_ok());
    }

    #[test]
    fn knows_the_user_name() {
        assert!(user_name().is_some_and(|n| !n.is_empty()));
    }

    #[test]
    fn batch_files_are_detected() {
        assert!(is_batch_file(Path::new(r"C:\npm\claude.cmd")));
        assert!(is_batch_file(Path::new(r"C:\x\run.BAT")));
        assert!(!is_batch_file(Path::new(r"C:\x\claude.exe")));
        assert!(!is_batch_file(Path::new("/usr/local/bin/claude")));
    }

    #[test]
    fn profile_env_is_set_only_for_non_default_profiles() {
        let home = Path::new(if cfg!(windows) { r"C:\Users\me" } else { "/Users/me" });
        let mut cmd = std::process::Command::new("x");
        apply_profile(&mut cmd, &home.join(".claude"), home);
        assert_eq!(cmd.get_envs().count(), 0);
        apply_profile(&mut cmd, &home.join(".claude-work"), home);
        let (k, v) = cmd.get_envs().next().unwrap();
        assert_eq!(k, "CLAUDE_CONFIG_DIR");
        assert_eq!(v, Some(home.join(".claude-work").as_os_str()));
    }

    #[cfg(unix)]
    #[test]
    fn parses_probe_output_around_rc_noise() {
        let p = unix::parse_probe("Welcome!\n__CM__/Users/me/.local/bin/claude__CM__/a:/b__CM__").unwrap();
        assert_eq!(p.claude, Some(PathBuf::from("/Users/me/.local/bin/claude")));
        assert_eq!(p.path, OsString::from("/a:/b"));
        let none = unix::parse_probe("__CM____CM__/usr/bin__CM__").unwrap();
        assert_eq!(none.claude, None);
        assert!(unix::parse_probe("no markers").is_none());
    }
}
