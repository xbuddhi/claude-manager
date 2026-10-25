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
        crate::sessions::list_projects,
        // ---- pty + launch (WP2) ----
        crate::pty::pty_new,
        crate::pty::pty_resume,
        crate::pty::pty_write,
        crate::pty::pty_resize,
        crate::pty::pty_kill,
        crate::pty::pty_kill_all,
        // ---- live + notify (WP3) ----
        // ---- fsutil (WP4) ----
        // ---- actions (WP5) ----
        // ---- profiles UI (WP6) ----
        // ---- usage (WP7) ----
        // ---- git (WP8) ----
        crate::git::git_run,
        crate::git::git_status,
        crate::git::find_repos,
        crate::git::read_new_file,
        // ---- os (WP9) ----
    ]
}
