//! Claude Code's memory files for a folder under a profile, broadest first, as Claude would load them:
//! the profile's `CLAUDE.md` and `rules/*.md`, every `CLAUDE.md` in the folders above, the folder's own
//! `CLAUDE.md` (or `.claude/CLAUDE.md`) and `CLAUDE.local.md`, the `CLAUDE.md` files of its subfolders
//! (loaded only when Claude works there), and the auto memory in `<profile>/projects/<slug>/memory/`.
//!
//! Commands take a profile (a discovered one) and a folder, never a file path to trust: reading or creating
//! a file is allowed only for a path this module lists for that pair.

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{paths, profiles};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// Largest memory file shown (they are meant to be short).
const MAX_READ: u64 = 512 * 1024;
/// How deep and how many subfolder `CLAUDE.md` files are looked for.
const SUB_DEPTH: usize = 4;
const SUB_MAX: usize = 40;
/// Folders never searched for subfolder memory: dependencies, build output, version control.
const SKIP: [&str; 8] = [
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "Pods",
    "DerivedData",
];

#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum MemoryLevel {
    /// `<profile>/CLAUDE.md`: every project under this profile.
    User,
    /// `<profile>/rules/*.md`.
    Rules,
    /// `CLAUDE.md` in a folder above this one.
    Parent,
    /// The folder's `CLAUDE.md` or `.claude/CLAUDE.md` (shared through git).
    Project,
    /// The folder's `CLAUDE.local.md` (personal, not committed).
    Local,
    /// `CLAUDE.md` in a subfolder: loaded when Claude works on files there.
    Subfolder,
    /// Auto memory Claude keeps for this folder.
    Auto,
}

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MemoryFile {
    pub level: MemoryLevel,
    pub path: String,
    pub exists: bool,
    /// Bytes; 0 when it does not exist.
    pub size: u64,
}

/// Claude Code's folder name for a project under `<profile>/projects/`: every character other than an
/// ASCII letter or digit becomes `-`.
pub fn slug(folder: &str) -> String {
    folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn file(level: MemoryLevel, path: PathBuf) -> MemoryFile {
    let meta = fs::metadata(&path).ok().filter(|m| m.is_file());
    MemoryFile {
        level,
        path: path.to_string_lossy().into_owned(),
        exists: meta.is_some(),
        size: meta.map_or(0, |m| m.len()),
    }
}

/// The `*.md` files directly in `dir`, by name.
fn markdown_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")))
        .collect();
    out.sort();
    out
}

/// `CLAUDE.md` files below `root` (not in it), breadth first, skipping hidden and build folders.
fn subfolder_memory(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut level = vec![root.to_path_buf()];
    for _ in 0..SUB_DEPTH {
        let mut next = Vec::new();
        for dir in &level {
            let Ok(entries) = fs::read_dir(dir) else { continue };
            let mut subs: Vec<PathBuf> = entries
                .flatten()
                // file_type does not follow links: a linked folder is not searched
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter(|e| {
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    !name.starts_with('.') && !SKIP.contains(&name.as_ref())
                })
                .map(|e| e.path())
                .collect();
            subs.sort();
            for sub in subs {
                let md = sub.join("CLAUDE.md");
                if md.is_file() {
                    out.push(md);
                    if out.len() >= SUB_MAX {
                        return out;
                    }
                }
                next.push(sub);
            }
        }
        level = next;
    }
    out
}

/// Every memory file for `folder` under `profile`, broadest first. Places that can hold one but do not
/// are listed too (`exists: false`) where a file is expected: the user, project, local and auto `MEMORY.md`.
pub fn list(profile: &Path, folder: &Path) -> Vec<MemoryFile> {
    use MemoryLevel::*;
    let mut out = vec![file(User, profile.join("CLAUDE.md"))];
    out.extend(markdown_in(&profile.join("rules")).into_iter().map(|p| file(Rules, p)));
    let mut parents: Vec<PathBuf> = folder
        .ancestors()
        .skip(1)
        .map(|d| d.join("CLAUDE.md"))
        .filter(|p| p.is_file())
        .collect();
    parents.reverse();
    out.extend(parents.into_iter().map(|p| file(Parent, p)));
    let dot = folder.join(".claude").join("CLAUDE.md");
    out.push(file(
        Project,
        if dot.is_file() { dot } else { folder.join("CLAUDE.md") },
    ));
    out.push(file(Local, folder.join("CLAUDE.local.md")));
    out.extend(subfolder_memory(folder).into_iter().map(|p| file(Subfolder, p)));
    let auto = profile
        .join("projects")
        .join(slug(&folder.to_string_lossy()))
        .join("memory");
    out.push(file(Auto, auto.join("MEMORY.md")));
    out.extend(
        markdown_in(&auto)
            .into_iter()
            .filter(|p| p.file_name().is_none_or(|n| n != "MEMORY.md"))
            .map(|p| file(Auto, p)),
    );
    out
}

fn resolve(profile: &str, folder: &str) -> AppResult<(PathBuf, PathBuf)> {
    let profile = profiles::resolve_profile(profile)?;
    let folder = PathBuf::from(paths::norm(folder.trim()));
    if !folder.is_absolute() || !folder.is_dir() {
        return Err(AppError::NotFound(format!(
            "This folder no longer exists:\n{}",
            folder.display()
        )));
    }
    Ok((profile, folder))
}

/// The listed entry for `path`, or an error: only those may be read or created.
fn listed(profile: &Path, folder: &Path, path: &str) -> AppResult<MemoryFile> {
    let want = Path::new(path);
    list(profile, folder)
        .into_iter()
        .find(|f| paths::same(Path::new(&f.path), want))
        .ok_or_else(|| AppError::InvalidInput(format!("Not a memory file of this folder: {path}")))
}

