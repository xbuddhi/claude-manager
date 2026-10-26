//! Names of every event the backend emits. Payload types live in `core::types` or the owning feature.
//! A feature adds its own names directly under its block's marker line (never edit a marker).

// ---- core ----
/// Payload: `Settings` (the full new value).
pub const SETTINGS_CHANGED: &str = "settings-changed";
/// Payload: `Profile[]` (the full new list).
pub const PROFILES_CHANGED: &str = "profiles-changed";
/// Payload: `CloseRequest`. Sent to the window in front only.
pub const APP_CLOSE_REQUESTED: &str = "app:close-requested";
/// Payload: `CloseRequest` (that window's terminals). Sent to the window being closed while others stay;
/// answered with `window_close_decision`.
pub const WINDOW_CLOSE_REQUESTED: &str = "window:close-requested";
/// No payload: an `OpenRequest` is waiting; take it with `take_open_request`.
pub const APP_OPEN_REQUEST: &str = "app:open-request";
/// Payload: `MenuEvent`.
pub const MENU: &str = "menu";
// ---- sessions (WP1) ----
/// Payload: `IndexChanged` (`sessions::types`): the index has a new generation; fetch it with `get_index`.
pub const INDEX_CHANGED: &str = "index-changed";
// ---- pty + launch (WP2) ----
/// Payload: `number[]`, terminal ids moved to the receiving window; it takes them over with `pty_attach`.
pub const PTY_MOVED: &str = "pty-moved";
/// Payload: `number`, a terminal id: the receiving window brings that terminal's tab to the front.
pub const PTY_FOCUS: &str = "pty-focus";
// ---- live + notify (WP3) ----
/// Payload: `LiveChanged` (every running session; sent only when an id or level changed).
pub const LIVE_CHANGED: &str = "live-changed";
/// Payload: `NotifyClicked`: a finish notification was clicked; the window is already shown.
pub const NOTIFY_CLICKED: &str = "notify:clicked";
// ---- usage (WP7) ----
/// Payload: `PlansUpdate` (usage::types): plan limits in view, at the start and the end of a refresh.
pub const USAGE_PLANS: &str = "usage-plans";
// ---- git (WP8) ----
// ---- os (WP9) ----
