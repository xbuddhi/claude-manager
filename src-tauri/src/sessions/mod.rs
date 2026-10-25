//! Session list (WP1 owns this feature and replaces the scanner with the index engine).

pub mod scan;

use crate::core::error::{AppResult, blocking};
use crate::core::paths;
use crate::core::types::Project;
use tauri::AppHandle;

/// The display label of session `session_id`, for notifications (WP3). Provided by WP1: only the index
/// engine holds labels. Until then callers fall back to the folder name.
pub fn label_for(_app: &AppHandle, _session_id: &str) -> Option<String> {
    None
}

/// Every non-empty session of every profile, grouped by folder. Reads files, so it runs off the UI thread.
#[tauri::command]
pub async fn list_projects() -> AppResult<Vec<Project>> {
    blocking(|| Ok(scan::projects(&paths::home()?))).await
}
