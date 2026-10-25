//! Reads a new (untracked) file for the diff view, which git has no diff for.

use crate::core::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Component, Path};
use ts_rs::TS;

/// Larger files are not shown.
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Lines shown of a new file.
pub const MAX_LINES: usize = 20_000;

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum NewFile {
    /// The text (at most 20,000 lines; invalid UTF-8 replaced).
    Text {
        text: String,
    },
    Missing,
    /// Over 2 MB; `size` in bytes.
    Large {
        size: u64,
    },
    Binary,
}

/// Reads `path` (relative to `repo`), which must stay inside `repo`, also through links.
pub fn read(repo: &str, path: &str) -> AppResult<NewFile> {
    let repo = Path::new(repo);
    if !repo.is_dir() {
        return Err(AppError::NotFound(format!("Folder not found:\n{}", repo.display())));
    }
    let rel = Path::new(path);
    let plain = !path.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
    if !plain {
        return Err(AppError::InvalidInput(format!(
            "Not a path inside the repository: {path}"
        )));
    }
    let full = repo.join(rel);
    let Ok(real) = full.canonicalize() else {
        return Ok(NewFile::Missing);
    };
    if !real.starts_with(repo.canonicalize()?) {
        return Err(AppError::InvalidInput(format!("{path} is outside the repository.")));
    }
    let meta = std::fs::metadata(&real)?;
    if !meta.is_file() {
        return Ok(NewFile::Missing);
    }
    if meta.len() > MAX_BYTES {
        return Ok(NewFile::Large { size: meta.len() });
    }
    Ok(decode(&std::fs::read(&real)?))
}

/// Text from bytes: UTF-16 with a byte order mark, else UTF-8 (lossy); a NUL makes it binary.
pub fn decode(bytes: &[u8]) -> NewFile {
    let utf16 = |be: bool| {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if be {
                    u16::from_be_bytes([c[0], c[1]])
                } else {
                    u16::from_le_bytes([c[0], c[1]])
                }
            })
            .collect();
        String::from_utf16_lossy(&units)
    };
    let text = match bytes {
        [0xFF, 0xFE, ..] => utf16(false),
        [0xFE, 0xFF, ..] => utf16(true),
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8_lossy(rest).into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    };
    if text.contains('\0') {
        return NewFile::Binary;
    }
    NewFile::Text { text: cap_lines(text) }
}

fn cap_lines(text: String) -> String {
    match text.match_indices('\n').nth(MAX_LINES - 1) {
        Some((i, _)) => text[..i].to_string(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn reads_text_and_reports_missing_large_and_binary() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().to_str().unwrap();
        fs::create_dir_all(t.path().join("src")).unwrap();
        fs::write(t.path().join("src").join("a.txt"), "one\ntwo\n").unwrap();
        assert_eq!(
            read(repo, "src/a.txt").unwrap(),
            NewFile::Text {
                text: "one\ntwo\n".into()
            }
        );
        assert_eq!(read(repo, "src/gone.txt").unwrap(), NewFile::Missing);
        assert_eq!(read(repo, "src").unwrap(), NewFile::Missing);
        fs::write(t.path().join("big.bin"), vec![b'a'; 2 * 1024 * 1024 + 1]).unwrap();
        assert_eq!(
            read(repo, "big.bin").unwrap(),
            NewFile::Large {
                size: 2 * 1024 * 1024 + 1
            }
        );
        fs::write(t.path().join("img.png"), b"\x89PNG\0\0").unwrap();
        assert_eq!(read(repo, "img.png").unwrap(), NewFile::Binary);
    }

    #[test]
    fn paths_must_stay_inside_the_repository() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(t.path().join("secret.txt"), "x").unwrap();
        let repo = repo.to_str().unwrap();
        let outside = t.path().join("secret.txt");
        for bad in ["../secret.txt", "a/../../secret.txt", "", outside.to_str().unwrap()] {
            assert!(matches!(read(repo, bad), Err(AppError::InvalidInput(_))), "{bad}");
        }
        assert!(matches!(
            read(&t.path().join("gone").to_string_lossy(), "a"),
            Err(AppError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_repository_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        fs::write(t.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(t.path().join("secret.txt"), repo.join("link")).unwrap();
        assert!(matches!(
            read(repo.to_str().unwrap(), "link"),
            Err(AppError::InvalidInput(_))
        ));
    }

    #[test]
    fn decodes_boms_and_caps_lines() {
        assert_eq!(decode(b"\xEF\xBB\xBFhi"), NewFile::Text { text: "hi".into() });
        assert_eq!(decode(b"\xFF\xFEh\0i\0"), NewFile::Text { text: "hi".into() });
        assert_eq!(decode(b"\xFE\xFF\0h\0i"), NewFile::Text { text: "hi".into() });
        assert_eq!(
            decode(b"bad \xFF byte"),
            NewFile::Text {
                text: "bad \u{FFFD} byte".into()
            }
        );
        let many = "x\n".repeat(MAX_LINES + 5);
        let NewFile::Text { text } = decode(many.as_bytes()) else {
            panic!()
        };
        assert_eq!(text.lines().count(), MAX_LINES);
    }
}
