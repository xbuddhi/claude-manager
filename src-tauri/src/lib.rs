//! Claude Manager: builder, plugins and feature registration only. Each feature lives in its own module.
//!
//! A work package registers its feature by adding lines directly under its own marker comment in the
//! blocks below (and its commands in `commands.rs`). Never edit a marker or another package's lines:
//! packages that each insert under their own marker merge without conflicts.

pub mod commands;
pub mod core;

// ---- feature modules ----
// WP1 sessions
pub mod sessions;
// WP2 pty + launch
pub mod launch;
pub mod pty;
// WP3 live + notify
pub mod live;
pub mod notify;
// WP4 fsutil
pub mod fsutil;
// WP5 actions
pub mod actions;
// WP6 profiles_cmd
pub mod profiles_cmd;
// WP7 usage
pub mod usage;
// WP8 git
pub mod git;
// WP9 os
pub mod os;
// WP10 updater
pub mod updater;
// memory files view
pub mod memory;
// files view
pub mod files;
// ---- end feature modules ----

use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A second launch hands over to the running app, which then raises its window. Windows only lets the
    // process the user just started take the foreground; this lets the running one take it instead.
    #[cfg(windows)]
    // SAFETY: plain Win32 call with a constant argument
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(
            windows_sys::Win32::UI::WindowsAndMessaging::ASFW_ANY,
        );
    }
    let builder = tauri::Builder::default()
        // must be the first plugin, so a second launch exits before anything else starts
        .plugin(tauri_plugin_single_instance::init(
            crate::core::lifecycle::on_second_instance,
        ))
        .plugin(crate::core::log_plugin())
        // the window stays hidden until the frontend has painted, so restoring must not show it early; the
        // frame comes from the config (Windows draws its own title bar), never from a saved state
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE & !StateFlags::DECORATIONS)
                // more windows are placed next to the one in front, not where some earlier one was
                .with_filter(|label| label == crate::core::lifecycle::MAIN_WINDOW)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // used from Rust only; the webview has no opener permissions
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(commands::handler())
        .on_window_event(crate::core::lifecycle::on_window_event)
        .setup(|app| {
            crate::core::init(app)?;
            // ---- feature init ----
            // WP1 sessions
            sessions::init(app)?;
            // WP2 pty + launch
            pty::init(app)?;
            // WP3 live + notify
            notify::init(app)?;
            live::init(app)?;
            // WP4 fsutil
            // WP5 actions
            // WP6 profiles_cmd
            // WP7 usage
            usage::init(app)?;
            // WP8 git
            // WP9 os
            os::init(app)?;
            // WP10 updater
            updater::init(app)?;
            // ---- end feature init ----
            crate::core::webview::create_main_window(app)?;
            Ok(())
        });

    // ---- builder extensions (`let builder = <feature>::attach(builder);`) ----
    // WP9 os
    let builder = os::attach(builder);
    // WP10 updater: registers the plugin only when an endpoint and key are configured (docs/port/FOUNDATION.md)
    // ---- end builder extensions ----

    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(crate::core::lifecycle::on_run_event),
        Err(e) => {
            log::error!("could not start: {e}");
            eprintln!("Claude Manager could not start: {e}");
            std::process::exit(1);
        }
    }
}
