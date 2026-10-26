//! Foundation shared by every feature. Features use these modules; they never reach into each other.

pub mod env;
pub mod error;
pub mod events;
pub mod fsio;
pub mod lifecycle;
pub mod open;
pub mod open_request;
pub mod paths;
pub mod procs;
pub mod profiles;
pub mod settings;
pub mod spawn;
pub mod terms;
pub mod types;
pub mod webview;
pub mod windows;

use error::AppResult;
use tauri::{App, Manager, Runtime};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Managed state and background work every feature relies on. Runs first in `setup`.
pub fn init(app: &mut App) -> AppResult<()> {
    install_panic_hook();
    #[cfg(windows)]
    if let Err(e) = procs::init_job() {
        // terminals still work; only crash cleanup of their process trees is lost
        log::error!("could not create the process job object: {e}");
    }
    env::start();
    app.manage(lifecycle::ShutdownRegistry::default());
    app.manage(open_request::OpenRequests::default());
    app.manage(terms::TermPidsRegistry::default());
    app.manage(procs::Procs::new());
    app.manage(profiles::Profiles::default());
    settings::init(app)?;
    Ok(())
}

/// Log file in the app log folder (5 MB, one old file kept, local time) and stdout. Debug builds also
/// forward every line to the webview console, which helps while developing and only costs in release.
pub fn log_plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let mut targets = vec![
        Target::new(TargetKind::LogDir { file_name: None }),
        Target::new(TargetKind::Stdout),
    ];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Webview));
    }
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets(targets)
        .max_file_size(5_000_000)
        .rotation_strategy(RotationStrategy::KeepOne)
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(log::LevelFilter::Info)
        .build()
}

/// Panics are logged (with location) before the default handler runs. Builds use panic = "unwind",
/// so a panic ends only the thread it happened on, not the app and its running sessions.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        log::error!("panic in thread '{thread}' at {location}: {message}");
        previous(info);
    }));
}
