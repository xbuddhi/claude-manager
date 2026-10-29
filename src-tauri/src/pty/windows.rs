//! Terminals across the app's windows (`core::windows`): moving tabs to another or a new window (a tab
//! dragged out of its strip, "Move to new window", "Move to Window 2"), and bringing an open tab to the
//! front wherever it is. A window takes moved terminals over with `pty_attach`: a new one when its page
//! loads (they are already assigned to its label), an open one on the `pty-moved` event.
//!
//! While a tab is dragged off its strip, `tab_drag_over` tells the window under the pointer (`tab-drag`,
//! again on every call: it drops the hint when they stop) where the tab would land, and the window it
//! left that it is gone.

use super::manager::Terms;
use super::types::{Point, WindowInfo};
use crate::core::error::lock;
use crate::core::error::{AppError, AppResult};
use crate::core::{events, windows};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// How long a drag reuses the window frames it read (reading them takes the main thread).
const FRAMES_FOR: Duration = Duration::from_millis(100);

/// The window a dragged tab is over, told with `tab-drag`, and the window frames the drag last read.
#[derive(Default)]
pub struct DragTarget {
    over: Mutex<Option<String>>,
    frames: Mutex<Option<(Instant, Vec<windows::Frame>)>>,
}

/// Moves the calling window's terminals `ids` to window `to`, else to the window under the logical screen
/// point `at`, else to a new window (placed at `at` when given). Returns the label of the window they
/// went to. The caller removes their tabs.
#[tauri::command]
pub async fn pty_move(
    app: AppHandle,
    window: WebviewWindow,
    terms: State<'_, Terms>,
    ids: Vec<u32>,
    to: Option<String>,
    at: Option<Point>,
) -> AppResult<String> {
    let from = window.label();
    let ids: Vec<u32> = ids
        .into_iter()
        .filter(|id| terms.info(*id).is_ok_and(|t| t.window.as_deref() == Some(from)))
        .collect();
    if ids.is_empty() {
        return Err(AppError::NotFound("These terminals have ended.".into()));
    }
    let target = match (&to, &at) {
        (Some(label), _) => Some(
            app.get_webview_window(label)
                .filter(|w| windows::is_app_window(w.label()) && w.label() != from)
                .ok_or_else(|| AppError::NotFound("That window is closed.".into()))?,
        ),
        (None, Some(p)) => windows::at_point(&app, p.x, p.y, from),
        (None, None) => None,
    };
    if let Some(target) = target {
        let label = target.label().to_string();
        for id in &ids {
            let _ = terms.set_window(*id, &label);
        }
        app.emit_to(&label, events::PTY_MOVED, &ids)?;
        windows::raise(&target);
        return Ok(label);
    }
    // assigned first: the new page takes over what is assigned to it when it loads
    let label = windows::new_label();
    for id in &ids {
        let _ = terms.set_window(*id, &label);
    }
    if let Err(e) = windows::create(&app, &label, at.map(|p| (p.x, p.y))) {
        for id in &ids {
            let _ = terms.set_window(*id, from);
        }
        return Err(e);
    }
    Ok(label)
}

/// Brings terminal `id`'s tab to the front, in whichever window shows it. False when no window does.
#[tauri::command]
pub async fn pty_focus(app: AppHandle, terms: State<'_, Terms>, id: u32) -> AppResult<bool> {
    let Some(label) = terms.info(id)?.window else {
        return Ok(false);
    };
    focus(&app, id, &label)
}

/// Brings the open tab of session `session_id` to the front when another window shows it (opening a
/// session that is already open goes to its tab, like a browser). False when no other window does.
#[tauri::command]
pub async fn pty_focus_session(
    app: AppHandle,
    window: WebviewWindow,
    terms: State<'_, Terms>,
    session_id: String,
) -> AppResult<bool> {
    let open = terms
        .list()
        .into_iter()
        .find(|t| t.session_id.as_deref() == Some(session_id.as_str()) && t.window.as_deref() != Some(window.label()));
    match open {
        Some(t) => focus(&app, t.id, t.window.as_deref().unwrap_or_default()),
        None => Ok(false),
    }
}

/// Tells window `label` to show terminal `id`, and raises it.
pub fn focus(app: &AppHandle, id: u32, label: &str) -> AppResult<bool> {
    let Some(w) = app
        .get_webview_window(label)
        .filter(|w| windows::is_app_window(w.label()))
    else {
        return Ok(false);
    };
    app.emit_to(label, events::PTY_FOCUS, id)?;
    windows::raise(&w);
    Ok(true)
}

/// A tab of the calling window, titled `title`, is dragged off its strip with the pointer at the logical
/// screen point `at` (`None`: the drag ended). The other app window under it gets `tab-drag` with the
/// title (each call), the one it left gets `tab-drag` with null. Returns that window's number (`None`: a drop there
/// opens a new window).
#[tauri::command]
pub async fn tab_drag_over(
    app: AppHandle,
    window: WebviewWindow,
    target: State<'_, DragTarget>,
    at: Option<Point>,
    title: String,
) -> AppResult<Option<u32>> {
    let label = match at {
        Some(p) => {
            let mut cached = lock(&target.frames);
            if cached.as_ref().is_none_or(|(at, _)| at.elapsed() >= FRAMES_FOR) {
                *cached = Some((Instant::now(), windows::frames(&app)));
            }
            let frames = cached.as_ref().map_or(&[][..], |(_, f)| f.as_slice());
            windows::frame_at(frames, p.x, p.y, window.label()).map(str::to_string)
        }
        None => {
            // the drag ended: the next one reads the frames afresh
            *lock(&target.frames) = None;
            None
        }
    };
    let mut current = lock(&target.over);
    if *current != label
        && let Some(old) = current.take()
    {
        let _ = app.emit_to(&old, events::TAB_DRAG, None::<String>);
    }
    if let Some(new) = &label {
        app.emit_to(new, events::TAB_DRAG, Some(&title))?;
    }
    current.clone_from(&label);
    Ok(label.as_deref().map(windows::number))
}

/// The app windows on screen, the main window first, with how many terminals each shows.
#[tauri::command]
pub async fn window_list(app: AppHandle, window: WebviewWindow, terms: State<'_, Terms>) -> AppResult<Vec<WindowInfo>> {
    let all = terms.list();
    Ok(windows::visible(&app)
        .iter()
        .map(|w| {
            let label = w.label().to_string();
            WindowInfo {
                number: windows::number(&label),
                // tabs only: a tab's shell is not a tab of its own
                terminals: u32::try_from(
                    all.iter()
                        .filter(|t| t.owner.is_none() && t.window.as_deref() == Some(&label))
                        .count(),
                )
                .unwrap_or(u32::MAX),
                current: label == window.label(),
                label,
            }
        })
        .collect())
}
