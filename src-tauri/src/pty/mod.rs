//! Terminals inside the app (WP2 owns this feature; this is the prototype behind narrow, validated commands).

pub mod command;
pub mod manager;

use crate::core::error::{AppResult, blocking};
use crate::core::{env, lifecycle, paths, profiles, settings};
use command::Launch;
use manager::{PtyEvent, Terms};
use tauri::ipc::Channel;
use tauri::{App, AppHandle, Manager, State};

pub fn init(app: &mut App) -> AppResult<()> {
    let terms = Terms::default();
    app.manage(terms.clone());
    lifecycle::register(app.handle(), terms);
    Ok(())
}

fn start(
    terms: Terms,
    launch: Launch,
    claude_override: Option<String>,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> AppResult<u32> {
    let claude = env::claude_executable(claude_override.as_deref())?;
    let cmd = command::build(&launch, &claude, &paths::home()?)?;
    terms.spawn(cmd, cols, rows, on_event)
}

// ---- commands ----

/// New claude session in `dir` for `profile`. Returns the terminal id.
#[tauri::command]
pub async fn pty_new(
    app: AppHandle,
    terms: State<'_, Terms>,
    dir: String,
    profile: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> AppResult<u32> {
    let claude_override = settings::get(&app).claude_path;
    let terms = terms.inner().clone();
    blocking(move || {
        let launch = command::new_session(&dir, profiles::resolve_profile(&profile)?)?;
        start(terms, launch, claude_override, cols, rows, on_event)
    })
    .await
}

/// Resumes session `session_id` of `profile` in `dir` (`fork` starts a copy). Returns the terminal id.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri commands take their IPC arguments flat
pub async fn pty_resume(
    app: AppHandle,
    terms: State<'_, Terms>,
    session_id: String,
    profile: String,
    fork: bool,
    dir: String,
    cols: u16,
    rows: u16,
    on_event: Channel<PtyEvent>,
) -> AppResult<u32> {
    let claude_override = settings::get(&app).claude_path;
    let terms = terms.inner().clone();
    blocking(move || {
        let launch = command::resume_session(&session_id, profiles::resolve_profile(&profile)?, fork, &dir)?;
        start(terms, launch, claude_override, cols, rows, on_event)
    })
    .await
}

#[tauri::command]
pub async fn pty_write(terms: State<'_, Terms>, id: u32, data: String) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || terms.write(id, &data)).await
}

#[tauri::command]
pub async fn pty_resize(terms: State<'_, Terms>, id: u32, cols: u16, rows: u16) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || terms.resize(id, cols, rows)).await
}

#[tauri::command]
pub async fn pty_kill(terms: State<'_, Terms>, id: u32) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || {
        terms.kill(id);
        Ok(())
    })
    .await
}

/// Ends every terminal (the page was reloaded: terminals from the old page have no tab any more).
#[tauri::command]
pub async fn pty_kill_all(terms: State<'_, Terms>) -> AppResult<()> {
    let terms = terms.inner().clone();
    blocking(move || {
        terms.kill_all();
        Ok(())
    })
    .await
}
