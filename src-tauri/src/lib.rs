mod pty;
mod sessions;

use pty::{PtyEvent, Terms};
use tauri::ipc::Channel;
use tauri::{Manager, State};

#[tauri::command]
fn list_profiles() -> Vec<sessions::Profile> {
    sessions::profiles()
}

// file reading runs off the UI thread
#[tauri::command]
async fn list_projects() -> Result<Vec<sessions::Project>, String> {
    tauri::async_runtime::spawn_blocking(sessions::projects).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_spawn(terms: State<Terms>, cwd: String, profile: String, args: Vec<String>, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Result<u32, String> {
    terms.spawn(&cwd, &profile, &args, cols, rows, on_event)
}

#[tauri::command]
fn pty_write(terms: State<Terms>, id: u32, data: String) -> Result<(), String> {
    terms.write(id, &data)
}

#[tauri::command]
fn pty_resize(terms: State<Terms>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    terms.resize(id, cols, rows)
}

#[tauri::command]
fn pty_kill(terms: State<Terms>, id: u32) {
    terms.kill(id)
}

// the window was reloaded: terminals from the old page have no tab any more
#[tauri::command]
fn pty_kill_all(terms: State<Terms>) {
    terms.kill_all()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Terms::default())
        .invoke_handler(tauri::generate_handler![list_profiles, list_projects, pty_spawn, pty_write, pty_resize, pty_kill, pty_kill_all])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<Terms>().kill_all(); // closing the app ends its terminals
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
