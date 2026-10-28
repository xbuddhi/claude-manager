//! Types shared across features and with the webview. Each derives `TS` and is exported to
//! `src/bindings/` when `cargo test` runs; CI fails if the committed bindings differ.
//!
//! Only types that several features or the foundation itself use live here. A type used by one feature's
//! commands and events lives in that feature's module (e.g. `live/types.rs`); ts-rs exports it from
//! there the same way. Adding a field is fine; renaming or removing one is a contract change for every
//! feature.

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
    /// Whether usable credentials exist; null when unknown (the usage feature registers the check, WP7).
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
    /// The transcript is only partly read yet (fast first scan): `count` is a lower bound.
    pub partial: bool,
}

/// Sessions grouped by the folder they ran in.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub modified: u64,
    /// In `settings.pinned`; a pinned folder is listed even without sessions.
    pub pinned: bool,
    /// The folder no longer exists on disk.
    pub missing: bool,
    pub sessions: Vec<Session>,
}

/// A claude process that is running now (found by the live-session scan, provided by WP3).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveSession {
    pub session_id: String,
    pub pid: u32,
    /// 1 = open and idle, 2 = working.
    #[ts(type = "1 | 2")]
    pub level: u8,
    pub cwd: Option<String>,
    /// Profile folder the session belongs to.
    pub profile: String,
    /// Whether the app can bring it to the front (one of its own terminals, or a terminal window).
    pub reachable: bool,
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

/// Where the sidebar lives. Classic: on Home only, under full-width tabs. Docked: always there, full height,
/// with the tabs and the Home card or a terminal beside it.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SidebarStyle {
    #[default]
    Classic,
    Docked,
}

/// Light or dark for the app: as the OS is set, or always one.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Light or dark for the terminals: the same as the app, or always one.
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum TerminalTheme {
    #[default]
    App,
    Light,
    Dark,
}

/// Colour scheme for the terminals; each has a dark and a light version (the terminal theme picks one).
#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum TerminalColors {
    #[default]
    Default,
    One,
    Catppuccin,
    TokyoNight,
    RosePine,
    Gruvbox,
    Solarized,
    Github,
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
    /// Folders hidden from the sidebar's FOLDERS list (shown again from its "Show N hidden" row).
    pub hidden: Vec<String>,
    /// Ids of archived sessions: left out of the sessions list (shown again from its "Archived" button).
    pub archived: Vec<String>,
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
    /// Sidebar hidden: it slides in over the content while the pointer is at the left edge.
    pub sidebar_hidden: bool,
    pub sidebar_style: SidebarStyle,
    pub theme: Theme,
    pub terminal_theme: TerminalTheme,
    pub terminal_colors: TerminalColors,
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
            hidden: Vec::new(),
            archived: Vec::new(),
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
            sidebar_hidden: false,
            sidebar_style: SidebarStyle::Classic,
            theme: Theme::System,
            terminal_theme: TerminalTheme::App,
            terminal_colors: TerminalColors::Default,
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

/// Answer to `window:close-requested` (a [`CloseRequest`] for one window while others stay open).
#[derive(Deserialize, TS, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum WindowDecision {
    /// Keep the window open.
    Cancel,
    /// End its terminals and close it.
    Close,
    /// Move its terminals to another window and close it.
    Move,
}

/// A validated request from outside the app to start a session in a folder (see `core::open_request`).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[ts(export)]
pub struct OpenRequest {
    /// An existing folder.
    pub dir: String,
    /// A discovered profile folder; null = the start profile.
    pub profile: Option<String>,
}

/// Payload of `menu`: a native menu item with a custom id was chosen.
#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct MenuEvent {
    pub id: String,
}
