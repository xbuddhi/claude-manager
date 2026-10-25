//! Operating system integration (WP9 owns this feature): tray / menu bar icon, native menu, Explorer
//! right-click menu, VS Code, Explorer / Finder, launch arguments and the WebView2 memory target.

pub mod args;
pub mod explorer_menu;
pub mod memory;
pub mod menu;
pub mod reveal;
pub mod tray;
pub mod vscode;

use crate::core::error::AppResult;
use crate::core::open_request;
use tauri::{App, Builder, Wry};

/// Installs the launch argument parser, the tray icon and the Explorer menu upkeep. Runs in `setup`.
pub fn init(app: &mut App) -> AppResult<()> {
    let handle = app.handle();
    open_request::set_parser(handle, args::parse);
    // the app works without a tray; "Keep running" then minimizes instead of hiding
    if let Err(e) = tray::create(handle) {
        log::error!("could not create the tray icon: {e}");
    }
    explorer_menu::keep_current(handle);
    Ok(())
}

/// Builder-level parts: the native menu and its event handler, and the WebView2 memory hook.
pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    memory::attach(menu::attach(builder))
}
