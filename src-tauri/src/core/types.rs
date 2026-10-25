//! Types shared across features and with the webview. Each derives `TS` and is exported to
//! `src/bindings/` when `cargo test` runs; CI fails if the committed bindings differ.
//!
//! Adding a field is fine; renaming or removing one is a contract change for every feature.
//! Still to come here: `LiveSession` (provided by WP3) and `TermInfo` (provided by WP2).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// A Claude Code config folder (`~/.claude`, `~/.claude-work`, or `$CLAUDE_CONFIG_DIR`).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Profile {
    pub dir: String,
    /// "default" for ~/.claude, otherwise the folder name without the `.claude-` prefix.
    pub name: String,
    /// `oauthAccount.emailAddress` from the profile's `.claude.json`; null when not signed in.
    pub email: Option<String>,
    /// Whether usable credentials exist. Null until the usage feature checks it (provided by WP7).
    pub signed_in: Option<bool>,
    pub is_default: bool,
}

/// One transcript: `<profile>/projects/<slug>/<id>.jsonl`.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Session {
    /// UUID; files whose name is not a UUID are never listed.
    pub id: String,
    pub file: String,
    pub cwd: Option<String>,
    /// Title, summary or first prompt, whitespace collapsed, at most 140 characters.
    pub label: String,
    /// The same text at most 600 characters, for tooltips and the details pane.
    pub full: String,
    /// User messages (tool results excluded).
    pub count: u32,
    /// Last write, ms since the Unix epoch.
    pub modified: u64,
    pub size_kb: u64,
    /// Profile folder the transcript belongs to.
    pub profile: String,
    /// Name of the `projects/<slug>` folder.
    pub slug: String,
}

/// Sessions grouped by the folder they ran in.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub modified: u64,
    pub sessions: Vec<Session>,
}

/// How "New session" opens by default.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum OpenIn {
    #[default]
    External,
    Embed,
}

/// A named sidebar group. It only references folders; nothing on disk moves.
#[derive(Serialize, Deserialize, TS, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct Group {
    pub name: String,
    pub folders: Vec<String>,
    pub collapsed: bool,
}

/// Everything the app remembers between runs (`<app config dir>/settings.json`).
/// Keys this version does not know are kept and written back unchanged.
#[derive(Serialize, Deserialize, TS, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct Settings {
    /// Pinned project folders, shown even without sessions.
    pub pinned: Vec<String>,
    /// Profile folder of the account last used for new sessions.
    pub account: Option<String>,
    pub open_in: OpenIn,
    pub show_picker: bool,
    /// "all" or a profile folder.
    pub last_profile: Option<String>,
    pub groups: Vec<Group>,
    pub ungrouped_collapsed: bool,
    pub show_usage: bool,
    pub notify: bool,
    /// Terminals left running in the background, kept for the cross-restart feature (WP2).
    #[ts(type = "unknown[]")]
    pub bg_terms: Vec<Value>,
    pub sidebar_width: u32,
    /// Source control split position; null = default layout.
    pub git_split: Option<f64>,
    /// Absolute path to the claude executable, overriding discovery.
    pub claude_path: Option<String>,
    pub mac_option_is_meta: bool,
    pub scrollback: u32,
    /// Remembered answer to "keep terminals running when the window closes?"; null = ask.
    pub keep_running_on_close: Option<bool>,
    /// Keys this version does not know (Rust side only).
    #[serde(flatten)]
    #[ts(skip)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            pinned: Vec::new(),
            account: None,
            open_in: OpenIn::External,
            show_picker: true,
            last_profile: None,
            groups: Vec::new(),
            ungrouped_collapsed: false,
            show_usage: true,
            notify: true,
            bg_terms: Vec::new(),
            sidebar_width: 340,
            git_split: None,
            claude_path: None,
            mac_option_is_meta: true,
            scrollback: 5000,
            keep_running_on_close: None,
            extra: Map::new(),
        }
    }
}

/// `platform_info` result.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct PlatformInfo {
    /// "windows", "macos" or "linux".
    pub os: String,
    /// Windows build number (e.g. "19045", used for ConPTY quirks) or the macOS version.
    pub build: String,
    /// "x86_64", "aarch64", ...
    pub arch: String,
}

/// `env_status` result: what was found on this machine. Null = not found.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EnvStatus {
    pub claude_path: Option<String>,
    pub shell_path: String,
    pub git_path: Option<String>,
    pub code_path: Option<String>,
}

/// Payload of `app:close-requested`: the window or app is closing while terminals still run.
/// The frontend asks the user and answers with `app_quit_decision`.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct CloseRequest {
    pub terminals: u32,
}

/// Answer to a [`CloseRequest`].
#[derive(Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum QuitDecision {
    /// Do nothing.
    Cancel,
    /// End all terminals and exit.
    Close,
    /// Hide the window; terminals keep running.
    Keep,
}

/// Payload of `app:open-args`: a second launch forwarded its command line (program name removed).
/// Untrusted input: features validate every value before acting on it.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct OpenArgs {
    pub args: Vec<String>,
    pub cwd: String,
}

/// Payload of `menu`: a native menu item with a custom id was chosen.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct MenuEvent {
    pub id: String,
}
