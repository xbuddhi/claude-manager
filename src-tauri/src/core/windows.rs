//! The app's windows: the main window (`main`) and any number like it (`win-<n>`), each a full app page
//! with its own terminal tabs (like browser windows). New ones are built from the main window's
//! `tauri.conf.json` entry and shown by their page after its first paint.

use super::error::{AppError, AppResult};
use super::lifecycle::MAIN_WINDOW;
use super::webview::{harden, recover_on_crash};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Manager, WebviewWindow, WebviewWindowBuilder};

const PREFIX: &str = "win-";
/// How far a new window sits from the window in front (down and right).
const OFFSET: f64 = 32.0;
/// Where the pointer ends up in a window made by dropping a tab: over its tab strip, near the left.
const GRAB: (f64, f64) = (140.0, 20.0);

/// Numbers of new windows; the main window counts as 1.
static NEXT: AtomicU32 = AtomicU32::new(2);

pub fn is_app_window(label: &str) -> bool {
    label == MAIN_WINDOW || label.starts_with(PREFIX)
}

/// The window's number: 1 for the main window, n for `win-<n>`.
pub fn number(label: &str) -> u32 {
    label.strip_prefix(PREFIX).and_then(|n| n.parse().ok()).unwrap_or(1)
}

/// The label for the next new window.
pub fn new_label() -> String {
    format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// Every app window, the main window first, then oldest first.
pub fn all(app: &AppHandle) -> Vec<WebviewWindow> {
    let mut list: Vec<WebviewWindow> = app
        .webview_windows()
        .into_values()
        .filter(|w| is_app_window(w.label()))
        .collect();
    list.sort_by_key(|w| number(w.label()));
    list
}

/// The app windows on screen (shown, minimized ones included).
pub fn visible(app: &AppHandle) -> Vec<WebviewWindow> {
    all(app)
        .into_iter()
        .filter(|w| w.is_visible().unwrap_or(false))
        .collect()
}

/// The focused app window, else the main window.
pub fn front(app: &AppHandle) -> Option<WebviewWindow> {
    all(app)
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window(MAIN_WINDOW))
}

/// Shows, restores and focuses a window.
pub fn raise(w: &WebviewWindow) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
}

/// Opens a new app window labelled `label` (see [`new_label`]), the size of the window in front: with
/// its tab strip under the logical screen point `at` (a dropped tab), else offset from that window.
pub fn create(app: &AppHandle, label: &str, at: Option<(f64, f64)>) -> AppResult<WebviewWindow> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or_else(|| AppError::Internal("tauri.conf.json has no main window".into()))?
        .clone();
    config.label = label.to_string();
    config.visible = false;
    config.center = false;
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?;
    if let Some(from) = front(app)
        && let (Ok(pos), Ok(size), Ok(scale)) = (from.outer_position(), from.inner_size(), from.scale_factor())
    {
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        builder = builder.inner_size(size.width, size.height);
        let (x, y) = at.map_or((pos.x + OFFSET, pos.y + OFFSET), |(x, y)| (x - GRAB.0, y - GRAB.1));
        builder = builder.position(x, y);
    } else if let Some((x, y)) = at {
        builder = builder.position(x - GRAB.0, y - GRAB.1);
    }
    let window = harden(builder, app.config()).build()?;
    recover_on_crash(&window);
    Ok(window)
}

/// The app window on screen whose frame holds the logical screen point, other than `except`.
pub fn at_point(app: &AppHandle, x: f64, y: f64, except: &str) -> Option<WebviewWindow> {
    visible(app).into_iter().find(|w| {
        if w.label() == except || w.is_minimized().unwrap_or(true) {
            return false;
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.outer_size(), w.scale_factor()) else {
            return false;
        };
        let pos = pos.to_logical::<f64>(scale);
        let size = size.to_logical::<f64>(scale);
        x >= pos.x && x < pos.x + size.width && y >= pos.y && y < pos.y + size.height
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert!(is_app_window("main") && is_app_window("win-3"));
        assert!(!is_app_window("term-3"));
        assert_eq!(number("main"), 1);
        assert_eq!(number("win-7"), 7);
        let a = new_label();
        let b = new_label();
        assert!(a.starts_with(PREFIX) && number(&b) == number(&a) + 1);
    }
}
