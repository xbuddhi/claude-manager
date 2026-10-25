//! Window creation with the navigation guard. Every app window must be built through [`harden`]:
//! the webview may only show the app itself, and `window.open` never creates a window.

use super::error::{AppError, AppResult};
use super::lifecycle::MAIN_WINDOW;
use tauri::webview::NewWindowResponse;
use tauri::{App, Config, Manager, Runtime, Url, WebviewWindowBuilder};

/// Creates the main window from its `tauri.conf.json` entry (which has `create: false` for this reason).
pub fn create_main_window(app: &App) -> AppResult<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .ok_or_else(|| AppError::Internal("tauri.conf.json has no main window".into()))?
        .clone();
    let window = harden(WebviewWindowBuilder::from_config(app.handle(), &config)?, app.config()).build()?;
    recover_on_crash(&window);
    Ok(())
}

/// Windows: when the page's process inside WebView2 crashes or hangs (it happens after sleep or a GPU reset),
/// reload the page instead of leaving a dead window. Terminals keep running in the backend and reattach with
/// their recent output. A dead browser process cannot be reloaded; that is logged.
pub fn recover_on_crash<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let result = window.with_webview(move |webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            };
            use webview2_com::ProcessFailedEventHandler;
            let label2 = label.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                if let Some(args) = args {
                    // SAFETY: a live event-args object handed to us by WebView2 for this call
                    let _ = unsafe { args.ProcessFailedKind(&mut kind) };
                }
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                    || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE
                {
                    log::warn!("window {label2}: WebView2 page process failed ({}), reloading", kind.0);
                    if let Some(core) = sender {
                        // SAFETY: the WebView2 that raised the event, on its UI thread
                        let _ = unsafe { core.Reload() };
                    }
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    log::error!("window {label2}: WebView2 browser process exited");
                } else {
                    log::warn!("window {label2}: WebView2 helper process failed ({})", kind.0);
                }
                Ok(())
            }));
            let mut token = 0i64;
            // SAFETY: called on the UI thread with this window's live WebView2 controller
            let outcome = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.add_ProcessFailed(&handler, &mut token))
            };
            if let Err(e) = outcome {
                log::warn!("window {label}: no WebView2 crash recovery: {e}");
            }
        });
        if let Err(e) = result {
            log::warn!("no WebView2 crash recovery: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Adds the navigation guard and blocks new windows. `config` is the app's (`app.config()`).
pub fn harden<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    config: &Config,
) -> WebviewWindowBuilder<'a, R, M> {
    // the dev server is only trusted in debug builds
    let dev_url = if cfg!(debug_assertions) {
        config.build.dev_url.clone()
    } else {
        None
    };
    builder
        .on_navigation(move |url| {
            let allowed = is_app_url(url, dev_url.as_ref());
            if !allowed {
                log::warn!("blocked navigation to {url}");
            }
            allowed
        })
        .on_new_window(|url, _| {
            log::warn!("blocked new window for {url}");
            NewWindowResponse::Deny
        })
}

/// The app's own pages: `tauri://localhost` (macOS), `http(s)://tauri.localhost` (Windows), or the dev server.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        _ => dev_url.is_some_and(|dev| dev.origin() == url.origin()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn allows_only_app_origins() {
        let dev = url("http://localhost:1420");
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/x",
        ] {
            assert!(is_app_url(&url(ok), None), "{ok}");
        }
        assert!(is_app_url(&url("http://localhost:1420/src/main.ts"), Some(&dev)));
        for bad in [
            "http://localhost:1420/",
            "https://evil.test/",
            "http://tauri.localhost.evil.test/",
            "tauri://evil",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_url(&url(bad), None), "{bad}");
        }
        assert!(!is_app_url(&url("http://localhost:1421/"), Some(&dev)));
    }
}
