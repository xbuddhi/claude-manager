//! Source control (WP8): runs git for the "Source Control" view, finds the repositories of a sidebar
//! folder, parses status and reads new files for the diff view.

pub mod files;
pub mod guard;
pub mod repos;
pub mod run;
pub mod status;

use crate::core::error::{AppError, AppResult, blocking};
use files::NewFile;
use run::GitOutput;
use status::GitStatus;

// ---- commands ----

/// Runs `git <args>` in the existing folder `dir`. `stdin` is written to git's input (commit messages);
/// `poll` marks the view's background refresh. A failing git is a result (`code` != 0), not an error.
#[tauri::command]
pub async fn git_run(
    dir: String,
    args: Vec<String>,
    stdin: Option<String>,
    poll: Option<bool>,
) -> AppResult<GitOutput> {
    blocking(move || run::run(&dir, &args, stdin.as_deref(), poll.unwrap_or(false))).await
}

/// Branch, sync state and changed files of `repo`. A git error becomes an error with git's message.
#[tauri::command]
pub async fn git_status(repo: String, poll: Option<bool>) -> AppResult<GitStatus> {
    blocking(move || {
        let args: Vec<String> = status::ARGS.iter().map(|s| s.to_string()).collect();
        let out = run::run(&repo, &args, None, poll.unwrap_or(false))?;
        if out.code != 0 {
            let text = out.stderr.trim();
            return Err(AppError::Internal(if text.is_empty() {
                format!("git failed (exit {})", out.code)
            } else {
                text.to_string()
            }));
        }
        Ok(status::parse(&out.stdout))
    })
    .await
}

/// Repositories at or under `path` (the folder itself, then sub-folders two levels deep).
#[tauri::command]
pub async fn find_repos(path: String) -> AppResult<Vec<String>> {
    blocking(move || Ok(repos::find(&path))).await
}

/// An untracked file of `repo` for the diff view.
#[tauri::command]
pub async fn read_new_file(repo: String, path: String) -> AppResult<NewFile> {
    blocking(move || files::read(&repo, &path)).await
}