pub fn read(profile: &Path, folder: &Path, path: &str) -> AppResult<String> {
    let f = listed(profile, folder, path)?;
    if !f.exists {
        return Err(AppError::NotFound(format!("{path} does not exist yet.")));
    }
    if f.size > MAX_READ {
        return Err(AppError::InvalidInput(format!(
            "This file is too large to show here ({} KB). Open it in an editor.",
            f.size / 1024
        )));
    }
    Ok(fs::read_to_string(&f.path)?)
}

/// Creates a missing user, project or local `CLAUDE.md` with a heading. Rules and auto memory are Claude's
/// to write; a parent or subfolder file only shows when it exists.
pub fn create(profile: &Path, folder: &Path, path: &str) -> AppResult<()> {
    let f = listed(profile, folder, path)?;
    if f.exists {
        return Ok(());
    }
    let heading = match f.level {
        MemoryLevel::User => "# Instructions for every project",
        MemoryLevel::Project => "# Project instructions",
        MemoryLevel::Local => "# My notes for this project (not committed)",
        _ => return Err(AppError::InvalidInput("Claude Code writes this file itself.".into())),
    };
    let target = Path::new(&f.path);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    // create_new: never replace a file that appeared meanwhile
    use std::io::Write;
    let mut out = fs::OpenOptions::new().write(true).create_new(true).open(target)?;
    out.write_all(format!("{heading}\n\n").as_bytes())?;
    Ok(())
}

// ---- commands ----

/// The memory files for `folder` under `profile`, broadest first.
#[tauri::command]
pub async fn memory_files(profile: String, folder: String) -> AppResult<Vec<MemoryFile>> {
    blocking(move || {
        let (profile, folder) = resolve(&profile, &folder)?;
        Ok(list(&profile, &folder))
    })
    .await
}

/// The text of one of `memory_files`' existing files.
#[tauri::command]
pub async fn memory_read(profile: String, folder: String, path: String) -> AppResult<String> {
    blocking(move || {
        let (profile, folder) = resolve(&profile, &folder)?;
        read(&profile, &folder, &path)
    })
    .await
}

/// Creates one of `memory_files`' missing user, project or local files.
#[tauri::command]
pub async fn memory_create(profile: String, folder: String, path: String) -> AppResult<()> {
    blocking(move || {
        let (profile, folder) = resolve(&profile, &folder)?;
        create(&profile, &folder, &path)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn levels(files: &[MemoryFile]) -> Vec<(MemoryLevel, String, bool)> {
        files
            .iter()
            .map(|f| {
                (
                    f.level,
                    Path::new(&f.path).file_name().unwrap().to_string_lossy().into_owned(),
                    f.exists,
                )
            })
            .collect()
    }

    #[test]
    fn slugs_like_claude_code() {
        assert_eq!(
            slug("/Users/me/Projects/OS/claude-manager"),
            "-Users-me-Projects-OS-claude-manager"
        );
        assert_eq!(slug(r"C:\code\my app"), "C--code-my-app");
    }

    #[test]
    fn lists_every_level_broadest_first() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join(".claude");
        let repo = root.path().join("work").join("app");
        fs::create_dir_all(profile.join("rules")).unwrap();
        fs::write(profile.join("rules").join("style.md"), "x").unwrap();
        fs::create_dir_all(repo.join("src").join("ui")).unwrap();
        fs::write(root.path().join("work").join("CLAUDE.md"), "parent").unwrap();
        fs::create_dir_all(repo.join("node_modules").join("x")).unwrap();
        fs::write(repo.join("CLAUDE.md"), "project").unwrap();
        fs::write(repo.join("src").join("ui").join("CLAUDE.md"), "ui").unwrap();
        fs::write(repo.join("node_modules").join("x").join("CLAUDE.md"), "skipped").unwrap();
        let memory = profile
            .join("projects")
            .join(slug(&repo.to_string_lossy()))
            .join("memory");
        fs::create_dir_all(&memory).unwrap();
        fs::write(memory.join("MEMORY.md"), "- [a](a.md)").unwrap();
        fs::write(memory.join("a.md"), "fact").unwrap();

        let files = list(&profile, &repo);
        use MemoryLevel::*;
        assert_eq!(
            levels(&files),
            [
                (User, "CLAUDE.md".into(), false),
                (Rules, "style.md".into(), true),
                (Parent, "CLAUDE.md".into(), true),
                (Project, "CLAUDE.md".into(), true),
                (Local, "CLAUDE.local.md".into(), false),
                (Subfolder, "CLAUDE.md".into(), true),
                (Auto, "MEMORY.md".into(), true),
                (Auto, "a.md".into(), true),
            ]
        );
        assert_eq!(read(&profile, &repo, &files[3].path).unwrap(), "project");
    }

    #[test]
    fn reads_and_creates_only_listed_files() {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join(".claude");
        let repo = root.path().join("app");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("secret.txt"), "no").unwrap();
        let outside = repo.join("secret.txt").to_string_lossy().into_owned();
        assert!(read(&profile, &repo, &outside).is_err());
        assert!(create(&profile, &repo, &outside).is_err());

        let local = repo.join("CLAUDE.local.md").to_string_lossy().into_owned();
        create(&profile, &repo, &local).unwrap();
        assert!(read(&profile, &repo, &local).unwrap().starts_with("# My notes"));
        // creating again leaves it alone
        fs::write(&local, "mine").unwrap();
        create(&profile, &repo, &local).unwrap();
        assert_eq!(fs::read_to_string(&local).unwrap(), "mine");

        let auto = list(&profile, &repo)
            .into_iter()
            .find(|f| f.level == MemoryLevel::Auto)
            .unwrap();
        assert!(create(&profile, &repo, &auto.path).is_err());
    }
}
