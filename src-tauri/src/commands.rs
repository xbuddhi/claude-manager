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
        crate::core::lifecycle::window_close_decision,
        crate::core::lifecycle::window_new,
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
        crate::pty::windows::pty_move,
        crate::pty::windows::pty_focus,
        crate::pty::windows::pty_focus_session,
        crate::pty::windows::window_list,
        crate::pty::windows::tab_drag_over,
        crate::launch::launch_external,
        // ---- live + notify (WP3) ----
        crate::live::get_live,
        crate::live::live_ancestors,
        crate::live::focus_live,
        crate::live::find_orphans,
        crate::live::close_orphans,
        crate::notify::set_active_terminal_pid,
        // ---- fsutil (WP4) ----
        crate::fsutil::path_kinds,
        // ---- actions (WP5) ----
        crate::actions::trash::trash_sessions,
        crate::actions::trash::trash_path,
        crate::actions::rename::rename_session,
        // ---- memory files ----
        crate::memory::memory_files,
        crate::memory::memory_read,
        crate::memory::memory_create,
        // ---- profiles UI (WP6) ----
        crate::profiles_cmd::create_profile,
        crate::profiles_cmd::open_profile_folder,
        // ---- usage (WP7) ----
        crate::usage::usage_cached,
        crate::usage::usage_plans,
        crate::usage::usage_local,
        // ---- git (WP8) ----
        crate::git::git_run,
        crate::git::git_status,
        crate::git::find_repos,
        crate::git::read_new_file,
        crate::git::git_web_url,
        // ---- os (WP9) ----
        crate::os::explorer_menu::explorer_menu_state,
        crate::os::explorer_menu::explorer_menu_install,
        crate::os::explorer_menu::explorer_menu_remove,
        crate::os::vscode::open_in_code,
        crate::os::reveal::reveal_path,
        crate::os::reveal::open_path,
    ]
}
