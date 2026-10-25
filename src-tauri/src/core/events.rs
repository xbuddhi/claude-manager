//! Names of every event the backend emits. Payload types live in `core::types` or the owning feature.
//! A feature adds its own names directly under its block's marker line (never edit a marker).

// ---- core ----
/// Payload: `Settings` (the full new value).
pub const SETTINGS_CHANGED: &str = "settings-changed";
/// Payload: `Profile[]` (the full new list).
pub const PROFILES_CHANGED: &str = "profiles-changed";
/// Payload: `CloseRequest`.
pub const APP_CLOSE_REQUESTED: &str = "app:close-requested";
/// No payload: an `OpenRequest` is waiting; take it with `take_open_request`.
pub const APP_OPEN_REQUEST: &str = "app:open-request";
/// Payload: `MenuEvent`.
pub const MENU: &str = "menu";
// ---- sessions (WP1) ----
// ---- pty + launch (WP2) ----
// ---- live + notify (WP3) ----
/// Payload: `LiveChanged` (every running session; sent only when an id or level changed).
pub const LIVE_CHANGED: &str = "live-changed";
/// Payload: `NotifyClicked`: a finish notification was clicked; the window is already shown.
pub const NOTIFY_CLICKED: &str = "notify:clicked";
// ---- usage (WP7) ----
// ---- git (WP8) ----
// ---- os (WP9) ----
