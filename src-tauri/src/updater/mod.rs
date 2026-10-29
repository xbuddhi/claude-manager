//! In-app updates (WP10) through tauri-plugin-updater, signed and served from the GitHub release's
//! `latest.json`.
//!
//! The plugin refuses to start without a `plugins.updater` config, and the app ships without one until a
//! release repository and signing key exist (docs/port/README.md). So it is registered here, at setup,
//! only when the config has a public key and https endpoints; the release workflow adds that config
//! (scripts/release-config.mjs). Without it the webview's `check` call fails with "plugin not found" and
//! the updater feature reports "disabled".

use crate::core::error::AppResult;
use serde_json::Value;

pub fn init(app: &mut tauri::App) -> AppResult<()> {
    if configured(app.config().plugins.0.get("updater")) {
        app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
        log::info!("updater enabled");
    } else {
        log::info!("updater disabled: no release endpoint or public key configured");
    }
    Ok(())
}

/// True when `plugins.updater` has a public key and at least one endpoint, every one of them https.
pub fn configured(config: Option<&Value>) -> bool {
    let Some(config) = config else {
        return false;
    };
    let has_key = config
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|k| !k.trim().is_empty());
    let endpoints = config.get("endpoints").and_then(Value::as_array);
    let https = endpoints.is_some_and(|list| {
        !list.is_empty()
            && list
                .iter()
                .all(|e| e.as_str().is_some_and(|u| u.starts_with("https://")))
    });
    has_key && https
}

/// macOS runs a downloaded app that was opened where it landed (the dmg, Downloads) from a read-only copy
/// under `.../AppTranslocation/` ("App Translocation"); an update cannot replace that copy.
pub fn is_translocated(exe: &std::path::Path) -> bool {
    exe.components().any(|c| c.as_os_str() == "AppTranslocation")
}

/// True when this app runs from such a read-only copy (always false outside macOS).
#[tauri::command]
pub async fn app_translocated() -> AppResult<bool> {
    Ok(cfg!(target_os = "macos") && std::env::current_exe().is_ok_and(|exe| is_translocated(&exe)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sees_a_translocated_app() {
        use std::path::Path;
        let moved =
            "/private/var/folders/g5/x/T/AppTranslocation/6EC0/d/Claude Manager.app/Contents/MacOS/claude-manager";
        assert!(is_translocated(Path::new(moved)));
        let installed = "/Applications/Claude Manager.app/Contents/MacOS/claude-manager";
        assert!(!is_translocated(Path::new(installed)));
    }

    #[test]
    fn needs_a_key_and_https_endpoints() {
        let url = "https://github.com/o/r/releases/latest/download/latest.json";
        assert!(configured(Some(&json!({ "pubkey": "abc", "endpoints": [url] }))));
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
        assert!(!configured(Some(&json!({ "pubkey": "", "endpoints": [url] }))));
        assert!(!configured(Some(&json!({ "pubkey": "abc", "endpoints": [] }))));
        assert!(!configured(Some(&json!({ "pubkey": "abc" }))));
        assert!(!configured(Some(
            &json!({ "pubkey": "abc", "endpoints": [url, "http://example.com/latest.json"] })
        )));
    }
}
