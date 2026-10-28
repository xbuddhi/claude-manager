//! The Files view: the folder selected in the sidebar as a tree, its files read for the preview, and plain
//! file operations inside it (new file or folder, rename and move, duplicate, move to the trash).
//!
//! Every command takes the folder (`root`) and paths relative to it with plain names only. The root is an
//! existing folder that is not the home folder, above it, or a Claude profile folder (the same rule as source
//! control), and no path may name `.git` or lead out of the root through a link.

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{paths, profiles};
use crate::git::files::NewFile;
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use ts_rs::TS;

/// Entries listed of one folder; the rest are counted in `more`.
const MAX_ENTRIES: usize = 3000;

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEntry {
    pub name: String,
    /// A folder, or a link to one.
    pub dir: bool,
    pub link: bool,
    /// Matched by `.gitignore` (or `.ignore`); listed only when asked for.
    pub ignored: bool,
    /// Bytes; 0 for a folder.
    pub size: u64,
}

#[derive(Serialize, TS, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FolderListing {
    /// Folders first, then files, by name.
    pub entries: Vec<FileEntry>,
    /// Entries left out over the limit.
    pub more: u32,
}

/// The real path when it can be resolved (links, 8.3 names), else the path itself.
fn real(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

fn same_or_within(child: &Path, root: &Path) -> bool {
    paths::same(child, root) || paths::is_within(child, root)
}

fn check_root(dir: &str, home: &Path, profile_dirs: &[PathBuf]) -> AppResult<PathBuf> {
    let path = PathBuf::from(paths::norm(dir.trim()));
    if !path.is_absolute() || !path.is_dir() {
        return Err(AppError::NotFound(format!(
            "This folder no longer exists:\n{}",
            path.display()
        )));
    }
    if crate::git::guard::protected_in(&path, home, profile_dirs) {
        return Err(AppError::InvalidInput(
            "Files are not shown for your home folder or a Claude profile folder.".into(),
        ));
    }
    Ok(path)
}

/// The folder the webview asked for, when it may be shown.
fn root(dir: &str) -> AppResult<PathBuf> {
    let home = paths::home()?;
    let profile_dirs = profiles::discover_cached(&home, profiles::launch_config_dir().as_deref());
    check_root(dir, &home, &profile_dirs)
}

/// True for `.git`, also as Windows reads it (trailing dots and spaces dropped, any case).
fn is_git(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy()
        .trim_end_matches(['.', ' '])
        .eq_ignore_ascii_case(".git")
}

/// `rel` under `root` when it stays there: a non-empty path of plain names, none of them `.git`, whose
/// folder (and with `follow` the path itself, once links are resolved) is inside `root`. The path need not
/// exist; its folder must.
fn inside(root: &Path, rel: &str, follow: bool) -> AppResult<PathBuf> {
    let refuse = || AppError::InvalidInput(format!("Not a path inside this folder: {rel}"));
    let p = Path::new(rel);
    if rel.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(refuse());
    }
    if p.components().any(|c| is_git(c.as_os_str())) {
        return Err(AppError::InvalidInput("The .git folder is left to git.".into()));
    }
    let full = root.join(p);
    let real_root = real(root);
    let parent = full.parent().ok_or_else(refuse)?;
    let Ok(real_parent) = parent.canonicalize() else {
        return Err(AppError::NotFound(format!("Folder not found:\n{}", parent.display())));
    };
    if !same_or_within(&real_parent, &real_root) {
        return Err(refuse());
    }
    if follow
        && let Ok(real_full) = full.canonicalize()
        && !same_or_within(&real_full, &real_root)
    {
        return Err(refuse());
    }
    Ok(full)
}

/// One name for a new file or folder: not empty, no separators, not `.` or `..`.
fn check_name(name: &str) -> AppResult<()> {
    let bad = name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\']);
    if bad {
        return Err(AppError::InvalidInput(format!("Not a valid name: {name}")));
    }
    Ok(())
}

