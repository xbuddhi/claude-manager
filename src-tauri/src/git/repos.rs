//! Which git repositories a sidebar folder holds: the folder itself and its sub-folders one and two levels
//! deep (a folder holding `api/` and `web/` repos). Cached briefly so switching views is instant.

use crate::core::error::lock;
use crate::core::paths;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CACHE_FOR: Duration = Duration::from_secs(30);
/// Scanning stops once more repositories than this are found.
const LIMIT: usize = 40;

type Cache = Mutex<HashMap<String, (Instant, Vec<String>)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `.git` is a folder in a normal repository and a file in a worktree or submodule.
fn has_git(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// Sub-folders by name (case-insensitive), skipping node_modules and hidden folders. Errors give none.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            name != "node_modules" && !name.starts_with('.')
        })
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
    dirs
}

/// Scans without the cache.
pub fn scan(path: &Path) -> Vec<String> {
    let mut repos = Vec::new();
    if !path.is_dir() {
        return repos;
    }
    if has_git(path) {
        repos.push(paths::norm(&path.to_string_lossy()));
    }
    for d1 in subdirs(path) {
        if has_git(&d1) {
            repos.push(d1.to_string_lossy().into_owned());
        } else {
            repos.extend(
                subdirs(&d1)
                    .into_iter()
                    .filter(|d2| has_git(d2))
                    .map(|d2| d2.to_string_lossy().into_owned()),
            );
        }
        if repos.len() > LIMIT {
            break;
        }
    }
    repos
}

/// [`scan`] with a 30 s cache keyed by the folder. Blocking: call it off the UI thread.
pub fn find(path: &str) -> Vec<String> {
    let key = paths::key(path);
    if let Some((at, list)) = lock(cache()).get(&key)
        && at.elapsed() < CACHE_FOR
    {
        return list.clone();
    }
    let list = scan(Path::new(&paths::norm(path)));
    let mut cache = lock(cache());
    cache.retain(|_, (at, _)| at.elapsed() < CACHE_FOR);
    cache.insert(key, (Instant::now(), list.clone()));
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo(dir: &Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
    }

    fn leaves(list: &[String]) -> Vec<String> {
        list.iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn finds_the_folder_and_repos_two_levels_deep() {
        let t = tempfile::tempdir().unwrap();
        let root = t.path();
        repo(root);
        repo(&root.join("b-api"));
        repo(&root.join("a-group").join("web"));
        repo(&root.join("a-group").join("docs"));
        // a worktree or submodule has a .git file
        fs::create_dir_all(root.join("c-wt")).unwrap();
        fs::write(root.join("c-wt").join(".git"), "gitdir: x").unwrap();
        // three levels is too deep; a repo inside a repo found at level 1 is not looked for
        repo(&root.join("d").join("e").join("deep"));
        repo(&root.join("b-api").join("nested"));
        // skipped folders
        repo(&root.join("node_modules").join("pkg"));
        repo(&root.join(".hidden"));
        repo(&root.join("f").join(".cache"));
        fs::write(root.join("file.txt"), "x").unwrap();

        let found = scan(root);
        assert_eq!(found[0], paths::norm(&root.to_string_lossy()));
        assert_eq!(leaves(&found[1..]), ["docs", "web", "b-api", "c-wt"]);
    }

    #[test]
    fn missing_folder_and_plain_folder_give_nothing() {
        let t = tempfile::tempdir().unwrap();
        assert!(scan(&t.path().join("gone")).is_empty());
        fs::create_dir_all(t.path().join("src")).unwrap();
        assert!(scan(t.path()).is_empty());
    }

    #[test]
    fn stops_after_forty() {
        let t = tempfile::tempdir().unwrap();
        for i in 0..50 {
            repo(&t.path().join(format!("r{i:02}")));
        }
        assert_eq!(scan(t.path()).len(), LIMIT + 1);
    }

    #[test]
    fn caches_for_a_while() {
        let t = tempfile::tempdir().unwrap();
        repo(&t.path().join("one"));
        let path = t.path().to_string_lossy().into_owned();
        assert_eq!(find(&path).len(), 1);
        repo(&t.path().join("two"));
        assert_eq!(find(&path).len(), 1, "served from the cache");
        assert_eq!(scan(t.path()).len(), 2);
    }
}
