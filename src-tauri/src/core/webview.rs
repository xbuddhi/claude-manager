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
    harden(WebviewWindowBuilder::from_config(app.handle(), &config)?, app.config()).build()?;
    Ok(())
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