fn exists(p: &Path) -> bool {
    p.symlink_metadata().is_ok()
}

fn already(name: &Path) -> AppError {
    AppError::InvalidInput(format!(
        "{} already exists here.",
        name.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/// The names in `dir` that `.gitignore`, `.ignore` and git's excludes leave in.
fn kept_names(dir: &Path) -> HashSet<OsString> {
    ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .build()
        .flatten()
        .filter(|e| e.depth() == 1)
        .map(|e| e.file_name().to_os_string())
        .collect()
}

/// The entries of `rel` (`""` = the root), without `.git`; ignored ones only with `show_ignored`.
pub fn list(root: &Path, rel: &str, show_ignored: bool) -> AppResult<FolderListing> {
    let dir = if rel.is_empty() {
        root.to_path_buf()
    } else {
        inside(root, rel, true)?
    };
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found:\n{}", dir.display())));
    }
    let kept = kept_names(&dir);
    let mut entries: Vec<FileEntry> = fs::read_dir(&dir)?
        .flatten()
        .filter(|e| !is_git(&e.file_name()))
        .filter_map(|e| {
            let ignored = !kept.contains(&e.file_name());
            if ignored && !show_ignored {
                return None;
            }
            let kind = e.file_type().ok();
            let link = kind.is_some_and(|t| t.is_symlink());
            // a link is followed, so a link to a folder opens like one; anything else uses the entry's own data
            let meta = if kind.is_none() || link {
                fs::metadata(e.path()).ok()
            } else {
                e.metadata().ok()
            };
            let dir = meta.as_ref().is_some_and(|m| m.is_dir());
            Some(FileEntry {
                name: e.file_name().to_string_lossy().into_owned(),
                dir,
                link,
                ignored,
                size: if dir { 0 } else { meta.map_or(0, |m| m.len()) },
            })
        })
        .collect();
    // folders first, then by name ignoring case (each name lowered once)
    entries.sort_by_cached_key(|e| (!e.dir, e.name.to_lowercase(), e.name.clone()));
    let more = entries.len().saturating_sub(MAX_ENTRIES) as u32;
    entries.truncate(MAX_ENTRIES);
    Ok(FolderListing { entries, more })
}

/// A file's text for the preview (at most 20,000 lines; over 2 MB or binary is reported as such).
pub fn read(root: &Path, rel: &str) -> AppResult<NewFile> {
    inside(root, rel, true)?;
    crate::git::files::read_in(&root.to_string_lossy(), rel)
}

/// Creates an empty file or a folder at `rel`; never replaces anything.
pub fn create(root: &Path, rel: &str, folder: bool) -> AppResult<()> {
    let target = inside(root, rel, false)?;
    check_name(&target.file_name().unwrap_or_default().to_string_lossy())?;
    if exists(&target) {
        return Err(already(&target));
    }
    if folder {
        fs::create_dir(&target)?;
    } else {
        fs::OpenOptions::new().write(true).create_new(true).open(&target)?;
    }
    Ok(())
}

/// Renames or moves `from` to `to`, both inside the root. Never replaces anything, except that a name may
/// change only in case on a file system that ignores case.
pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let src = inside(root, from, false)?;
    let dst = inside(root, to, false)?;
    check_name(&dst.file_name().unwrap_or_default().to_string_lossy())?;
    if !exists(&src) {
        return Err(AppError::NotFound(format!("{from} no longer exists.")));
    }
    if src == dst {
        return Ok(());
    }
    if paths::is_within(&dst, &src) {
        return Err(AppError::InvalidInput("A folder cannot move into itself.".into()));
    }
    // the same file under another case of its name
    let case_only = paths::same(&src, &dst) && real(&src) == real(&dst);
    if exists(&dst) && !case_only {
        return Err(already(&dst));
    }
    fs::rename(&src, &dst)?;
    Ok(())
}

/// `name` with " copy" (then " copy 2", ...) before its extension.
pub fn copy_name(name: &str, n: u32) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => name.split_at(i),
        _ => (name, ""),
    };
    if n < 2 {
        format!("{stem} copy{ext}")
    } else {
        format!("{stem} copy {n}{ext}")
    }
}

