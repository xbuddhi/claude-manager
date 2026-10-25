//! Pop-out windows: a terminal in its own window (`term-<id>`, page `src/popout.html`). The window takes
//! the terminal over with `pty_attach`; "Move back to main window" hands it back to the main window,
//! which takes it over the same way after the `pty-returned` event.

use super::manager::Terms;
use crate::core::error::{AppError, AppResult, blocking};
use crate::core::events;
use crate::core::lifecycle::{self, MAIN_WINDOW};
use crate::core::webview::harden;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

const WIDTH: f64 = 1100.0;
const HEIGHT: f64 = 680.0;
/// Offset from the main window's top-left corner.
const OFFSET: f64 = 60.0;

pub fn label(id: u32) -> String {
    format!("term-{id}")
}

/// The terminal id of a pop-out window's label.
fn id_of(window: &WebviewWindow) -> Option<u32> {
    window.label().strip_prefix("term-")?.parse().ok()
}

/// Gives terminal `id` back to the main window, if it still belongs to `from`.
fn hand_back(app: &AppHandle, terms: &Terms, id: u32, from: &str) {
    let Ok(info) = terms.info(id) else {
        return; // ended meanwhile
    };
    if info.window.as_deref() != Some(from) {
        return;
    }
    let _ = terms.set_window(id, MAIN_WINDOW);
    if let Err(e) = app.emit_to(MAIN_WINDOW, events::PTY_RETURNED, id) {
        log::error!("could not return terminal {id} to the main window: {e}");
    }
}

// ---- commands ----

/// Opens terminal `id` in its own window (or brings that window to the front). The caller removes its tab.
#[tauri::command]
pub async fn pty_popout(app: AppHandle, terms: State<'_, Terms>, id: u32) -> AppResult<()> {
    let info = terms.info(id)?;
    let label = label(id);
    if let Some(w) = app.get_webview_window(&label) {
        w.show()?;
        w.set_focus()?;
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("src/popout.html".into()))
        .title(&info.title)
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(480.0, 300.0)
        // shown by the page after its first paint, like the main window
        .visible(false);
    if let Some(main) = app.get_webview_window(MAIN_WINDOW)
        && let (Ok(pos), Ok(scale)) = (main.outer_position(), main.scale_factor())
    {
        let at = pos.to_logical::<f64>(scale);
        builder = builder.position(at.x + OFFSET, at.y + OFFSET);
    }
    let window = harden(builder, app.config()).build()?;
    crate::core::webview::recover_on_crash(&window);
    terms.set_window(id, &label)?;
    // closed some other way than its own buttons (they destroy it after deciding): back to the main window
    let (handle, terms) = (app.clone(), terms.inner().clone());
    window.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            hand_back(&handle, &terms, id, &label);
        }
    });
    Ok(())
}

/// "Move back to main window", from a pop-out window: the main window takes the terminal over again.
#[tauri::command]
pub async fn pty_return(app: AppHandle, window: WebviewWindow, terms: State<'_, Terms>) -> AppResult<()> {
    let id = id_of(&window).ok_or_else(|| AppError::InvalidInput("Not a terminal window.".into()))?;
    hand_back(&app, &terms, id, window.label());
    lifecycle::show_main(&app);
    window.destroy()?;
    Ok(())
}

/// Closes the calling pop-out window, ending its terminal when `kill` is set (the user confirmed, or it
/// had already ended); otherwise the terminal goes back to the main window.
#[tauri::command]
pub async fn pty_close_window(
    app: AppHandle,
    window: WebviewWindow,
    terms: State<'_, Terms>,
    kill: bool,
) -> AppResult<()> {
    let id = id_of(&window).ok_or_else(|| AppError::InvalidInput("Not a terminal window.".into()))?;
    if kill {
        let terms = terms.inner().clone();
        blocking(move || {
            terms.kill(id);
            Ok(())
        })
        .await?;
    } else {
        hand_back(&app, &terms, id, window.label());
    }
    window.destroy()?;
    Ok(())
}
