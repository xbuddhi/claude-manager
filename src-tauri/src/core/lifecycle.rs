//! Window close, quit, reopen and exit.
//!
//! - The app has one or more windows (`core::windows`). Closing one while others are on screen closes
//!   only it: when it has running terminals the backend emits `window:close-requested` to it and the
//!   frontend answers with `window_close_decision` (cancel / close them / move them to another window).
//!   The main window is hidden rather than destroyed (the tray, the Dock and notifications bring it back).
//! - Closing the last window on screen, or quitting while terminals run, asks first: the backend emits
//!   `app:close-requested` to the window in front and the frontend answers with `app_quit_decision`
//!   (cancel / close / keep).
//! - With nothing running, closing the last window exits on Windows and hides it on macOS (Dock reopens it).
//! - "Keep running" gathers every terminal in the main window, closes the others and hides it: on macOS
//!   the Dock brings it back, on Windows the tray icon (WP9 calls [`set_tray_present`]); until a tray
//!   exists, Windows minimizes instead, so the window can always be found again.
//! - On macOS an exit request from outside the app (Dock Quit, logout, shutdown) is not cancelled: the
//!   app's own Quit goes through [`request_quit`], and asking here would cancel the user's logout. The
//!   hooks still end the terminals; their sessions stay saved and can be resumed.
//! - On exit, every registered [`ShutdownHook`] runs once (terminals are killed, settings flushed).
//!
//! Features plug in through [`register`]: the terminal feature reports how many terminals are live and
//! kills them on shutdown.

use super::error::{AppResult, blocking, lock};
use super::types::{CloseRequest, QuitDecision, WindowDecision};
use super::{events, open_request, settings, windows};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow, Window, WindowEvent};

pub const MAIN_WINDOW: &str = "main";