/// Copies the file `rel` next to itself as "name copy.ext"; returns the copy's relative path.
pub fn duplicate(root: &Path, rel: &str) -> AppResult<String> {
    let src = inside(root, rel, true)?;
    if !src.is_file() {
        return Err(AppError::InvalidInput("Only files can be duplicated.".into()));
    }
    let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let parent = Path::new(rel).parent().unwrap_or(Path::new(""));
    for n in 1..1000 {
        let copy = copy_name(&name, n);
        let dst = src.with_file_name(&copy);
        // create_new: a name taken meanwhile is skipped, never replaced
        let mut out = match fs::OpenOptions::new().write(true).create_new(true).open(&dst) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        };
        std::io::copy(&mut fs::File::open(&src)?, &mut out)?;
        let rel = parent.join(copy);
        return Ok(rel.to_string_lossy().replace('\\', "/"));
    }
    Err(AppError::InvalidInput(format!("Too many copies of {name}.")))
}

/// The file or folder `rel` when it may go to the trash.
pub fn trash_target(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let target = inside(root, rel, false)?;
    if !exists(&target) {
        return Err(AppError::NotFound(format!("{rel} no longer exists.")));
    }
    Ok(target)
}

// ---- commands ----

/// The entries of the folder `dir` (relative; `""` = the root) of `root`.
#[tauri::command]
pub async fn files_list(root: String, dir: String, ignored: bool) -> AppResult<FolderListing> {
    blocking(move || list(&self::root(&root)?, &dir, ignored)).await
}

/// The text of the file `path` of `root`, for the preview.
#[tauri::command]
pub async fn files_read(root: String, path: String) -> AppResult<NewFile> {
    blocking(move || read(&self::root(&root)?, &path)).await
}

/// Creates an empty file, or a folder with `folder`, at `path` of `root`.
#[tauri::command]
pub async fn files_create(root: String, path: String, folder: bool) -> AppResult<()> {
    blocking(move || create(&self::root(&root)?, &path, folder)).await
}

/// Renames or moves `from` to `to` inside `root`.
#[tauri::command]
pub async fn files_rename(root: String, from: String, to: String) -> AppResult<()> {
    blocking(move || rename(&self::root(&root)?, &from, &to)).await
}

/// Copies the file `path` next to itself; returns the copy's path.
#[tauri::command]
pub async fn files_duplicate(root: String, path: String) -> AppResult<String> {
    blocking(move || duplicate(&self::root(&root)?, &path)).await
}

