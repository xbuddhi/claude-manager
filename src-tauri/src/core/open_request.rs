//! Requests from outside the app to open a folder: this process's own command line, or a second launch
//! (the Explorer "Open Claude Code here" menu runs `claude-manager --open <dir> --profile <dir>`).
//!
//! Arguments are untrusted. The OS integration feature (WP9) installs the parser with [`set_parser`]; it
//! validates them into an [`OpenRequest`]. Valid requests wait here until the frontend takes them with
//! `take_open_request`; `app:open-request` only says that one is waiting. A request made during startup,
//! before the page listens, is therefore never lost, and raw arguments never reach the webview.

use super::error::{AppResult, lock};
use super::events;
use super::types::OpenRequest;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// Turns command-line arguments (program name removed) and the launch folder into a validated request,
/// or `None` when they ask for nothing (or for something invalid, which the parser logs).
pub trait ArgsParser: Fn(&AppHandle, &[String], &Path) -> Option<OpenRequest> + Send + Sync + 'static {}
impl<F: Fn(&AppHandle, &[String], &Path) -> Option<OpenRequest> + Send + Sync + 'static> ArgsParser for F {}

/// Managed as state by `core::init`.
#[derive(Default)]
pub struct OpenRequests {
    parser: Mutex<Option<Arc<dyn ArgsParser>>>,
    pending: Mutex<Vec<OpenRequest>>,
}

/// Installs the argument parser, then runs it on this process's own command line (a first launch from
/// the Explorer menu starts the app with `--open`).
pub fn set_parser(app: &AppHandle, parser: impl ArgsParser) {
    *lock(&app.state::<OpenRequests>().parser) = Some(Arc::new(parser));
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    receive(app, &args, &cwd);
}

/// Handles arguments from the command line or a second launch. Returns whether they made a request.
pub fn receive(app: &AppHandle, args: &[String], cwd: &Path) -> bool {
    if args.is_empty() {
        return false;
    }
    let state = app.state::<OpenRequests>();
    let parser = lock(&state.parser).clone();
    let Some(parser) = parser else {
        log::info!("ignoring {} launch argument(s): nothing handles them yet", args.len());
        return false;
    };
    // the parser runs without the lock held: it may take a moment (it checks folders and profiles)
    let Some(request) = parser(app, args, cwd) else {
        return false;
    };
    lock(&state.pending).push(request);
    if let Err(e) = app.emit_to(super::lifecycle::MAIN_WINDOW, events::APP_OPEN_REQUEST, ()) {
        log::error!("could not announce an open request: {e}");
    }
    true
}

// ---- commands ----

/// Every request waiting since the last call, oldest first.
#[tauri::command]
pub async fn take_open_request(state: State<'_, OpenRequests>) -> AppResult<Vec<OpenRequest>> {
    Ok(std::mem::take(&mut *lock(&state.pending)))
}
