//! Names of every event the backend emits. Payload types live in `core::types` or the owning feature.
//! A feature adds its own names in its block below.

// ---- core ----
/// Payload: `Settings` (the full new value).
pub const SETTINGS_CHANGED: &str = "settings-changed";
/// Payload: `Profile[]` (the full new list).
pub const PROFILES_CHANGED: &str = "profiles-changed";
/// Payload: `CloseRequest`.
pub const APP_CLOSE_REQUESTED: &str = "app:close-requested";
/// Payload: `OpenArgs`.
pub const APP_OPEN_ARGS: &str = "app:open-args";
/// Payload: `MenuEvent`.
pub const MENU: &str = "menu";
// ---- sessions (WP1) ----
// ---- live + notify (WP3) ----
// ---- usage (WP7) ----
// ---- git (WP8) ----
