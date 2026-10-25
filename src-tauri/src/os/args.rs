//! Launch arguments: `--open <dir> [--profile <dir>]`, from the Explorer menu, a shortcut or a second
//! launch. They are untrusted: the folder must exist and the profile must be a discovered one. Anything
//! else on the command line is ignored.

use crate::core::paths;
use crate::core::profiles;
use crate::core::types::OpenRequest;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// The parser installed with `open_request::set_parser`.
pub fn parse(_app: &AppHandle, args: &[String], cwd: &Path) -> Option<OpenRequest> {
    let (open, profile) = read(args)?;
    validate(&open, profile.as_deref(), cwd, |p| profiles::resolve_profile(p).ok())
}

/// The raw `--open` and `--profile` values (also `--open=<dir>`); `None` without `--open`.
pub fn read(args: &[String]) -> Option<(String, Option<String>)> {
    let mut open = None;
    let mut profile = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let slot = match name {
            "--open" => &mut open,
            "--profile" => &mut profile,
            _ => continue,
        };
        if let Some(value) = inline.or_else(|| it.next().cloned()) {
            *slot = Some(value);
        }
    }
    Some((open?, profile))
}

/// Checks the values: `open` must be an existing folder (relative to `cwd` if not absolute). An unknown
/// profile falls back to the start profile, so a stale Explorer entry still opens the folder.
pub fn validate(
    open: &str,
    profile: Option<&str>,
    cwd: &Path,
    resolve: impl Fn(&str) -> Option<PathBuf>,
) -> Option<OpenRequest> {
    let dir = clean(open);
    if dir.is_empty() {
        log::warn!("--open without a folder");
        return None;
    }
    let dir = cwd.join(dir);
    if !dir.is_dir() {
        log::warn!("--open: not a folder: {}", dir.display());
        return None;
    }
    let profile = profile.map(clean).filter(|p| !p.is_empty()).and_then(|p| {
        let found = resolve(&p);
        if found.is_none() {
            log::warn!("--profile: unknown profile {p}; using the start profile");
        }
        found
    });
    Some(OpenRequest {
        dir: paths::norm(&dir.to_string_lossy()),
        profile: profile.map(|p| p.to_string_lossy().into_owned()),
    })
}

/// Trims spaces, and on Windows quotes. Explorer passes a drive root as `"D:\"`, and Windows argument
/// parsing reads the `\"` as a quote character, so the value arrives as `D:"`; no Windows path contains a
/// quote. A bare drive (`D:`) would mean that drive's current folder, so it becomes its root.
fn clean(value: &str) -> String {
    let value = value.trim();
    if !cfg!(windows) {
        return value.to_string();
    }
    let value = value.trim_matches('"').trim();
    let bare_drive = value.len() == 2 && value.ends_with(':') && value.as_bytes()[0].is_ascii_alphabetic();
    if bare_drive {
        format!("{value}\\")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_open_and_profile_in_any_order() {
        assert_eq!(
            read(&args(&["--profile", "P", "--open", "D"])),
            Some(("D".into(), Some("P".into())))
        );
        assert_eq!(read(&args(&["--open=D"])), Some(("D".into(), None)));
        assert_eq!(
            read(&args(&["-psn_0_123", "--open", "D", "x"])),
            Some(("D".into(), None))
        );
    }

    #[test]
    fn needs_open_with_a_value() {
        assert_eq!(read(&args(&[])), None);
        assert_eq!(read(&args(&["--profile", "P"])), None);
        assert_eq!(read(&args(&["--open"])), None);
    }

    #[test]
    fn accepts_only_existing_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("f.txt");
        std::fs::write(&file, "x").unwrap();
        let none = |_: &str| None;
        assert!(validate(&tmp.path().join("missing").to_string_lossy(), None, tmp.path(), none).is_none());
        assert!(validate(&file.to_string_lossy(), None, tmp.path(), none).is_none());
        assert!(validate("  ", None, tmp.path(), none).is_none());

        let req = validate(&tmp.path().to_string_lossy(), None, Path::new("/elsewhere"), none).unwrap();
        assert_eq!(req.dir, paths::norm(&tmp.path().to_string_lossy()));
        assert_eq!(req.profile, None);
    }

    #[test]
    fn resolves_relative_folders() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        let req = validate("sub", None, tmp.path(), |_| None).unwrap();
        assert_eq!(req.dir, paths::norm(&tmp.path().join("sub").to_string_lossy()));
    }

    #[cfg(windows)]
    #[test]
    fn repairs_what_explorer_sends_for_a_drive_root() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join("sub")).unwrap();
        let req = validate("sub\"", None, tmp.path(), |_| None).unwrap();
        assert_eq!(req.dir, paths::norm(&tmp.path().join("sub").to_string_lossy()));
        assert_eq!(clean("C:\""), "C:\\");
        let root = validate("C:\"", None, tmp.path(), |_| None).unwrap();
        assert_eq!(root.dir, "C:\\");
    }

    #[test]
    fn keeps_known_profiles_and_drops_unknown_ones() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_string_lossy().into_owned();
        let known = |p: &str| (p == "C:/known").then(|| PathBuf::from("C:/resolved"));
        let req = validate(&dir, Some("C:/known"), tmp.path(), known).unwrap();
        assert_eq!(req.profile.as_deref(), Some("C:/resolved"));
        let req = validate(&dir, Some("C:/attacker"), tmp.path(), known).unwrap();
        assert_eq!(req.profile, None);
    }

    #[test]
    fn a_real_profile_resolves_through_core() {
        let home = tempfile::tempdir().unwrap();
        let work = home.path().join(".claude-work");
        std::fs::create_dir_all(work.join("projects")).unwrap();
        let resolve = |p: &str| profiles::resolve_profile_in(p, home.path(), None).ok();
        let work_text = work.to_string_lossy();
        let req = validate(&home.path().to_string_lossy(), Some(&work_text), home.path(), resolve);
        assert_eq!(req.unwrap().profile, Some(paths::norm(&work.to_string_lossy())));
    }
}
