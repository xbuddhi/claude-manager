//! Claude Manager: builder, plugins and feature registration only. Each feature lives in its own
//! module; it registers here with one line in the feature init block and its commands in `commands.rs`.

pub mod commands;
pub mod core;
pub mod os;
pub mod pty;
pub mod sessions;

use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // must be the first plugin, so a second launch exits before anything else starts
        .plugin(tauri_plugin_single_instance::init(
            crate::core::lifecycle::on_second_instance,
        ))
        .plugin(crate::core::log_plugin())
        // the window stays hidden until the frontend has painted; restoring must not show it early
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
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
            // ---- feature init (one line each) ----
            pty::init(app)?;
            // ---- end feature init ----
            crate::core::webview::create_main_window(app)?;
            Ok(())
        });
    let builder = os::menu::attach(builder);

    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(crate::core::lifecycle::on_run_event),
        Err(e) => {
            log::error!("could not start: {e}");
            eprintln!("Claude Manager could not start: {e}");
            std::process::exit(1);
        }
    }
}
