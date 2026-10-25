//! The index cache file (`<app cache dir>/sessions-cache.json`): one [`ParseState`] per transcript, so a
//! restart reads only what was written since. It can be deleted at any time; a missing, unreadable or
//! older-version file means a cold scan.

use super::parse::ParseState;
use crate::core::error::{AppError, AppResult};
use crate::core::fsio;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "sessions-cache.json";
const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct CacheFile {
    version: u32,
    entries: HashMap<PathBuf, ParseState>,
}

pub fn load(path: &Path) -> HashMap<PathBuf, ParseState> {
    let Ok(bytes) = std::fs::read(path) else {
        return HashMap::new();
    };
    match serde_json::from_slice::<CacheFile>(&bytes) {
        Ok(c) if c.version == VERSION => c.entries,
        Ok(_) => HashMap::new(),
        Err(e) => {
            log::warn!("the session cache could not be read and is rebuilt: {e}");
            HashMap::new()
        }
    }
}

pub fn save(path: &Path, states: Vec<(PathBuf, ParseState)>) -> AppResult<()> {
    let file = CacheFile {
        version: VERSION,
        entries: states.into_iter().collect(),
    };
    let bytes = serde_json::to_vec(&file).map_err(|e| AppError::Internal(format!("session cache: {e}")))?;
    fsio::write_atomic(path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_ignores_bad_or_old_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert!(load(&path).is_empty());
        let st = ParseState {
            len: 10,
            offset: 10,
            count: 2,
            prompt: Some("hi".into()),
            ..Default::default()
        };
        save(&path, vec![(PathBuf::from("a.jsonl"), st.clone())]).unwrap();
        assert_eq!(load(&path).get(Path::new("a.jsonl")), Some(&st));
        std::fs::write(&path, r#"{"version":99,"entries":{"a.jsonl":{}}}"#).unwrap();
        assert!(load(&path).is_empty());
        std::fs::write(&path, "{not json").unwrap();
        assert!(load(&path).is_empty());
    }
}
