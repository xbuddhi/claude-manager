//! IPC types of the session index.

use crate::core::types::Project;
use serde::{Serialize, Serializer};
use std::sync::Arc;
use ts_rs::TS;

/// Projects shared with the index's grouped generations: sending them does not copy them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProjectList(pub Vec<Arc<Project>>);

impl Serialize for ProjectList {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(|p| &**p))
    }
}

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
    /// Every project; null when `gen` equals the `sinceGen` asked with (nothing changed), or when only
    /// the changes are sent (`base` is set).
    #[ts(as = "Option<Vec<Project>>")]
    pub projects: Option<ProjectList>,
    /// Listed sessions per profile folder, for every profile that has any.
    pub counts: Vec<ProfileCount>,
    /// Set when only the changes since generation `base` (the `sinceGen` asked with) are sent: `changed`
    /// and `order` replace `projects`.
    pub base: Option<u64>,
    /// With `base`: the projects that are new or differ from generation `base`.
    #[ts(as = "Option<Vec<Project>>")]
    pub changed: Option<ProjectList>,
    /// With `base`: the path of every project, in display order. A path of generation `base` that is not
    /// here was removed; one not in `changed` is unchanged.
    pub order: Option<Vec<String>>,
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
