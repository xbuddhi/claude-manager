//! Native application menu (macOS only; Windows has no menu bar).
//!
//! Replaces Tauri's default macOS menu, whose Close Window (Cmd+W) and Quit (Cmd+Q) would end every
//! running session without asking. The Edit menu must stay: WKWebView copy, paste and undo only work
//! through it. Items with a custom id are sent to the frontend as `menu` events ({ id }), except the
//! ones handled here (quit, show logs). WP9 adds the remaining items in the marked blocks.
//!
//! The ids below are the contract with the frontend: they are also its command ids (`core/commands.ts`),
//! "<area>:<action>" with a colon. Anything that triggers one of these actions (tray menu, shortcuts)
//! uses the same id, e.g. the tray's "New session" emits `menu` with `session:new`.

use crate::core::types::MenuEvent;
use crate::core::{events, lifecycle, open};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Builder, Emitter, Runtime, Wry};

// ---- menu ids (also used as command ids by the frontend shortcut registry) ----
pub const SETTINGS: &str = "app:settings";
pub const QUIT: &str = "app:quit";
pub const NEW_SESSION: &str = "session:new";
pub const CLOSE_TAB: &str = "tab:close";
pub const NEXT_TAB: &str = "tab:next";
pub const PREV_TAB: &str = "tab:prev";
pub const FIND: &str = "search:focus";
pub const REFRESH: &str = "refresh:full";
pub const SHOW_LOGS: &str = "help:logs";

/// Installs the menu on macOS. Called once in `lib.rs` on the builder.
pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    if cfg!(target_os = "macos") {
        builder
            .enable_macos_default_menu(false)
            .menu(build)
            .on_menu_event(|app, event| on_menu_event(app, event.id().as_ref()))
    } else {
        builder
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let info = app.package_info();
    let about = AboutMetadata {
        name: Some(info.name.clone()),
        version: Some(info.version.to_string()),
        authors: app.config().bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        &info.name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &sep()?,
            &item(SETTINGS, "Settings…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            // custom, not the predefined Quit: quitting must ask first while terminals run
            &item(QUIT, &format!("Quit {}", info.name), Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let session = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &item(NEW_SESSION, "New Session", Some("CmdOrCtrl+T"))?,
            // Cmd+W closes the terminal tab, never the window
            &item(CLOSE_TAB, "Close Tab", Some("CmdOrCtrl+W"))?,
            &sep()?,
            &item(NEXT_TAB, "Next Tab", Some("CmdOrCtrl+Shift+]"))?,
            &item(PREV_TAB, "Previous Tab", Some("CmdOrCtrl+Shift+["))?,
            &sep()?,
            &item(FIND, "Find", Some("CmdOrCtrl+F"))?,
            &item(REFRESH, "Refresh", Some("CmdOrCtrl+R"))?,
            // ---- session items (WP9) ----
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&item(SHOW_LOGS, "Show Logs", None)?])?;
    #[cfg(target_os = "macos")]
    {
        window.set_as_windows_menu_for_nsapp()?;
        help.set_as_help_menu_for_nsapp()?;
    }
    Menu::with_items(app, &[&app_menu, &edit, &session, &window, &help])
}

pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        QUIT => lifecycle::request_quit(app),
        SHOW_LOGS => {
            if let Err(e) = open::show_log_dir(app) {
                log::error!("{e}");
            }
        }
        _ => {
            if let Err(e) = app.emit(events::MENU, MenuEvent { id: id.to_string() }) {
                log::error!("could not send menu event {id}: {e}");
            }
        }
    }
}
