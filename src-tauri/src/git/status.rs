//! `git status --porcelain=v1 -b -z --untracked-files=all`, parsed into the two lists the view shows.

use serde::Serialize;
use ts_rs::TS;

/// One file in STAGED CHANGES or CHANGES.
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitChange {
    /// Path relative to the repository, with `/` as git prints it.
    pub path: String,
    /// File name.
    pub name: String,
    /// Folder part with this OS's separator; empty at the top level.
    pub dir: String,
    /// Status letter: M, A, D, R, C, T, U (untracked) or ! (merge conflict).
    pub status: String,
}

#[derive(Serialize, TS, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitStatus {
    /// Current branch ("HEAD (no branch)" when detached, as git prints it).
    pub branch: String,
    /// Upstream branch (e.g. "origin/main"); null when the branch is not published.
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitChange>,
    pub changes: Vec<GitChange>,
}

pub const ARGS: &[&str] = &["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"];

fn change(path: &str, status: &str) -> GitChange {
    let (dir, name) = match path.rsplit_once('/') {
        Some((dir, name)) => (dir, name),
        None => ("", path),
    };
    let sep = if cfg!(windows) { "\\" } else { "/" };
    GitChange {
        path: path.to_string(),
        name: name.to_string(),
        dir: dir.replace('/', sep),
        status: status.to_string(),
    }
}

/// Reads the `## ` header: "main...origin/main [ahead 1, behind 2]", "No commits yet on main", "HEAD (no branch)".
fn header(line: &str, out: &mut GitStatus) {
    let (refs, counts) = match line.rfind(" [") {
        Some(i) if line.ends_with(']') => (&line[..i], &line[i + 2..line.len() - 1]),
        _ => (line, ""),
    };
    let (branch, upstream) = match refs.split_once("...") {
        Some((b, u)) => (b, Some(u.to_string())),
        None => (refs, None),
    };
    out.branch = branch
        .strip_prefix("No commits yet on ")
        .or_else(|| branch.strip_prefix("Initial commit on "))
        .unwrap_or(branch)
        .to_string();
    out.upstream = upstream;
    for part in counts.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            out.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            out.behind = n.parse().unwrap_or(0);
        }
    }
}

/// Parses NUL-separated porcelain v1 output.
pub fn parse(out: &str) -> GitStatus {
    let mut status = GitStatus::default();
    let mut entries = out.split('\0');
    while let Some(e) = entries.next() {
        if e.len() < 3 || !e.is_char_boundary(2) || !e.is_char_boundary(3) {
            continue;
        }
        if let Some(line) = e.strip_prefix("## ") {
            header(line, &mut status);
            continue;
        }
        let (xy, path) = (&e[..2], &e[3..]);
        let (x, y) = (&xy[..1], &xy[1..]);
        // a rename or copy is followed by its old name
        if matches!(x, "R" | "C") || matches!(y, "R" | "C") {
            entries.next();
        }
        if xy == "??" {
            status.changes.push(change(path, "U"));
        } else if xy == "!!" {
            continue; // ignored files (not asked for)
        } else if xy.contains('U') || xy == "AA" || xy == "DD" {
            status.changes.push(change(path, "!"));
        } else {
            if x != " " {
                status.staged.push(change(path, x));
            }
            if y != " " {
                status.changes.push(change(path, y));
            }
        }
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[GitChange]) -> Vec<(String, String)> {
        list.iter().map(|c| (c.path.clone(), c.status.clone())).collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn branch_upstream_and_counts() {
        let s = parse("## main...origin/main [ahead 1, behind 2]\0");
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (1, 2));
        let s = parse("## feature/x...origin/feature/x [behind 7]\0");
        assert_eq!((s.branch.as_str(), s.ahead, s.behind), ("feature/x", 0, 7));
        let s = parse("## main...origin/main\0");
        assert_eq!((s.upstream.is_some(), s.ahead, s.behind), (true, 0, 0));
        let s = parse("## topic\0");
        assert_eq!((s.branch.as_str(), s.upstream), ("topic", None));
    }

    #[test]
    fn unborn_and_detached_heads() {
        let s = parse("## No commits yet on main\0?? a.txt\0");
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream, None);
        assert_eq!(names(&s.changes), pairs(&[("a.txt", "U")]));
        assert_eq!(parse("## HEAD (no branch)\0").branch, "HEAD (no branch)");
    }

    #[test]
    fn rename_with_z_skips_the_old_name() {
        let s = parse("## main\0R  src/new name.rs\0src/old name.rs\0 M b.txt\0");
        assert_eq!(names(&s.staged), pairs(&[("src/new name.rs", "R")]));
        assert_eq!(names(&s.changes), pairs(&[("b.txt", "M")]));
        let r = &s.staged[0];
        assert_eq!(r.name, "new name.rs");
        assert_eq!(r.dir, "src");
        // a copy as well, and a rename that is also changed in the working tree
        let s = parse("C  b\0a\0RM c\0d\0");
        assert_eq!(names(&s.staged), pairs(&[("b", "C"), ("c", "R")]));
        assert_eq!(names(&s.changes), pairs(&[("c", "M")]));
    }

    #[test]
    fn untracked_files_with_folders() {
        let s = parse("?? docs/guide/intro.md\0?? ünï cödé.txt\0");
        assert_eq!(
            names(&s.changes),
            pairs(&[("docs/guide/intro.md", "U"), ("ünï cödé.txt", "U")])
        );
        let sep = if cfg!(windows) { "\\" } else { "/" };
        assert_eq!(s.changes[0].dir, format!("docs{sep}guide"));
        assert_eq!(s.changes[0].name, "intro.md");
        assert_eq!(s.changes[1].dir, "");
        assert!(s.staged.is_empty());
    }

    #[test]
    fn conflicts_go_to_changes_only() {
        let s = parse("AA both.txt\0UU merge.txt\0DD gone.txt\0AU x\0UD y\0");
        assert!(s.staged.is_empty());
        assert_eq!(
            names(&s.changes),
            pairs(&[
                ("both.txt", "!"),
                ("merge.txt", "!"),
                ("gone.txt", "!"),
                ("x", "!"),
                ("y", "!")
            ])
        );
    }

    #[test]
    fn a_file_can_be_staged_and_changed() {
        let s = parse("MM both.txt\0A  new.txt\0 D removed.txt\0D  deleted.txt\0AM added-then-edited\0");
        assert_eq!(
            names(&s.staged),
            pairs(&[
                ("both.txt", "M"),
                ("new.txt", "A"),
                ("deleted.txt", "D"),
                ("added-then-edited", "A")
            ])
        );
        assert_eq!(
            names(&s.changes),
            pairs(&[("both.txt", "M"), ("removed.txt", "D"), ("added-then-edited", "M")])
        );
    }

    #[test]
    fn short_or_empty_entries_are_ignored() {
        let s = parse("");
        assert_eq!(s, GitStatus::default());
        let s = parse("## main\0\0ab\0");
        assert!(s.staged.is_empty() && s.changes.is_empty());
    }
}
