//! Renaming a session the way Claude Code's `/rename` does: a `custom-title` line appended to the
//! transcript. The session index shows the last one ahead of any summary or prompt; an empty title clears it.
//!
//! Like `trash_sessions`, it takes a profile and a session id, never a path.

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::profiles;
use serde_json::json;
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

/// The longest title kept, in characters (the list clips long ones anyway).
const MAX_CHARS: usize = 200;

/// Appends the title line to the transcript of `session_id` in `profile`. Whitespace (newlines too)
/// collapses to single spaces; an empty title goes back to the summary or first prompt.
pub fn rename(profile: &Path, session_id: &str, title: &str) -> AppResult<()> {
    if !profiles::is_session_id(session_id) {
        return Err(AppError::InvalidInput(format!("Not a session id: {session_id}")));
    }
    let transcript = profiles::find_transcript(profile, session_id)
        .ok_or_else(|| AppError::NotFound(format!("Session not found: {session_id}")))?;
    let title: String = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_CHARS)
        .collect();
    let line = json!({ "type": "custom-title", "customTitle": title, "sessionId": session_id });
    let mut file = OpenOptions::new().read(true).append(true).open(&transcript)?;
    // a transcript cut off mid-line would swallow ours: start on a line of its own
    let mut last = [0u8];
    let len = file.seek(SeekFrom::End(0))?;
    let newline = len == 0 || {
        file.seek(SeekFrom::End(-1))?;
        file.read_exact(&mut last)?;
        last[0] == b'\n'
    };
    let text = format!("{}{line}\n", if newline { "" } else { "\n" });
    file.write_all(text.as_bytes())?;
    Ok(())
}

// ---- commands ----

/// Renames a session (an empty title clears the name); the list updates through the session index.
#[tauri::command]
pub async fn rename_session(profile: String, session_id: String, title: String) -> AppResult<()> {
    blocking(move || rename(&profiles::resolve_profile(&profile)?, &session_id, &title)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const ID: &str = "0b9f4c2e-1a2b-4c3d-8e9f-0123456789ab";

    fn profile(transcript: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let p = tempfile::tempdir().unwrap();
        let slug = p.path().join("projects").join("C--code-app");
        fs::create_dir_all(&slug).unwrap();
        let file = slug.join(format!("{ID}.jsonl"));
        fs::write(&file, transcript).unwrap();
        (p, file)
    }

    #[test]
    fn appends_a_custom_title_line() {
        let (p, file) = profile("{\"type\":\"user\"}\n");
        rename(p.path(), ID, "  New\n name  ").unwrap();
        let text = fs::read_to_string(file).unwrap();
        let last: serde_json::Value = serde_json::from_str(text.lines().last().unwrap()).unwrap();
        assert_eq!(last["type"], "custom-title");
        assert_eq!(last["customTitle"], "New name");
        assert_eq!(last["sessionId"], ID);
        assert!(text.ends_with('\n') && text.lines().count() == 2);
    }

    #[test]
    fn starts_a_new_line_after_a_cut_off_one() {
        let (p, file) = profile("{\"type\":\"user\"}");
        rename(p.path(), ID, "x").unwrap();
        assert_eq!(fs::read_to_string(file).unwrap().lines().count(), 2);
    }

    #[test]
    fn refuses_a_bad_or_missing_session() {
        let (p, _) = profile("");
        assert!(rename(p.path(), "../x", "t").is_err());
        assert!(rename(p.path(), "11111111-2222-3333-4444-555555555555", "t").is_err());
    }
}
