//! Which processes are the app's own terminals. The terminal feature (WP2) registers a [`TermPids`]
//! source; live-session detection and notifications (WP3) ask it, without knowing terminal internals.

use super::error::lock;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

pub trait TermPids: Send + Sync + 'static {
    /// Process ids of the terminal children that are still running (the processes the app started).
    fn pids(&self) -> Vec<u32>;
}

/// The registered source, if any. Managed as state by `core::init`.
#[derive(Default)]
pub struct TermPidsRegistry(Mutex<Option<Arc<dyn TermPids>>>);

/// Registers the terminal pid source; a later registration replaces it.
pub fn register(app: &AppHandle, source: impl TermPids) {
    *lock(&app.state::<TermPidsRegistry>().0) = Some(Arc::new(source));
}

/// Pids of the app's running terminals; empty when no terminal feature is registered.
pub fn pids(app: &AppHandle) -> Vec<u32> {
    let source = lock(&app.state::<TermPidsRegistry>().0).clone();
    source.map(|s| s.pids()).unwrap_or_default()
}