/// Moves `path` of `root` to the Recycle Bin / Trash.
#[tauri::command]
pub async fn files_trash(root: String, path: String) -> AppResult<()> {
    blocking(move || crate::actions::trash::os_trash(&[trash_target(&self::root(&root)?, &path)?])).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(l: &FolderListing) -> Vec<(&str, bool, bool)> {
        l.entries.iter().map(|e| (e.name.as_str(), e.dir, e.ignored)).collect()
    }

    #[test]
    fn lists_folders_first_and_hides_ignored_and_git() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::create_dir_all(r.join("src")).unwrap();
        fs::create_dir_all(r.join("node_modules").join("x")).unwrap();
        fs::write(r.join(".gitignore"), "node_modules\n*.log\n").unwrap();
        fs::write(r.join("b.txt"), "b").unwrap();
        fs::write(r.join("A.md"), "a").unwrap();
        fs::write(r.join("debug.log"), "x").unwrap();
        assert_eq!(
            names(&list(r, "", false).unwrap()),
            [
                ("src", true, false),
                (".gitignore", false, false),
                ("A.md", false, false),
                ("b.txt", false, false)
            ]
        );
        let all = list(r, "", true).unwrap();
        assert!(names(&all).contains(&("node_modules", true, true)));
        assert!(names(&all).contains(&("debug.log", false, true)));
        assert!(!names(&all).iter().any(|e| e.0 == ".git"));
        assert_eq!(list(r, "src", false).unwrap(), FolderListing::default());
    }

    #[test]
    fn refuses_paths_out_of_the_root_and_into_git() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path().join("repo");
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::write(t.path().join("secret.txt"), "x").unwrap();
        let outside = t.path().join("secret.txt");
        for bad in [
            "",
            "../secret.txt",
            "a/../../secret.txt",
            outside.to_str().unwrap(),
            ".git/config",
            ".GIT",
        ] {
            assert!(matches!(inside(&r, bad, true), Err(AppError::InvalidInput(_))), "{bad}");
        }
        assert!(read(&r, "../secret.txt").is_err());
        assert!(create(&r, ".git/x", false).is_err());
        assert!(trash_target(&r, ".git").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_root_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path().join("repo");
        fs::create_dir_all(&r).unwrap();
        fs::create_dir_all(t.path().join("out")).unwrap();
        fs::write(t.path().join("out").join("s.txt"), "x").unwrap();
        std::os::unix::fs::symlink(t.path().join("out"), r.join("link")).unwrap();
        assert!(list(&r, "link", false).is_err());
        assert!(read(&r, "link/s.txt").is_err());
        assert!(create(&r, "link/new.txt", false).is_err());
        // the link itself may still be renamed or trashed
        rename(&r, "link", "link2").unwrap();
        assert!(trash_target(&r, "link2").is_ok());
    }

    #[test]
    fn creates_renames_and_duplicates_without_replacing() {
        let t = tempfile::tempdir().unwrap();
        let r = t.path();
        create(r, "src", true).unwrap();
        create(r, "src/a.ts", false).unwrap();
        fs::write(r.join("src").join("a.ts"), "one").unwrap();
        assert!(create(r, "src/a.ts", false).is_err());
        assert!(create(r, "src", true).is_err());
        assert!(create(r, "missing/a.ts", false).is_err());

        assert_eq!(duplicate(r, "src/a.ts").unwrap(), "src/a copy.ts");
        assert_eq!(duplicate(r, "src/a.ts").unwrap(), "src/a copy 2.ts");
        assert_eq!(fs::read_to_string(r.join("src").join("a copy 2.ts")).unwrap(), "one");
        assert!(duplicate(r, "src").is_err());

        assert!(rename(r, "src/a.ts", "src/a copy.ts").is_err());
        rename(r, "src/a.ts", "b.ts").unwrap();
        assert!(r.join("b.ts").is_file());
        assert!(rename(r, "src", "src/inner").is_err());
        create(r, "lib", true).unwrap();
        rename(r, "src", "lib/src").unwrap();
        assert!(r.join("lib").join("src").join("a copy.ts").is_file());
        assert!(rename(r, "gone.ts", "x.ts").is_err());
        assert!(rename(r, "b.ts", "lib/../x.ts").is_err());
    }

    #[test]
    fn names_copies_before_the_extension() {
        assert_eq!(copy_name("a.ts", 1), "a copy.ts");
        assert_eq!(copy_name("a.test.ts", 3), "a.test copy 3.ts");
        assert_eq!(copy_name(".env", 1), ".env copy");
        assert_eq!(copy_name("Makefile", 2), "Makefile copy 2");
    }

    #[test]
    fn the_root_must_not_be_home_or_a_profile() {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().join("home");
        let profile = home.join(".claude");
        let work = home.join("work");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&work).unwrap();
        let profiles = [profile.clone()];
        assert!(check_root(&work.to_string_lossy(), &home, &profiles).is_ok());
        for bad in [&home, &profile, t.path()] {
            assert!(
                check_root(&bad.to_string_lossy(), &home, &profiles).is_err(),
                "{}",
                bad.display()
            );
        }
        assert!(matches!(
            check_root(&home.join("gone").to_string_lossy(), &home, &profiles),
            Err(AppError::NotFound(_))
        ));
    }
}
