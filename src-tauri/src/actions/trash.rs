//! Moving files to the Recycle Bin (Windows) or the Trash (macOS), never deleting them outright.
//!
//! `trash_sessions` takes (profile, session id) pairs, never paths: the profile must be a discovered one and
//! the id a UUID, and every file it moves is found from those two inside that profile folder:
//! `projects/<slug>/<id>.jsonl`, then the side folders `projects/<slug>/<id>/`, `file-history/<id>/` and
//! `session-env/<id>/` when they exist. `trash_path` (untracked files in source control) takes a path that
//! must lie inside the given repository folder, outside its `.git`.

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{paths, profiles};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// One session to move to the trash.
#[derive(Deserialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrashItem {
    /// Profile folder the session belongs to.
    pub profile: String,
    pub session_id: String,
}

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrashFailure {
    pub session_id: String,
    pub message: String,
}

/// What `trash_sessions` did: the ids whose transcript went to the trash, and the ones that failed.
#[derive(Serialize, TS, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrashReport {
    pub trashed: Vec<String>,
    pub failed: Vec<TrashFailure>,
}

/// "Recycle Bin" / "Trash", for messages.
fn trash_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "Trash"
    } else {
        "Recycle Bin"
    }
}

/// A session's files in the order they go: the transcript first, then the side folders that exist.
pub fn session_files(profile: &Path, session_id: &str) -> AppResult<Vec<PathBuf>> {
    if !profiles::is_session_id(session_id) {
        return Err(AppError::InvalidInput(format!("Not a session id: {session_id}")));
    }
    let transcript = profiles::find_transcript(profile, session_id)
        .ok_or_else(|| AppError::NotFound(format!("Session not found: {session_id}")))?;
    let mut files = vec![transcript.clone()];
    let side = [
        transcript.with_file_name(session_id),
        profile.join("file-history").join(session_id),
        profile.join("session-env").join(session_id),
    ];
    // symlink_metadata: a link is moved itself, its target is left alone
    files.extend(side.into_iter().filter(|d| d.symlink_metadata().is_ok()));
    // built from a checked profile and a UUID, so this holds; checked anyway before anything moves
    if let Some(outside) = files.iter().find(|f| !paths::is_within(f, profile)) {
        return Err(AppError::InvalidInput(format!(
            "Refusing to move a file outside the profile: {}",
            outside.display()
        )));
    }
    Ok(files)
}

/// Trashes each item with `remove`; one failing item does not stop the others. `resolve` checks the profile.
pub fn trash_items(
    items: &[TrashItem],
    resolve: impl Fn(&str) -> AppResult<PathBuf>,
    remove: impl Fn(&[PathBuf]) -> AppResult<()>,
) -> TrashReport {
    let mut report = TrashReport::default();
    let mut seen = std::collections::HashSet::new();
    for item in items {
        if !seen.insert((paths::key(&item.profile), item.session_id.to_lowercase())) {
            continue;
        }
        let result = resolve(&item.profile).and_then(|profile| {
            let files = session_files(&profile, &item.session_id)?;
            let (transcript, side) = files.split_at(1);
            remove(transcript)?;
            // the session is gone once its transcript is; a side folder that stays behind is only logged
            if !side.is_empty()
                && let Err(e) = remove(side)
            {
                log::warn!("session {}: side folders were not moved: {e}", item.session_id);
            }
            Ok(())
        });
        match result {
            Ok(()) => report.trashed.push(item.session_id.clone()),
            Err(e) => report.failed.push(TrashFailure {
                session_id: item.session_id.clone(),
                message: e.to_string(),
            }),
        }
    }
    report
}

/// `path` (absolute, or relative to `root`) when it may be trashed: `root` is an existing repository folder
/// (it has `.git`), and `path` exists strictly inside it, outside `.git`, also once links are resolved.
pub fn repo_path(path: &str, root: &str) -> AppResult<PathBuf> {
    let root = PathBuf::from(root);
    if !root.is_absolute() || !root.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found\n{}", root.display())));
    }
    if root.join(".git").symlink_metadata().is_err() {
        return Err(AppError::InvalidInput(format!(
            "Not a repository folder: {}",
            root.display()
        )));
    }
    let path = root.join(path); // an absolute `path` replaces root
    let git = root.join(".git");
    if !paths::is_within(&path, &root) || paths::same(&path, &git) || paths::is_within(&path, &git) {
        return Err(AppError::InvalidInput(format!(
            "Refusing to move a file outside the repository: {}",
            path.display()
        )));
    }
    if path.symlink_metadata().is_err() {
        return Err(AppError::NotFound(format!("File not found\n{}", path.display())));
    }
    // a junction or symlinked folder on the way must not lead out of the repository
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("No parent folder".into()))?;
    let (real_parent, real_root) = (std::fs::canonicalize(parent)?, std::fs::canonicalize(&root)?);
    if !paths::same(&real_parent, &real_root) && !paths::is_within(&real_parent, &real_root) {
        return Err(AppError::InvalidInput(format!(
            "Refusing to move a file outside the repository: {}",
            path.display()
        )));
    }
    Ok(path)
}

