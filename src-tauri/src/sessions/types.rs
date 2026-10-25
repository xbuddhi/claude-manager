//! IPC types of the session index.

use crate::core::types::Project;
use serde::Serialize;
use ts_rs::TS;

/// `get_index` result.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IndexSnapshot {
    /// Grows whenever the projects change. 0 while the first scan runs.
    #[serde(rename = "gen")]
    pub generation: u64,
    /// False until the first scan is done; `index-changed` follows when it is.
    pub ready: bool,
    /// Every project; null when `gen` equals the `sinceGen` asked with (nothing changed).
    pub projects: Option<Vec<Project>>,
    /// Listed sessions per profile folder, for every profile that has any.
    pub counts: Vec<ProfileCount>,
}

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProfileCount {
    pub profile: String,
    pub count: u32,
}

/// Payload of `index-changed`.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct IndexChanged {
    #[serde(rename = "gen")]
    pub generation: u64,
}
