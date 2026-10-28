//! The web page of a folder's repository: its `origin` remote (else the first remote) as an https link,
//! for "Open > GitHub". Only the host and the repository path are kept; user names and tokens in the
//! remote URL are dropped, and anything that is not a plain host and path gives no link.

use super::{guard, run};
use crate::core::error::AppResult;
use crate::core::{env, spawn};
use std::path::Path;
use std::time::Duration;

const LIMIT: Duration = Duration::from_secs(10);

/// `https://host/owner/repo` for a remote URL in any of git's forms (https, ssh://, scp-like
/// `git@host:owner/repo.git`); None for local paths and anything unusual.
pub fn web_url(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let (host, path) = if let Some((scheme, rest)) = remote.split_once("://") {
        if !matches!(scheme, "https" | "http" | "ssh" | "git" | "git+ssh") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        // an ssh or git port is not the web server's
        let host = if scheme.starts_with("http") {
            host
        } else {
            host.split(':').next()?
        };
        (host, path)
    } else {
        // scp-like: [user@]host:path
        let (authority, path) = remote.split_once(':')?;
        (authority.rsplit('@').next()?, path)
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    let host_ok = host.contains('.')
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'));
    let path_ok = !path.is_empty()
        && !path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | '~'));
    (host_ok && path_ok).then(|| format!("https://{host}/{path}"))
}

fn git_out(git: &Path, dir: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = run::command(git, dir, true);
    cmd.args(args);
    let out = spawn::output_with_timeout(&mut cmd, LIMIT).ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The web page of the repository `dir` is in, if its remote has one.
pub fn of_folder(dir: &str) -> AppResult<Option<String>> {
    let dir = guard::folder(dir, false)?;
    let Some(git) = env::wait_env().git.clone() else {
        return Ok(None);
    };
    let name = match git_out(&git, &dir, &["remote"]) {
        Some(list) if list.lines().any(|l| l.trim() == "origin") => "origin".to_string(),
        Some(list) => match list.lines().next() {
            Some(first) if !first.trim().is_empty() => first.trim().to_string(),
            _ => return Ok(None),
        },
        None => return Ok(None),
    };
    Ok(git_out(&git, &dir, &["remote", "get-url", &name]).and_then(|url| web_url(&url)))
}

#[cfg(test)]
mod tests {
    use super::web_url;

    #[test]
    fn turns_each_remote_form_into_the_https_page() {
        let gh = Some("https://github.com/xbuddhi/claude-manager".to_string());
        assert_eq!(web_url("https://github.com/xbuddhi/claude-manager.git"), gh);
        assert_eq!(web_url("git@github.com:xbuddhi/claude-manager.git\n"), gh);
        assert_eq!(web_url("ssh://git@github.com:22/xbuddhi/claude-manager.git"), gh);
        assert_eq!(web_url("https://user:token@github.com/xbuddhi/claude-manager/"), gh);
        assert_eq!(
            web_url("git@gitlab.com:group/sub/app.git"),
            Some("https://gitlab.com/group/sub/app".into())
        );
        assert_eq!(
            web_url("https://git.example.com:8443/team/app"),
            Some("https://git.example.com:8443/team/app".into())
        );
    }

    #[test]
    fn gives_nothing_for_local_paths_or_odd_urls() {
        for bad in [
            "/srv/repos/app.git",
            "C:/repos/app",
            "C:\\repos\\app",
            "../app",
            "file:///srv/app.git",
            "https://github.com/",
            "https://github.com/a/../b",
            "git@github.com:a b/c",
            "https://github.com/a?x=<script>",
            "",
        ] {
            assert_eq!(web_url(bad), None, "{bad}");
        }
    }
}
