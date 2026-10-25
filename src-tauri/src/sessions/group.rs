//! Groups sessions into project folders (MacUI.cs `Projects.Group`). Pure: the folder check is passed in.

use crate::core::paths;
use crate::core::types::{Project, Session};
use std::collections::HashMap;
use std::path::Path;

/// Name of the project that holds sessions whose transcript has no working folder.
pub const UNKNOWN_FOLDER: &str = "Unknown folder";

/// Sessions grouped by working folder (compared with `paths::key`, so case-insensitive on Windows and
/// macOS), newest first; sessions without one go to an "Unknown folder" project per transcript folder (slug).
/// Pinned folders are listed even without sessions. Projects: pinned first, then most recently active.
/// A session's `cwd` is left out when it equals its project's path (the frontend uses `cwd ?? path`).
pub fn group(sessions: Vec<Session>, pinned: &[String], is_dir: impl Fn(&str) -> bool) -> Vec<Project> {
    let mut map: HashMap<String, Project> = HashMap::new();
    for s in sessions.into_iter().filter(|s| s.count > 0) {
        let cwd = s.cwd.as_deref().map(paths::norm).filter(|c| !c.is_empty());
        let key = match &cwd {
            Some(c) => paths::key(c),
            // a separate key space: a folder path never equals it
            None => format!("\0{}", s.slug),
        };
        let p = map
            .entry(key)
            .or_insert_with(|| project(&s.slug, UNKNOWN_FOLDER.to_string()));
        // the folder is spelled as its newest session spells it
        if let Some(c) = &cwd
            && (p.sessions.is_empty() || s.modified >= p.modified)
        {
            p.path = c.clone();
            p.name = leaf(c);
        }
        p.modified = p.modified.max(s.modified);
        p.sessions.push(s);
    }
    for raw in pinned {
        let path = paths::norm(raw);
        if path.trim().is_empty() {
            continue;
        }
        map.entry(paths::key(&path))
            .or_insert_with(|| project(&path, leaf(&path)))
            .pinned = true;
    }
    let mut list: Vec<Project> = map
        .into_iter()
        .map(|(key, mut p)| {
            // the slug of an unknown folder is not a path: never look it up relative to the app's folder
            p.missing = key.starts_with('\0') || !is_dir(&p.path);
            p
        })
        .collect();
    for p in &mut list {
        p.sessions
            .sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        let path_key = paths::key(&p.path);
        for s in &mut p.sessions {
            if s.cwd.as_deref().is_some_and(|c| paths::key(c) == path_key) {
                s.cwd = None;
            }
        }
    }
    list.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.modified.cmp(&a.modified))
            .then_with(|| a.path.cmp(&b.path))
    });
    list
}

fn project(path: &str, name: String) -> Project {
    Project {
        path: path.to_string(),
        name,
        modified: 0,
        pinned: false,
        missing: false,
        sessions: Vec::new(),
    }
}

/// The folder's own name, or the whole path for a root such as `C:\` or `/`.
fn leaf(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, cwd: Option<&str>, modified: u64, count: u32) -> Session {
        Session {
            id: id.into(),
            file: format!("{id}.jsonl"),
            cwd: cwd.map(String::from),
            label: id.into(),
            full: id.into(),
            count,
            modified,
            size_kb: 1,
            profile: "p".into(),
            slug: "C--code-slug".into(),
            partial: false,
        }
    }

    fn names(list: &[Project]) -> Vec<&str> {
        list.iter().map(|p| p.name.as_str()).collect()
    }

    #[test]
    fn groups_by_folder_newest_first() {
        let list = group(
            vec![
                s("a1", Some("/code/app"), 10, 1),
                s("b1", Some("/code/lib/"), 30, 2),
                s("a2", Some("/code/app/"), 20, 1),
                s("empty", Some("/code/other"), 99, 0),
            ],
            &[],
            |_| true,
        );
        assert_eq!(names(&list), ["lib", "app"]);
        assert_eq!(list[0].path, "/code/lib");
        let app = &list[1];
        assert_eq!(app.modified, 20);
        let ids: Vec<&str> = app.sessions.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["a2", "a1"]);
        assert!(
            app.sessions.iter().all(|s| s.cwd.is_none()),
            "cwd equal to the path is left out"
        );
    }

    #[test]
    fn folder_case_follows_the_platform() {
        let list = group(
            vec![s("a", Some(r"C:\Code\App"), 1, 1), s("b", Some(r"c:\code\app\"), 2, 1)],
            &[],
            |_| true,
        );
        assert_eq!(list.len(), if cfg!(any(windows, target_os = "macos")) { 1 } else { 2 });
    }

    #[test]
    fn pinned_folders_come_first_even_when_empty() {
        let list = group(
            vec![s("a", Some("/code/app"), 50, 1), s("b", Some("/code/lib"), 10, 1)],
            &["/code/lib/".into(), "/code/new".into(), "  ".into()],
            |_| true,
        );
        assert_eq!(names(&list), ["lib", "new", "app"]);
        assert!(list[0].pinned && list[1].pinned && !list[2].pinned);
        assert!(list[1].sessions.is_empty());
        assert_eq!(list[1].modified, 0);
    }

    #[test]
    fn marks_missing_folders() {
        let list = group(
            vec![s("a", Some("/gone"), 1, 1), s("b", Some("/here"), 2, 1)],
            &[],
            |p| p == "/here",
        );
        assert_eq!(
            list.iter().map(|p| (p.name.as_str(), p.missing)).collect::<Vec<_>>(),
            [("here", false), ("gone", true)]
        );
    }

    #[test]
    fn sessions_without_a_folder_go_to_unknown_folder() {
        let mut other = s("c", None, 3, 1);
        other.slug = "other-slug".into();
        let list = group(vec![s("a", None, 1, 1), s("b", None, 2, 1), other], &[], |_| {
            panic!("an unknown folder is never looked up")
        });
        assert_eq!(names(&list), [UNKNOWN_FOLDER, UNKNOWN_FOLDER]);
        assert_eq!((list[0].path.as_str(), list[0].sessions.len()), ("other-slug", 1));
        assert_eq!((list[1].path.as_str(), list[1].sessions.len()), ("C--code-slug", 2));
        assert!(list.iter().all(|p| p.missing));
    }

    #[test]
    fn a_root_folder_is_named_by_its_path() {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        let list = group(vec![s("a", Some(root), 1, 1)], &[], |_| true);
        assert_eq!(list[0].name, root);
    }
}
