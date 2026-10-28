//! File writes that must never leave a half-written file behind (settings, caches).

use super::error::{AppError, AppResult};
use std::io::Write;
use std::path::Path;

/// Writes `bytes` to `<path>.tmp`, flushes it to disk, then renames it over `path`, so a crash leaves
/// either the old or the new file, never a half-written one. Creates the parent folder when missing.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    write_via_temp(path, bytes, true)
}

/// Like [`write_atomic`] but without flushing to disk first: cheaper, but after a power loss the file can
/// be empty or torn. Only for files that are rebuilt when unreadable (caches).
pub fn write_atomic_unsynced(path: &Path, bytes: &[u8]) -> AppResult<()> {
    write_via_temp(path, bytes, false)
}

fn write_via_temp(path: &Path, bytes: &[u8], sync: bool) -> AppResult<()> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(AppError::Internal(format!("not a file path: {}", path.display())));
    };
    std::fs::create_dir_all(dir)?;
    let mut tmp_name = name.to_os_string();
    tmp_name.push(".tmp");
    let tmp = dir.join(tmp_name);
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    if sync {
        file.sync_all()?;
    }
    drop(file);
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_then_replaces_without_leaving_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("cache.json");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!dir.path().join("nested").join("cache.json.tmp").exists());
    }

    #[test]
    fn the_unsynced_variant_also_replaces() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        write_atomic_unsynced(&path, b"one").unwrap();
        write_atomic_unsynced(&path, b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(!dir.path().join("cache.json.tmp").exists());
    }
}
