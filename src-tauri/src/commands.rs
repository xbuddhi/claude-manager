//! The one list of IPC commands. Each feature owns a marked block and only adds lines directly under its
//! own marker (never edit a marker); the commands themselves live in the feature's module.

use tauri::ipc::Invoke;

pub fn handler() -> impl Fn(Invoke) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        // ---- core ----
        crate::core::settings::get_settings,
        crate::core::settings::update_settings,
        crate::core::profiles::list_profiles,
        crate::core::profiles::refresh_profiles,
        crate::core::env::env_status,
        crate::core::env::platform_info,
        crate::core::lifecycle::app_quit_decision,
        crate::core::open_request::take_open_request,
        crate::core::open::open_log_dir,
        crate::core::open::open_url_https,
        // ---- sessions (WP1) ----
        crate::sessions::get_index,
        crate::sessions::rescan_full,
        crate::sessions::count_for,
        // ---- pty + launch (WP2) ----
        crate::pty::pty_new,
        crate::pty::pty_resume,
        crate::pty::pty_write,
        crate::pty::pty_resize,
        crate::pty::pty_kill,
        crate::pty::pty_list,
        crate::pty::pty_attach,
        crate::pty::pty_pause,
        crate::pty::pty_resume_output,
        crate::pty::pty_set_title,
        crate::pty::pty_clipboard_text,
        crate::pty::popout::pty_popout,
        crate::pty::popout::pty_return,
        crate::pty::popout::pty_close_window,
        crate::launch::launch_external,
        // ---- live + notify (WP3) ----
        crate::live::get_live,
        crate::live::live_ancestors,
        crate::live::focus_live,
        crate::live::find_orphans,
        crate::live::close_orphans,
        crate::notify::set_active_terminal_pid,
        // ---- fsutil (WP4) ----
        // ---- actions (WP5) ----
        crate::actions::trash::trash_sessions,
        crate::actions::trash::trash_path,
        // ---- profiles UI (WP6) ----
        crate::profiles_cmd::create_profile,
        crate::profiles_cmd::open_profile_folder,
        // ---- usage (WP7) ----
        // ---- git (WP8) ----
        // ---- os (WP9) ----
    ]
}
