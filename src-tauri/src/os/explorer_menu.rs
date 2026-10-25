//! The Explorer right-click menu (Windows): "Open Claude Code here" > "Profile: <name>" on folders and
//! folder backgrounds, written to HKCU only (no admin rights). Each entry runs this app with
//! `--profile <dir> --open <folder>`; the single-instance hook hands that to the running app.
//!
//! The key names are the ones the Windows PowerShell app used, so its menu is detected and replaced by
//! install and removed by remove. While our menu is installed it is rewritten when the profiles change
//! and at startup (the app may have moved). The NSIS uninstaller removes it (`windows/uninstall-hooks.nsh`).
//! macOS has no such menu: the commands fail there and the UI hides the item.

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::paths;
use crate::core::types::Profile;
use std::path::Path;
use tauri::AppHandle;

/// Under HKCU: folders, and the background of an open folder.
pub const KEYS: [&str; 2] = [
    r"Software\Classes\Directory\shell\ClaudeCode",
    r"Software\Classes\Directory\Background\shell\ClaudeCode",
];
const VERB: &str = "Open Claude Code here";

/// A registry key to create under HKCU, with its string values ("" names the default value).
#[derive(Debug, PartialEq, Eq)]
pub struct RegEntry {
    pub path: String,
    pub values: Vec<(&'static str, String)>,
}

/// Every key the menu needs, for the app at `exe`: a cascading verb per root key, one sub entry per profile.
pub fn entries(exe: &Path, profiles: &[Profile]) -> Vec<RegEntry> {
    let exe = exe.to_string_lossy();
    let mut out = Vec::new();
    for key in KEYS {
        out.push(RegEntry {
            path: key.to_string(),
            values: vec![
                ("MUIVerb", VERB.to_string()),
                ("SubCommands", String::new()),
                ("Icon", format!("{exe},0")),
            ],
        });
        for (i, profile) in profiles.iter().enumerate() {
            let sub = format!(r"{key}\shell\{i:02}");
            out.push(RegEntry {
                path: sub.clone(),
                values: vec![("MUIVerb", format!("Profile: {}", profile.name))],
            });
            out.push(RegEntry {
                path: format!(r"{sub}\command"),
                values: vec![("", command_line(&exe, &profile.dir))],
            });
        }
    }
    out
}

/// `"<exe>" --profile "<dir>" --open "%V"`. The folder goes last: for a drive root Explorer passes `D:\`,
/// whose `\"` Windows reads as a quote, and at the end that only leaves a stray quote the argument
/// parser removes (`args.rs`).
pub fn command_line(exe: &str, profile_dir: &str) -> String {
    format!("\"{exe}\" --profile \"{}\" --open \"%V\"", paths::norm(profile_dir))
}

/// Whether an installed menu is this app's (the PowerShell app's ran pwsh instead).
pub fn is_ours(command: &str) -> bool {
    command.contains(" --open ")
}

/// While our menu is installed, keeps it pointing at this exe and listing the current profiles.
pub fn keep_current(app: &AppHandle) {
    imp::keep_current(app);
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::core::events;
    use crate::core::profiles::Profiles;
    use std::io::{self, ErrorKind};
    use tauri::{Listener, Manager};
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    fn hkcu() -> RegKey {
        RegKey::predef(HKEY_CURRENT_USER)
    }

    pub fn state() -> AppResult<bool> {
        Ok(hkcu().open_subkey(KEYS[0]).is_ok())
    }

    /// Replaces whatever is there (an older or the PowerShell app's menu) with ours.
    pub fn install(app: &AppHandle) -> AppResult<()> {
        let exe = std::env::current_exe()?;
        let profiles = app.state::<Profiles>().list()?;
        write(&entries(&exe, &profiles))
            .map_err(|e| AppError::Internal(format!("Could not add the Explorer menu: {e}")))
    }

    pub fn remove() -> AppResult<()> {
        delete().map_err(|e| AppError::Internal(format!("Could not remove the Explorer menu: {e}")))
    }

    pub fn keep_current(app: &AppHandle) {
        let refresh = |app: AppHandle| {
            tauri::async_runtime::spawn_blocking(move || {
                if first_command().is_some_and(|c| is_ours(&c))
                    && let Err(e) = install(&app)
                {
                    log::warn!("could not update the Explorer menu: {e}");
                }
            });
        };
        refresh(app.clone());
        let handle = app.clone();
        app.listen(events::PROFILES_CHANGED, move |_| refresh(handle.clone()));
    }

    /// The first entry's command, when the menu is installed.
    fn first_command() -> Option<String> {
        let key = hkcu().open_subkey(format!(r"{}\shell\00\command", KEYS[0])).ok()?;
        key.get_value::<String, _>("").ok()
    }

    fn delete() -> io::Result<()> {
        for key in KEYS {
            match hkcu().delete_subkey_all(key) {
                Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        Ok(())
    }

    fn write(entries: &[RegEntry]) -> io::Result<()> {
        delete()?;
        let root = hkcu();
        for entry in entries {
            let (key, _) = root.create_subkey(&entry.path)?;
            for (name, value) in &entry.values {
                key.set_value(name, value)?;
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    fn unsupported() -> AppError {
        AppError::InvalidInput("The Explorer menu exists only on Windows.".into())
    }

    pub fn state() -> AppResult<bool> {
        Err(unsupported())
    }

    pub fn install(_app: &AppHandle) -> AppResult<()> {
        Err(unsupported())
    }

    pub fn remove() -> AppResult<()> {
        Err(unsupported())
    }

    pub fn keep_current(_app: &AppHandle) {}
}

// ---- commands ----

/// Whether the menu is installed (ours or the PowerShell app's).
#[tauri::command]
pub async fn explorer_menu_state() -> AppResult<bool> {
    blocking(imp::state).await
}

#[tauri::command]
pub async fn explorer_menu_install(app: AppHandle) -> AppResult<()> {
    blocking(move || imp::install(&app)).await
}

#[tauri::command]
pub async fn explorer_menu_remove() -> AppResult<()> {
    blocking(imp::remove).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(dir: &str, name: &str) -> Profile {
        Profile {
            dir: dir.into(),
            name: name.into(),
            email: None,
            signed_in: None,
            is_default: name == "default",
        }
    }

    #[test]
    fn builds_one_cascade_per_root_key() {
        let exe = Path::new(r"C:\Program Files\Claude Manager\claude-manager.exe");
        let list = entries(
            exe,
            &[
                profile(r"C:\Users\me\.claude", "default"),
                profile(r"C:\Users\me\.claude-work", "work"),
            ],
        );
        assert_eq!(list.len(), 2 * 5);
        assert_eq!(
            list[0],
            RegEntry {
                path: r"Software\Classes\Directory\shell\ClaudeCode".into(),
                values: vec![
                    ("MUIVerb", "Open Claude Code here".into()),
                    ("SubCommands", String::new()),
                    ("Icon", r"C:\Program Files\Claude Manager\claude-manager.exe,0".into()),
                ],
            }
        );
        assert_eq!(
            list[3],
            RegEntry {
                path: r"Software\Classes\Directory\shell\ClaudeCode\shell\01".into(),
                values: vec![("MUIVerb", "Profile: work".into())],
            }
        );
        assert_eq!(
            list[4],
            RegEntry {
                path: r"Software\Classes\Directory\shell\ClaudeCode\shell\01\command".into(),
                values: vec![(
                    "",
                    r#""C:\Program Files\Claude Manager\claude-manager.exe" --profile "C:\Users\me\.claude-work" --open "%V""#
                        .into()
                )],
            }
        );
        assert_eq!(list[5].path, r"Software\Classes\Directory\Background\shell\ClaudeCode");
        assert!(list.iter().all(|e| e.path.starts_with(r"Software\Classes\Directory\")));
    }

    #[test]
    fn command_line_has_no_trailing_backslash_before_a_quote() {
        assert_eq!(
            command_line(r"C:\a.exe", r"C:\Users\me\.claude\"),
            r#""C:\a.exe" --profile "C:\Users\me\.claude" --open "%V""#
        );
    }

    #[test]
    fn tells_our_menu_from_the_powershell_one() {
        assert!(is_ours(&command_line(r"C:\a.exe", r"C:\p")));
        let legacy = r#""C:\pwsh.exe" -NoExit -NoLogo -WorkingDirectory "%V" -Command "claude""#;
        assert!(!is_ours(legacy));
    }

    #[test]
    fn two_digit_entry_names_keep_profiles_in_order() {
        let many: Vec<Profile> = (0..12)
            .map(|i| profile(&format!(r"C:\p{i}"), &format!("p{i}")))
            .collect();
        let list = entries(Path::new(r"C:\a.exe"), &many);
        assert!(list.iter().any(|e| e.path.ends_with(r"shell\ClaudeCode\shell\11")));
    }
}