/// Moves `files` to the OS trash on a thread of its own: on Windows the trash crate initialises COM for the
/// calling thread and panics when that thread already uses another COM mode, which a pool thread might.
fn os_trash(files: &[PathBuf]) -> AppResult<()> {
    let files = files.to_vec();
    let result = std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            // the default asks Finder through AppleScript, which needs the Automation permission
            let mut ctx = trash::TrashContext::default();
            ctx.set_delete_method(DeleteMethod::NsFileManager);
            ctx.delete_all(&files)
        }
        #[cfg(not(target_os = "macos"))]
        trash::delete_all(&files)
    })
    .join()
    .map_err(|_| AppError::Internal(format!("Moving to the {} failed.", trash_name())))?;
    result.map_err(|e| AppError::Internal(format!("Could not move it to the {}: {e}", trash_name())))
}

// ---- commands ----

/// Moves sessions (transcript and side folders) to the Recycle Bin / Trash. Per-session errors are
/// reported in the result; the list updates through the session index.
#[tauri::command]
pub async fn trash_sessions(items: Vec<TrashItem>) -> AppResult<TrashReport> {
    blocking(move || Ok(trash_items(&items, profiles::resolve_profile, os_trash))).await
}

/// Moves `path`, which must lie inside the repository folder `root`, to the Recycle Bin / Trash.
#[tauri::command]
pub async fn trash_path(path: String, root: String) -> AppResult<()> {
    blocking(move || os_trash(&[repo_path(&path, &root)?])).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ID: &str = "0b9f4c2e-1a2b-4c3d-8e9f-0123456789ab";
    const OTHER: &str = "11111111-2222-3333-4444-555555555555";

    /// A profile with one session that has every side folder, and a second session without any.
    fn profile() -> tempfile::TempDir {
        let p = tempfile::tempdir().unwrap();
        let slug = p.path().join("projects").join("C--code-app");
        fs::create_dir_all(slug.join(ID)).unwrap();
        fs::write(slug.join(format!("{ID}.jsonl")), "{}\n").unwrap();
        fs::write(slug.join(format!("{OTHER}.jsonl")), "{}\n").unwrap();
        fs::create_dir_all(p.path().join("file-history").join(ID)).unwrap();
        fs::create_dir_all(p.path().join("session-env").join(ID)).unwrap();
        p
    }

    /// Stands in for the OS trash: removes the files, so nothing lands in the real Recycle Bin.
    fn remove(files: &[PathBuf]) -> AppResult<()> {
        for f in files {
            if f.is_dir() {
                fs::remove_dir_all(f)?;
            } else {
                fs::remove_file(f)?;
            }
        }
        Ok(())
    }

    fn item(profile: &Path, id: &str) -> TrashItem {
        TrashItem {
            profile: profile.to_string_lossy().into_owned(),
            session_id: id.to_string(),
        }
    }

    #[test]
    fn finds_the_transcript_and_the_side_folders_that_exist() {
        let p = profile();
        let files = session_files(p.path(), ID).unwrap();
        assert_eq!(files.len(), 4);
        assert!(files[0].ends_with(format!("{ID}.jsonl")));
        assert_eq!(session_files(p.path(), OTHER).unwrap().len(), 1);
    }

    #[test]
    fn rejects_ids_that_are_not_uuids() {
        let p = profile();
        for bad in [
            "..",
            "../x",
            "a/b",
            "--help",
            "",
            "0b9f4c2e-1a2b-4c3d-8e9f-0123456789ab/../x",
        ] {
            assert!(
                matches!(session_files(p.path(), bad), Err(AppError::InvalidInput(_))),
                "{bad}"
            );
        }
        let missing = "99999999-2222-3333-4444-555555555555";
        assert!(matches!(session_files(p.path(), missing), Err(AppError::NotFound(_))));
    }

    #[test]
    fn trashes_sessions_and_reports_failures_per_item() {
        let p = profile();
        let resolve = |d: &str| Ok(PathBuf::from(d));
        let items = [item(p.path(), ID), item(p.path(), "not-a-uuid"), item(p.path(), ID)];
        let report = trash_items(&items, resolve, remove);
        assert_eq!(report.trashed, [ID]);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].session_id, "not-a-uuid");
        assert!(!p.path().join("file-history").join(ID).exists());
        assert!(!p.path().join("session-env").join(ID).exists());
        assert!(!p.path().join("projects").join("C--code-app").join(ID).exists());
        // the other session is untouched
        assert!(
            p.path()
                .join("projects")
                .join("C--code-app")
                .join(format!("{OTHER}.jsonl"))
                .exists()
        );
    }

    #[test]
    fn only_discovered_profiles_are_accepted() {
        let home = tempfile::tempdir().unwrap();
        let known = home.path().join(".claude-work");
        fs::create_dir_all(known.join("projects").join("slug")).unwrap();
        fs::write(known.join("projects").join("slug").join(format!("{ID}.jsonl")), "{}").unwrap();
        // a folder that looks like a profile but is not one of the discovered ones
        let stranger = tempfile::tempdir().unwrap();
        fs::create_dir_all(stranger.path().join("projects").join("slug")).unwrap();
        let victim = stranger
            .path()
            .join("projects")
            .join("slug")
            .join(format!("{ID}.jsonl"));
        fs::write(&victim, "{}").unwrap();

        let resolve = |d: &str| profiles::resolve_profile_in(d, home.path(), None);
        let report = trash_items(&[item(stranger.path(), ID)], resolve, remove);
        assert!(report.trashed.is_empty());
        assert!(report.failed[0].message.starts_with("Unknown profile"));
        assert!(victim.exists());

        let report = trash_items(&[item(&known, ID)], resolve, remove);
        assert_eq!(report.trashed, [ID]);
    }

    #[test]
    fn a_failing_transcript_keeps_its_side_folders() {
        let p = profile();
        let resolve = |d: &str| Ok(PathBuf::from(d));
        let fail = |_: &[PathBuf]| Err(AppError::Internal("no trash here".into()));
        let report = trash_items(&[item(p.path(), ID)], resolve, fail);
        assert_eq!(report.failed[0].message, "no trash here");
        assert!(p.path().join("file-history").join(ID).exists());
    }

    fn repo() -> tempfile::TempDir {
        let r = tempfile::tempdir().unwrap();
        fs::create_dir_all(r.path().join(".git")).unwrap();
        fs::create_dir_all(r.path().join("src")).unwrap();
        fs::write(r.path().join("src").join("new.txt"), "x").unwrap();
        fs::write(r.path().join(".git").join("config"), "x").unwrap();
        r
    }

    #[test]
    fn repo_paths_must_stay_inside_the_repository() {
        let r = repo();
        let root = r.path().to_string_lossy().into_owned();
        let inside = r.path().join("src").join("new.txt");
        assert_eq!(repo_path(&inside.to_string_lossy(), &root).unwrap(), inside);
        // relative to the repository, as git status prints it
        assert_eq!(repo_path("src/new.txt", &root).unwrap(), r.path().join("src/new.txt"));

        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), "x").unwrap();
        for bad in [
            outside.path().join("keep.txt").to_string_lossy().into_owned(),
            "../keep.txt".into(),
            "src/../../keep.txt".into(),
            ".git".into(),
            ".git/config".into(),
            root.clone(),
        ] {
            assert!(repo_path(&bad, &root).is_err(), "{bad}");
        }
        assert!(matches!(
            repo_path("src/missing.txt", &root),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn repo_root_must_be_an_existing_repository() {
        let plain = tempfile::tempdir().unwrap();
        fs::write(plain.path().join("a.txt"), "x").unwrap();
        let root = plain.path().to_string_lossy().into_owned();
        assert!(matches!(repo_path("a.txt", &root), Err(AppError::InvalidInput(_))));
        assert!(matches!(
            repo_path("a.txt", "relative/root"),
            Err(AppError::NotFound(_))
        ));
        let gone = plain.path().join("gone").to_string_lossy().into_owned();
        assert!(matches!(repo_path("a.txt", &gone), Err(AppError::NotFound(_))));
    }
}