/// Something that must be told when the app exits or a window closes, and may hold the app open.
pub trait ShutdownHook: Send + Sync + 'static {
    /// Running work that quitting would end (e.g. live terminals). Non-zero makes close and quit ask first.
    fn live_count(&self) -> usize {
        0
    }
    /// The part of [`Self::live_count`] shown in window `label`.
    fn live_in(&self, _label: &str) -> usize {
        0
    }
    /// Gives the work shown in window `from` (in every window but `to` when `None`) to window `to`.
    /// Returns the ids that moved; `to` takes them over on the `pty-moved` event.
    fn hand_over(&self, _from: Option<&str>, _to: &str) -> Vec<u32> {
        Vec::new()
    }
    /// Ends the work shown in window `label`. May block for a moment.
    fn end_in(&self, _label: &str) {}
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

    pub fn live_in(&self, label: &str) -> usize {
        self.snapshot().iter().map(|h| h.live_in(label)).sum()
    }

    pub fn hand_over(&self, from: Option<&str>, to: &str) -> Vec<u32> {
        self.snapshot().iter().flat_map(|h| h.hand_over(from, to)).collect()
    }

    pub fn end_in(&self, label: &str) {
        for hook in self.snapshot() {
            hook.end_in(label);
        }
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
    let label = window.label();
    if !windows::is_app_window(label) {
        return;
    }
    let app = window.app_handle();
    let registry = app.state::<ShutdownRegistry>();
    if registry.quit_confirmed.load(Ordering::SeqCst) {
        return;
    }
    // other windows stay: only this one closes, its terminals move to another window or end
    if windows::visible(app).iter().any(|w| w.label() != label) {
        api.prevent_close();
        let live = registry.live_in(label);
        if live == 0 {
            close_window_now(app, label, WindowDecision::Close);
        } else {
            let payload = CloseRequest {
                terminals: u32::try_from(live).unwrap_or(u32::MAX),
            };
            if let Err(e) = app.emit_to(label, events::WINDOW_CLOSE_REQUESTED, payload) {
                log::error!("could not ask about closing window {label}: {e}");
            }
        }
        return;
    }
    // the last window on screen: closing it closes the app
    let live = registry.live_count();
    if live > 0 {
        api.prevent_close();
        match settings::get(app).keep_running_on_close {
            Some(true) => decide_now(app, QuitDecision::Keep),
            Some(false) => decide_now(app, QuitDecision::Close),
            None => ask(app, live),
        }
    } else if cfg!(target_os = "macos") {
        // a Mac app stays running with its window closed; the Dock icon brings the main window back
        if label == MAIN_WINDOW {
            api.prevent_close();
            let _ = window.hide();
        }
    } else {
        // nothing running: the app exits (the hidden main window would keep it running otherwise)
        api.prevent_close();
        registry.quit_confirmed.store(true, Ordering::SeqCst);
        app.exit(0);
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

/// tauri-plugin-single-instance callback: a second launch hands over its arguments, or (started without
/// any, like a browser) opens a new window while the app is on screen.
pub fn on_second_instance(app: &AppHandle, args: Vec<String>, cwd: String) {
    // drop the program path
    let args = args.get(1..).unwrap_or_default();
    if args.is_empty() && !windows::visible(app).is_empty() {
        new_window(app);
        return;
    }
    show_main(app);
    open_request::receive(app, args, std::path::Path::new(&cwd));
}

/// Opens a new, empty app window.
pub fn new_window(app: &AppHandle) {
    if let Err(e) = windows::create(app, &windows::new_label(), None) {
        log::error!("could not open a new window: {e}");
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        windows::raise(&w);
    }
}

/// The window in front (else the main window), raised; quit questions and menu actions go to it.
pub fn show_front(app: &AppHandle) -> Option<WebviewWindow> {
    let w = windows::front(app)?;
    windows::raise(&w);
    Some(w)
}

fn ask(app: &AppHandle, live: usize) {
    let Some(w) = show_front(app) else {
        return;
    };
    let payload = CloseRequest {
        terminals: u32::try_from(live).unwrap_or(u32::MAX),
    };
    if let Err(e) = app.emit_to(w.label(), events::APP_CLOSE_REQUESTED, payload) {
        log::error!("could not ask about closing: {e}");
    }
}

/// Gives the terminals of window `from` (of every window but `to` when `None`) to window `to`.
fn hand_over(app: &AppHandle, from: Option<&str>, to: &str) {
    let ids = app.state::<ShutdownRegistry>().hand_over(from, to);
    if !ids.is_empty()
        && let Err(e) = app.emit_to(to, events::PTY_MOVED, &ids)
    {
        log::error!("could not move terminals to window {to}: {e}");
    }
}

/// Closes window `label` while others stay: its terminals move to another window or end first. The main
/// window is hidden, not destroyed.
async fn close_window(app: AppHandle, label: String, decision: WindowDecision) -> AppResult<()> {
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    match decision {
        WindowDecision::Cancel => return Ok(()),
        WindowDecision::Move => {
            let others: Vec<WebviewWindow> = windows::visible(&app)
                .into_iter()
                .filter(|w| w.label() != label)
                .collect();
            // the main window when it is on screen, else the oldest other one, else the hidden main window
            let to = others
                .iter()
                .find(|w| w.label() == MAIN_WINDOW)
                .or(others.first())
                .cloned()
                .or_else(|| app.get_webview_window(MAIN_WINDOW).filter(|_| label != MAIN_WINDOW));
            if let Some(to) = to {
                hand_over(&app, Some(&label), to.label());
                windows::raise(&to);
            }
        }
        WindowDecision::Close => {
            let handle = app.clone();
            let from = label.clone();
            blocking(move || {
                handle.state::<ShutdownRegistry>().end_in(&from);
                Ok(())
            })
            .await?;
        }
    }
    if label == MAIN_WINDOW {
        window.hide()?;
    } else {
        window.destroy()?;
    }
    Ok(())
}

fn close_window_now(app: &AppHandle, label: &str, decision: WindowDecision) {
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        if let Err(e) = close_window(app, label, decision).await {
            log::error!("could not close the window: {e}");
        }
    });
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
            // everything comes back in the main window
            hand_over(&app, None, MAIN_WINDOW);
            for w in windows::all(&app) {
                if w.label() != MAIN_WINDOW {
                    w.destroy()?;
                }
            }
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

/// The user's answer to `window:close-requested`, from the window that asked.
#[tauri::command]
pub async fn window_close_decision(app: AppHandle, window: WebviewWindow, decision: WindowDecision) -> AppResult<()> {
    close_window(app, window.label().to_string(), decision).await
}

/// Opens a new, empty app window.
#[tauri::command]
pub async fn window_new(app: AppHandle) -> AppResult<()> {
    windows::create(&app, &windows::new_label(), None)?;
    Ok(())
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
