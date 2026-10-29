//! "Pull requests" in Source control: the repository's open pull requests from GitHub, through the user's
//! own GitHub CLI (`gh`, signed in with `gh auth login`). The app holds no token: gh runs in the
//! repository with fixed arguments and answers JSON. Without gh, or signed out, the view says so.

use super::guard;
use crate::core::error::AppResult;
use crate::core::{env, spawn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use ts_rs::TS;

const LIMIT: Duration = Duration::from_secs(30);
/// Open pull requests asked for (gh lists the newest first).
const MAX_PRS: &str = "100";
const FIELDS: &str = "number,title,author,headRefName,isDraft,updatedAt,url";

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PullRequest {
    pub number: u32,
    pub title: String,
    /// The author's login ("" when GitHub gives none, e.g. a deleted account).
    pub author: String,
    /// The branch it would merge.
    pub branch: String,
    pub draft: bool,
    /// Last change, RFC 3339.
    pub updated: String,
    /// Its page (https).
    pub url: String,
}

#[derive(Serialize, TS, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PullRequests {
    List {
        prs: Vec<PullRequest>,
    },
    /// The GitHub CLI is not installed.
    NoGh,
    /// gh is not signed in to GitHub.
    SignedOut,
    /// gh ran and failed (no GitHub remote, offline, ...): its message.
    Failed {
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhPr {
    number: u32,
    title: String,
    author: Option<GhAuthor>,
    head_ref_name: String,
    is_draft: bool,
    updated_at: String,
    url: String,
}

#[derive(Deserialize)]
struct GhAuthor {
    login: String,
}

/// gh's JSON as pull requests; links that are not https are dropped (the view opens them).
pub fn parse(json: &str) -> Option<Vec<PullRequest>> {
    let list: Vec<GhPr> = serde_json::from_str(json).ok()?;
    Some(
        list.into_iter()
            .filter(|p| p.url.starts_with("https://"))
            .map(|p| PullRequest {
                number: p.number,
                title: p.title,
                author: p.author.map(|a| a.login).unwrap_or_default(),
                branch: p.head_ref_name,
                draft: p.is_draft,
                updated: p.updated_at,
                url: p.url,
            })
            .collect(),
    )
}

/// What a failed gh said, as the view shows it.
pub fn failure(stderr: &str) -> PullRequests {
    let text = stderr.trim();
    if text.contains("gh auth login") || text.contains("not logged in") {
        return PullRequests::SignedOut;
    }
    let message = if text.contains("none of the git remotes") || text.contains("no git remotes") {
        "This repository has no GitHub remote.".to_string()
    } else if text.is_empty() {
        "The GitHub CLI could not list the pull requests.".to_string()
    } else {
        text.lines().next().unwrap_or(text).to_string()
    };
    PullRequests::Failed { message }
}

/// The gh program on the PATH children get (the login shell's on macOS).
fn gh() -> Option<PathBuf> {
    let resolved = env::wait_env();
    let path = resolved.path.clone().or_else(|| std::env::var_os("PATH"));
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    env::find_in_path(path.as_deref(), name).or_else(|| {
        // Homebrew's folders, for an app started from Finder whose shell probe failed
        (!cfg!(windows))
            .then(|| ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].map(PathBuf::from))
            .and_then(|c| c.into_iter().find(|p| p.is_file()))
    })
}

/// The open pull requests of the repository at `repo`.
pub fn list(repo: &str) -> AppResult<PullRequests> {
    let dir = guard::folder(repo, true)?;
    let Some(gh) = gh() else {
        return Ok(PullRequests::NoGh);
    };
    let mut cmd = spawn::hidden_command(&gh);
    cmd.current_dir(&dir)
        .args(["pr", "list", "--state", "open", "--limit", MAX_PRS, "--json", FIELDS])
        // never ask anything in a window nobody sees; plain output
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1");
    if let Some(path) = &env::wait_env().path {
        cmd.env("PATH", path); // gh runs git
    }
    let out = spawn::output_with_timeout(&mut cmd, LIMIT)?;
    if !out.status.success() {
        return Ok(failure(&String::from_utf8_lossy(&out.stderr)));
    }
    Ok(match parse(&String::from_utf8_lossy(&out.stdout)) {
        Some(prs) => PullRequests::List { prs },
        None => PullRequests::Failed {
            message: "The GitHub CLI answered something unexpected.".into(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_gh_json() {
        let json = r#"[
          {"number":179,"title":"Fix payouts","author":{"login":"rayaanr"},"headRefName":"rr/payouts",
           "isDraft":false,"updatedAt":"2026-10-29T09:00:00Z","url":"https://github.com/o/r/pull/179"},
          {"number":7,"title":"Odd","author":null,"headRefName":"x","isDraft":true,
           "updatedAt":"2026-10-01T00:00:00Z","url":"javascript:alert(1)"}
        ]"#;
        let prs = parse(json).unwrap();
        assert_eq!(prs.len(), 1, "a link that is not https is dropped");
        assert_eq!(prs[0].number, 179);
        assert_eq!(prs[0].author, "rayaanr");
        assert_eq!(prs[0].branch, "rr/payouts");
        assert!(parse("not json").is_none());
    }

    #[test]
    fn names_why_gh_failed() {
        assert_eq!(
            failure("To get started with GitHub CLI, please run:  gh auth login"),
            PullRequests::SignedOut
        );
        assert_eq!(
            failure("none of the git remotes configured for this repository point to a known GitHub host"),
            PullRequests::Failed {
                message: "This repository has no GitHub remote.".into()
            }
        );
        assert_eq!(
            failure("error connecting to api.github.com\nmore"),
            PullRequests::Failed {
                message: "error connecting to api.github.com".into()
            }
        );
    }
}
