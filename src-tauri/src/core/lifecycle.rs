//! Window close, quit, reopen and exit.
//!
//! - Closing the main window or quitting while terminals run asks first: the backend emits
//!   `app:close-requested` and the frontend answers with `app_quit_decision` (cancel / close / keep).
//! - With nothing running, closing the window exits on Windows and hides it on macOS (Dock reopens it).
//! - "Keep running" hides the window: on macOS the Dock brings it back, on Windows the tray icon (WP9
//!   calls [`set_tray_present`]); until a tray exists, Windows minimizes instead, so the window can
//!   always be found again.
//! - On macOS an exit request from outside the app (Dock Quit, logout, shutdown) is not cancelled: the
//!   app's own Quit goes through [`request_quit`], and asking here would cancel the user's logout. The
//!   hooks still end the terminals; their sessions stay saved and can be resumed.
//! - On exit, every registered [`ShutdownHook`] runs once (terminals are killed, settings flushed).
//!
//! Features plug in through [`register`]: the terminal feature reports how many terminals are live and
//! kills them on shutdown.

use super::error::{AppResult, blocking, lock};
use super::types::{CloseRequest, QuitDecision};
use super::{events, open_request, settings};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Window, WindowEvent};

pub const MAIN_WINDOW: &str = "main";

/// Something that must be told when the app exits, and may hold the app open.
pub trait ShutdownHook: Send + Sync + 'static {
    /// Running work that quitting would end (e.g. live terminals). Non-zero makes close and quit ask first.
    fn live_count(&self) -> usize {
        0
    }
    /// Called once, when the app exits. Keep it short; it may run on the UI thread.
    fn shutdown(&self);
}

/// Registered [`ShutdownHook`]s. Managed as state by `core::init`.
#[derive(Default)]
pub struct ShutdownRegistry {
    hooks: Mutex<Vec<Arc<dyn ShutdownHook>>>,
    /// The user confirmed quitting (or nothing needed confirming); exit requests pass through.
    quit_confirmed: AtomicBool,
    hooks_ran: AtomicBool,
    /// A tray icon exists, so a hidden window can be brought back on Windows.
    tray_present: AtomicBool,
}

impl ShutdownRegistry {
    pub fn register(&self, hook: Arc<dyn ShutdownHook>) {
        lock(&self.hooks).push(hook);
    }

    pub fn live_count(&self) -> usize {
        self.snapshot().iter().map(|h| h.live_count()).sum()
    }

    /// Runs every hook once, in registration order; later calls do nothing.
    pub fn run_hooks(&self) {
        if self.hooks_ran.swap(true, Ordering::SeqCst) {
            return;
        }
        for hook in self.snapshot() {
            hook.shutdown();
        }
    }

    // hooks run without the lock held, so a hook may itself use the registry
    fn snapshot(&self) -> Vec<Arc<dyn ShutdownHook>> {
        lock(&self.hooks).clone()
    }
}

pub fn register(app: &AppHandle, hook: impl ShutdownHook) {
    app.state::<ShutdownRegistry>().register(Arc::new(hook));
}

/// Called by the tray feature (WP9) once its icon exists: "Keep running" may then hide the window.
pub fn set_tray_present(app: &AppHandle) {
    app.state::<ShutdownRegistry>()
        .tray_present
        .store(true, Ordering::SeqCst);
}

/// `Builder::on_window_event` handler.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle();
    let registry = app.state::<ShutdownRegistry>();
    if registry.quit_confirmed.load(Ordering::SeqCst) {
        return;
    }
    let live = registry.live_count();
    if live > 0 {
        api.prevent_close();
        match settings::get(app).keep_running_on_close {
            Some(true) => decide_now(app, QuitDecision::Keep),
            Some(false) => decide_now(app, QuitDecision::Close),
            None => ask(app, live),
        }
    } else if cfg!(target_os = "macos") {
        // a Mac app stays running with its window closed; the Dock icon brings it back
        api.prevent_close();
        let _ = window.hide();
    } else {
        // nothing running: let the window close; the app exits with it
        registry.quit_confirmed.store(true, Ordering::SeqCst);
    }
}

