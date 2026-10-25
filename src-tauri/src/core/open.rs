//! Opening things outside the app: the log folder and https links. The webview has no opener
//! permissions; it asks through these commands, which accept nothing else.

use super::error::{AppError, AppResult};
use super::paths;
use tauri::{AppHandle, Url};
use tauri_plugin_opener::OpenerExt;

/// Opens the app's log folder in Explorer or Finder (creating it first, so there is always something to show).
pub fn show_log_dir(app: &AppHandle) -> AppResult<()> {
    let dir = paths::app_log_dir(app)?;
    std::fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the log folder: {e}")))
}

/// Accepts only a plain `https://host/...` link: no other scheme, no credentials.
pub fn https_url(text: &str) -> AppResult<Url> {
    let url = Url::parse(text.trim()).map_err(|_| AppError::InvalidInput(format!("Not a link: {text}")))?;
    let plain = url.scheme() == "https"
        && url.host_str().is_some_and(|h| !h.is_empty())
        && url.username().is_empty()
        && url.password().is_none();
    if !plain {
        return Err(AppError::InvalidInput(format!(
            "Only https links can be opened: {text}"
        )));
    }
    Ok(url)
}

// ---- commands ----

#[tauri::command]
pub async fn open_log_dir(app: AppHandle) -> AppResult<()> {
    super::error::blocking(move || show_log_dir(&app)).await
}

/// Opens an https link in the default browser.
#[tauri::command]
pub async fn open_url_https(app: AppHandle, url: String) -> AppResult<()> {
    let url = https_url(&url)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| AppError::Internal(format!("could not open the link: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_plain_https_links() {
        assert!(https_url("https://code.claude.com/docs/en/setup").is_ok());
        for bad in [
            "http://example.com/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "https://user:pw@example.com/",
            "ms-settings:privacy",
            "not a url",
        ] {
            assert!(matches!(https_url(bad), Err(AppError::InvalidInput(_))), "{bad}");
        }
    }
}
