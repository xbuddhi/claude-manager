//! One error type for every command. The webview receives it as `{ code, message }` (see `AppError` in bindings).

use serde::{Serialize, Serializer};
use std::sync::{Mutex, MutexGuard, PoisonError};
use ts_rs::TS;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    InvalidInput(String),
    #[error("Claude Code was not found. Install it or set its path in Settings.")]
    ClaudeNotFound,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error("{0}")]
    Internal(String),
}

pub type AppResult<T> = Result<T, AppError>;

/// Machine-readable error kind, so the frontend can react without parsing messages.
#[derive(Serialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ErrorCode {
    NotFound,
    InvalidInput,
    ClaudeNotFound,
    Io,
    Internal,
}

/// The serialized form of [`AppError`].
#[derive(Serialize, TS)]
#[ts(export, rename = "AppError")]
pub struct ErrorPayload {
    pub code: ErrorCode,
    pub message: String,
}

impl AppError {
    pub fn code(&self) -> ErrorCode {
        match self {
            AppError::NotFound(_) => ErrorCode::NotFound,
            AppError::InvalidInput(_) => ErrorCode::InvalidInput,
            AppError::ClaudeNotFound => ErrorCode::ClaudeNotFound,
            AppError::Io(_) => ErrorCode::Io,
            AppError::Tauri(_) | AppError::Internal(_) => ErrorCode::Internal,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

/// Locks a mutex, recovering the data if another thread panicked while holding it.
/// Every lock in this app guards plain data that stays consistent between statements, so a
/// poisoned lock is safe to reuse and must not cascade into more panics.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs blocking work (file I/O, process control) on the blocking thread pool, never on the UI thread.
pub async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Internal(format!("background task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_code_and_message() {
        let v = serde_json::to_value(AppError::NotFound("Folder not found\nC:/x".into())).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "code": "not_found", "message": "Folder not found\nC:/x" })
        );
    }

    #[test]
    fn lock_recovers_from_poison() {
        let m = std::sync::Arc::new(Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        *lock(&m) += 1;
        assert_eq!(*lock(&m), 2);
    }
}