/// `App::run` handler.
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let registry = app.state::<ShutdownRegistry>();
            // Some(code) = app.exit()/restart() called by us; those already went through the decision.
            // On macOS a request without a code comes from outside (see the module docs).
            if code.is_some() || registry.quit_confirmed.load(Ordering::SeqCst) || cfg!(target_os = "macos") {
                return;
            }
            let live = registry.live_count();
            if live > 0 {
                api.prevent_exit();
                ask(app, live);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => app.state::<ShutdownRegistry>().run_hooks(),
        _ => {}
    }
}

/// Quit requested from a menu or the tray: asks first when terminals run.
pub fn request_quit(app: &AppHandle) {
    let live = app.state::<ShutdownRegistry>().live_count();
    if live > 0 {
        ask(app, live);
    } else {
        app.state::<ShutdownRegistry>()
            .quit_confirmed
            .store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

/// tauri-plugin-single-instance callback: a second launch focuses this one and hands over its arguments.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    show_main(app);
    // drop the program path
    open_request::receive(app, args.get(1..).unwrap_or_default(), std::path::Path::new(&cwd));
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn ask(app: &AppHandle, live: usize) {
    show_main(app);
    let payload = CloseRequest {
        terminals: u32::try_from(live).unwrap_or(u32::MAX),
    };
    if let Err(e) = app.emit(events::APP_CLOSE_REQUESTED, payload) {
        log::error!("could not ask about closing: {e}");
    }
}

/// Applies a decision from inside an event handler (UI thread): the slow part runs elsewhere.
fn decide_now(app: &AppHandle, decision: QuitDecision) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = decide(app, decision).await {
            log::error!("could not apply quit decision: {e}");
        }
    });
}

async fn decide(app: AppHandle, decision: QuitDecision) -> AppResult<()> {
    match decision {
        QuitDecision::Cancel => {}
        QuitDecision::Keep => {
            if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
                let can_come_back =
                    cfg!(target_os = "macos") || app.state::<ShutdownRegistry>().tray_present.load(Ordering::SeqCst);
                if can_come_back {
                    w.hide()?;
                } else {
                    w.minimize()?;
                }
            }
        }
        QuitDecision::Close => {
            app.state::<ShutdownRegistry>()
                .quit_confirmed
                .store(true, Ordering::SeqCst);
            // killing process trees can take a moment; keep it off the UI thread
            let handle = app.clone();
            blocking(move || {
                handle.state::<ShutdownRegistry>().run_hooks();
                Ok(())
            })
            .await?;
            app.exit(0);
        }
    }
    Ok(())
}

// ---- commands ----

/// The user's answer to `app:close-requested`.
#[tauri::command]
pub async fn app_quit_decision(app: AppHandle, decision: QuitDecision) -> AppResult<()> {
    decide(app, decision).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Counting {
        live: usize,
        shutdowns: Arc<AtomicUsize>,
    }

    impl ShutdownHook for Counting {
        fn live_count(&self) -> usize {
            self.live
        }
        fn shutdown(&self) {
            self.shutdowns.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn sums_live_counts_and_runs_hooks_once() {
        let registry = ShutdownRegistry::default();
        let shutdowns = Arc::new(AtomicUsize::new(0));
        registry.register(Arc::new(Counting {
            live: 2,
            shutdowns: shutdowns.clone(),
        }));
        registry.register(Arc::new(Counting {
            live: 1,
            shutdowns: shutdowns.clone(),
        }));
        assert_eq!(registry.live_count(), 3);
        registry.run_hooks();
        registry.run_hooks();
        assert_eq!(shutdowns.load(Ordering::SeqCst), 2);
    }
}
