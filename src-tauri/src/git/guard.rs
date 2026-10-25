//! Which folders the webview may run git in or read files from.
//!
//! Git can show any file under its working tree, so it never runs in the home folder (or a folder above
//! it) or in, under or above a Claude profile folder, where the login lives. Every command except
//! `rev-parse` (which finds the repository of a sidebar folder) also needs a repository root.

use crate::core::error::{AppError, AppResult};
use crate::core::{paths, profiles};
use std::path::{Path, PathBuf};

/// The real path when it can be resolved (links, 8.3 names), else the absolute one.
fn real(p: &Path) -> PathBuf {
    p.canonicalize()
        .unwrap_or_else(|_| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()))
}

fn same_or_within(child: &Path, root: &Path) -> bool {
    paths::same(child, root) || paths::is_within(child, root)
}

/// True when git must not run in `dir`: the home folder or above it, a profile folder, a folder in or
/// above one, or a folder under a `~/.claude*` folder.
pub fn protected_in(dir: &Path, home: &Path, profile_dirs: &[PathBuf]) -> bool {
    let d = real(dir);
    let h = real(home);
    if same_or_within(&h, &d) {
        return true;
    }
    if profile_dirs
        .iter()
        .map(|p| real(p))
        .any(|p| same_or_within(&d, &p) || paths::is_within(&p, &d))
    {
        return true;
    }
    d.strip_prefix(&h)
        .ok()
        .and_then(|rest| rest.components().next())
        .is_some_and(|first| {
            first
                .as_os_str()
                .to_string_lossy()
                .to_lowercase()
                .starts_with(".claude")
        })
}

fn check(dir: &str, need_repo: bool, home: &Path, profile_dirs: &[PathBuf]) -> AppResult<PathBuf> {
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found:\n{}", path.display())));
    }
    if protected_in(&path, home, profile_dirs) {
        return Err(AppError::InvalidInput(
            "Source control is not available for your home folder or a Claude profile folder.".into(),
        ));
    }
    if need_repo && !path.join(".git").exists() {
        return Err(AppError::InvalidInput(format!(
            "Not the root of a git repository:\n{}",
            path.display()
        )));
    }
    Ok(path)
}

/// An existing folder git may run in. `need_repo`: it must also be a repository root (holds `.git`).
pub fn folder(dir: &str, need_repo: bool) -> AppResult<PathBuf> {
    let home = paths::home()?;
    let profile_dirs = profiles::discover(&home, profiles::launch_config_dir().as_deref());
    check(dir, need_repo, &home, &profile_dirs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn refuses_home_profiles_and_their_parents() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let default = home.join(".claude");
        let work = home.join(".claude-work");
        let custom = t.path().join("cfg");
        let repo = home.join("code").join("app");
        for d in [&default, &work, &custom, &repo, &default.join("projects")] {
            fs::create_dir_all(d.join(".git")).unwrap();
        }
        fs::create_dir_all(home.join(".claude-new").join(".git")).unwrap();
        let profiles = vec![default.clone(), work.clone(), custom.clone()];
        let s = |p: &Path| p.to_string_lossy().into_owned();
        for bad in [
            &home,
            t.path(),
            &default,
            &default.join("projects"),
            &work,
            &custom,
            &home.join(".claude-new"),
        ] {
            assert!(
                matches!(check(&s(bad), false, &home, &profiles), Err(AppError::InvalidInput(_))),
                "{bad:?}"
            );
        }
        assert!(check(&s(&repo), true, &home, &profiles).is_ok());
        // a folder that is not a repository root is fine for rev-parse only
        assert!(check(&s(&home.join("code")), false, &home, &profiles).is_ok());
        assert!(matches!(
            check(&s(&home.join("code")), true, &home, &profiles),
            Err(AppError::InvalidInput(_))
        ));
        assert!(matches!(
            check(&s(&home.join("gone")), false, &home, &profiles),
            Err(AppError::NotFound(_))
        ));
    }
}
