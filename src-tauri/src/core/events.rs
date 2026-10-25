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
// ---- usage (WP7) ----
/// Payload: `PlansUpdate` (usage::types): plan limits in view, at the start and the end of a refresh.
pub const USAGE_PLANS: &str = "usage-plans";
// ---- git (WP8) ----
// ---- os (WP9) ----
