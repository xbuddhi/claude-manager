//! "Generate commit message": the changes a commit would take (what is staged, else every change and
//! new file, as Commit stages them) go to `claude -p` with Sonnet, which answers with a Conventional
//! Commits message.
//! claude runs in the repository with the user's profile, no tools and no saved session (it would show
//! up as a session in the app). Everything it reads goes in on stdin; its arguments are fixed.

use super::{guard, run};
use crate::core::error::{AppError, AppResult};
use crate::core::{env, paths, profiles, spawn};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How much of the changes is sent; past it the diff is cut and the model is told so.
const MAX_DIFF: usize = 60 * 1024;
/// A new file's text taken into the diff.
const MAX_NEW_FILE: u64 = 8 * 1024;
const GIT_LIMIT: Duration = Duration::from_secs(30);
const CLAUDE_LIMIT: Duration = Duration::from_secs(120);

const ARGS: &[&str] = &[
    "-p",
    "--model",
    "sonnet",
    "--tools",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--output-format",
    "text",
];

/// Conventional Commits 1.0.0 (https://www.conventionalcommits.org).
const PROMPT: &str = "Write a git commit message for the changes below, following Conventional Commits 1.0.0.

Format:
<type>: <description>

<body>

Rules:
- type: feat (a new feature), fix (a bug fix), docs, style (formatting only), refactor (neither fix nor \
feature), perf, test, build (build system or dependencies), ci, chore (other maintenance) or revert. \
Pick the one that fits the main change.
- No scope: never put anything in parentheses after the type (\"feat: ...\", not \"feat(ui): ...\").
- description: imperative mood (\"add\", not \"added\" or \"adds\"), lowercase first letter, no \
period at the end; the whole first line at most 72 characters.
- body: leave it out when the subject says enough. Otherwise a blank line, then 1 to 4 bullets, each \
\"- \" and one short line (at most 72 characters) on what changed or why; never paragraphs, never \
implementation details (function names, sizes, internals) unless they matter to a reader of the log.
- A breaking change (removed or renamed public API, config or behaviour users rely on): add ! before \
the colon and a footer \"BREAKING CHANGE: <what breaks and what to do>\".
- No other footers or trailers (no Co-Authored-By, no sign-off, no issue numbers unless they appear \
in the changes).

Reply with only the commit message: no quotes, code fences, explanations or alternatives.";

fn git_text(git: &Path, repo: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = run::command(git, repo, true);
    cmd.args(args);
    let out = run::execute(&mut cmd, None, GIT_LIMIT).ok()?;
    (out.code == 0).then_some(out.stdout)
}

/// A new file as diff-like text, when it is small text; else only its name.
fn new_file(repo: &Path, rel: &str) -> String {
    let path = repo.join(rel);
    let text = std::fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file() && m.len() <= MAX_NEW_FILE)
        .and_then(|_| std::fs::read(&path).ok())
        .filter(|bytes| !bytes.contains(&0))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    match text {
        Some(t) => format!("new file {rel}\n{t}\n"),
        None => format!("new file {rel} (large or binary)\n"),
    }
}

/// What a commit would take: the staged changes, else every change and new file.
fn changes(git: &Path, repo: &Path) -> String {
    let staged = git_text(git, repo, &["diff", "--cached", "--stat", "--patch"]).unwrap_or_default();
    if !staged.trim().is_empty() {
        return staged;
    }
    // no HEAD yet (first commit): nothing tracked to compare
    let mut text = git_text(git, repo, &["diff", "HEAD", "--stat", "--patch"]).unwrap_or_default();
    let untracked = git_text(git, repo, &["ls-files", "--others", "--exclude-standard", "-z"]).unwrap_or_default();
    for rel in untracked.split('\0').filter(|r| !r.is_empty()) {
        if text.len() > MAX_DIFF {
            break;
        }
        text.push_str(&new_file(repo, rel));
    }
    text
}

/// Cuts `text` to at most `max` bytes on a character boundary, saying so.
fn cap(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push_str("\n[the rest of the changes was cut]\n");
    text
}

/// The message from claude's answer: trimmed, without a code fence or quotes around it.
pub fn clean(answer: &str) -> String {
    let mut s = answer.trim();
    if let Some(inner) = s.strip_prefix("```") {
        // a fence may name a language on its first line
        let inner = inner.split_once('\n').map_or("", |(_, rest)| rest);
        s = inner.strip_suffix("```").unwrap_or(inner).trim();
    }
    for q in ['"', '\''] {
        if s.len() > 1 && s.starts_with(q) && s.ends_with(q) {
            s = s[1..s.len() - 1].trim();
        }
    }
    s.to_string()
}

pub fn generate(repo: &str, profile: Option<&str>, claude: PathBuf) -> AppResult<String> {
    let repo = guard::folder(repo, true)?;
    let profile = profile.map(profiles::resolve_profile).transpose()?;
    let git = env::wait_env()
        .git
        .clone()
        .ok_or_else(|| AppError::NotFound("Git was not found.".into()))?;
    let diff = changes(&git, &repo);
    if diff.trim().is_empty() {
        return Err(AppError::InvalidInput("There are no changes to describe.".into()));
    }
    let input = format!("{PROMPT}\n\nChanges:\n{}", cap(diff, MAX_DIFF));

    let mut cmd = spawn::hidden_command(&claude);
    if let Some(profile) = &profile {
        env::apply_profile(&mut cmd, profile, &paths::home()?);
    }
    cmd.current_dir(&repo).args(ARGS);
    let out = run::execute(&mut cmd, Some(&input), CLAUDE_LIMIT).map_err(|e| match e {
        AppError::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            AppError::Internal(format!("Claude did not answer within {} s.", CLAUDE_LIMIT.as_secs()))
        }
        e => e,
    })?;
    let message = clean(&out.stdout);
    if out.code != 0 || message.is_empty() {
        let why = [out.stderr.trim(), out.stdout.trim()]
            .into_iter()
            .find(|t| !t.is_empty())
            .unwrap_or("Claude gave no message.");
        return Err(AppError::Internal(format!("Could not write a commit message:\n{why}")));
    }
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::{cap, clean};

    #[test]
    fn cleans_fences_and_quotes_off_the_answer() {
        assert_eq!(clean("  Fix the thing\n\nBody.\n"), "Fix the thing\n\nBody.");
        assert_eq!(clean("```text\nFix it\n```"), "Fix it");
        assert_eq!(clean("```\nFix it\n```\n"), "Fix it");
        assert_eq!(clean("\"Fix it\""), "Fix it");
        assert_eq!(clean("Don't fix 'it'"), "Don't fix 'it'");
    }

    #[test]
    fn cuts_long_changes_on_a_character_boundary() {
        assert_eq!(cap("short".into(), 10), "short");
        let cut = cap("ééééé".into(), 3);
        assert!(cut.starts_with('é') && cut.contains("was cut"));
    }
}
