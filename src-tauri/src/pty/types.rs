//! IPC types of the terminal feature.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A running terminal as the backend knows it. The frontend's tab record is `TermInfo` (core/store.ts).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PtyInfo {
    /// Terminal id, unique for the app's lifetime.
    pub id: u32,
    /// Process id of the terminal's child (claude); null once it exited or when unknown.
    pub pid: Option<u32>,
    pub dir: String,
    pub profile: String,
    /// The resumed (or forked) session; null for a new session.
    pub session_id: Option<String>,
    /// The tab title: the one it started with, or the latest the terminal set.
    pub title: String,
    /// Label of the window showing the terminal ("main", "win-<n>"); null when that window is gone, so
    /// the main window takes it.
    pub window: Option<String>,
}

/// A point on the screen, in logical pixels (CSS `screenX`/`screenY`).
#[derive(Deserialize, TS, Clone, Copy, Debug)]
#[ts(export)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// An app window on screen, for "Move to" menus.
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct WindowInfo {
    pub label: String,
    /// 1 for the main window, then 2, 3, ... in the order they were opened.
    pub number: u32,
    /// Terminals it shows.
    pub terminals: u32,
    /// The window that asked.
    pub current: bool,
}

/// The last message on a terminal's exit channel: its child ended (or was ended).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct PtyExit {
    /// Exit code; null when it could not be read. 127 usually means a program was not found.
    pub code: Option<u32>,
}

/// Input for `pty_write`: text (keys, pastes) is sent as UTF-8, bytes as they are (xterm's binary input).
#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum WriteData {
    Text(String),
    Bytes(Vec<u8>),
}

impl WriteData {
    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            WriteData::Text(s) => s.into_bytes(),
            WriteData::Bytes(b) => b,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_data_takes_text_or_bytes() {
        let text: WriteData = serde_json::from_str(r#""é\r""#).unwrap();
        assert_eq!(text.into_bytes(), "é\r".as_bytes());
        let bytes: WriteData = serde_json::from_str("[27, 255]").unwrap();
        assert_eq!(bytes.into_bytes(), [27, 255]);
        assert!(serde_json::from_str::<WriteData>("[256]").is_err());
    }
}
