//! IPC types of the live-session feature.

use crate::core::types::LiveSession;
use serde::Serialize;
use std::collections::BTreeMap;
use ts_rs::TS;

/// Payload of `live-changed` and result of `get_live`: every running session, and the highest level per
/// folder.
#[derive(Serialize, TS, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveChanged {
    pub sessions: Vec<LiveSession>,
    /// Keyed by `core::paths::key` of the folder (the frontend's `pathKey`): 1 = open, 2 = working.
    #[ts(type = "Record<string, 1 | 2>")]
    pub live_cwd: BTreeMap<String, u8>,
}

/// A running claude process that no window can bring to the front (`find_orphans`).
#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Orphan {
    pub pid: u32,
    pub session_id: String,
    pub cwd: Option<String>,
    /// Profile folder the session belongs to.
    pub profile: String,
}
