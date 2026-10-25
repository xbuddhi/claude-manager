//! Terminal tabs inside the app: narrow, validated commands over the PTY manager. The webview names a
//! folder, a profile and a session id; what runs is decided in Rust (`launch`).
//!
//! A terminal's output goes to the output channel of one window at a time: raw bytes, then one JSON
//! `PtyExit` message when it ends. A pop-out window or a reloaded page takes a terminal over with
//! `pty_attach`, which first replays the last 256 KB of its output.

pub mod manager;
pub mod popout;
mod reader;
mod ring;
pub mod types;
mod writer;

use crate::core::error::{AppError, AppResult, blocking};
use crate::core::{env, lifecycle, paths, settings, terms as term_pids};
use crate::launch::{self, embed};
use manager::{Meta, Terms};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{App, AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use types::{PtyInfo, WriteData};

pub fn init(app: &mut App) -> AppResult<()> {
    let terms = Terms::default();
    app.manage(terms.clone());
    term_pids::register(app.handle(), terms.clone());
    lifecycle::register(app.handle(), terms);
    Ok(())
}

/// Longest title kept for a terminal.
const TITLE_MAX: usize = 200;

/// A title from the webview, as plain one-line text.
fn clean_title(title: &str) -> String {
    title
        .chars()
        .filter(|c| !c.is_control())
        .take(TITLE_MAX)
        .collect::<String>()
        .trim()
        .to_string()
}

/// What a tab asks to start; the same for a new and a resumed session.
struct Start {
    window: String,
    dir: String,
    profile: String,
    session_id: Option<String>,
    fork: bool,
    title: String,
    cols: u16,
    rows: u16,
}

/// Validates, builds and starts the command for a tab.
fn start(app: &AppHandle, terms: &Terms, req: Start, output: Channel<InvokeResponseBody>) -> AppResult<PtyInfo> {
    let claude_override = settings::get(app).claude_path;
    let launch = launch::launch_for(&req.dir, &req.profile, req.session_id.as_deref(), req.fork)?;
    // checked before anything starts, so the tab can say what is missing
    let claude = env::claude_executable(claude_override.as_deref())?;
    let cmd = embed::build(&launch, &claude, &paths::home()?)?;
    let meta = Meta {
        dir: launch.dir.to_string_lossy().into_owned(),
        profile: launch.profile.to_string_lossy().into_owned(),
        // a fork becomes a session of its own, with an id claude picks
        session_id: req.session_id.filter(|_| !req.fork),
        title: clean_title(&req.title),
        window: req.window,
    };
    terms.spawn(cmd, req.cols, req.rows, meta, output)
}

// ---- commands ----

/// New claude session in `dir` for `profile`.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri commands take their IPC arguments flat
pub async fn pty_new(
    app: AppHandle,
    window: WebviewWindow,
    terms: State<'_, Terms>,
    dir: String,
    profile: String,
    title: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<PtyInfo> {
    let terms = terms.inner().clone();
    let req = Start {
        window: window.label().to_string(),
        dir,
        profile,
        session_id: None,
        fork: false,
        title,
        cols,
        rows,
    };
    blocking(move || start(&app, &terms, req, on_output)).await
}

/// Resumes session `session_id` of `profile` in `dir` (`fork` starts a copy).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pty_resume(
    app: AppHandle,
    window: WebviewWindow,
    terms: State<'_, Terms>,
    session_id: String,
    profile: String,
    fork: bool,
    dir: String,
    title: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<PtyInfo> {
    let terms = terms.inner().clone();
    let req = Start {
        window: window.label().to_string(),
        dir,
        profile,
        session_id: Some(session_id),
        fork,
        title,
        cols,
        rows,
    };
    blocking(move || start(&app, &terms, req, on_output)).await
}

/// Queues input; returns at once.
#[tauri::command]
pub async fn pty_write(terms: State<'_, Terms>, id: u32, data: WriteData) -> AppResult<()> {
    terms.write(id, data.into_bytes())
}

#[tauri::command]
pub async fn pty_resize(terms: State<'_, Terms>, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || terms.resize(id, cols, rows)).await
}

/// Ends the terminal and its whole process tree. An already ended terminal is fine.
#[tauri::command]
pub async fn pty_kill(terms: State<'_, Terms>, id: u32) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || {
        terms.kill(id);
        Ok(())
    })
    .await
}

/// Running terminals, oldest first; `window` is null when the window showing one is gone.
#[tauri::command]
pub async fn pty_list(app: AppHandle, terms: State<'_, Terms>) -> AppResult<Vec<PtyInfo>> {
    let mut list = terms.list();
    for t in &mut list {
        t.window = t.window.take().filter(|w| app.get_webview_window(w).is_some());
    }
    Ok(list)
}

/// Sends the terminal's output to the calling window from now on, after replaying its recent output.
#[tauri::command]
pub async fn pty_attach(
    window: WebviewWindow,
    terms: State<'_, Terms>,
    id: u32,
    on_output: Channel<InvokeResponseBody>,
) -> AppResult<PtyInfo> {
    terms.attach(id, on_output, window.label())
}

/// Flow control: xterm has too much output it has not parsed yet.
#[tauri::command]
pub async fn pty_pause(terms: State<'_, Terms>, id: u32) -> AppResult<()> {
    terms.set_paused(id, true)
}

#[tauri::command]
pub async fn pty_resume_output(terms: State<'_, Terms>, id: u32) -> AppResult<()> {
    terms.set_paused(id, false)
}

/// Remembers the tab title the terminal set (for a pop-out window and a reloaded page).
#[tauri::command]
pub async fn pty_set_title(app: AppHandle, terms: State<'_, Terms>, id: u32, title: String) -> AppResult<()> {
    let title = clean_title(&title);
    if title.is_empty() {
        return Ok(());
    }
    terms.set_title(id, &title)?;
    if let Some(w) = app.get_webview_window(&popout::label(id)) {
        w.set_title(&title)?;
    }
    Ok(())
}

/// The clipboard's text, for a terminal's Paste menu item (read in Rust: the webview has no clipboard
/// read permission).
#[tauri::command]
pub async fn pty_clipboard_text(app: AppHandle) -> AppResult<String> {
    app.clipboard()
        .read_text()
        .map_err(|_| AppError::NotFound("The clipboard holds no text.".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_one_plain_line() {
        assert_eq!(clean_title("  Fix\x1b[31m tests\n "), "Fix[31m tests");
        assert_eq!(clean_title(&"x".repeat(500)).len(), TITLE_MAX);
    }
}
