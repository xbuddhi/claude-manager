//! A profile's Claude Code sign-in, read only and never written. Windows and Linux keep it in
//! `<profile>/.credentials.json`; macOS keeps it in the login Keychain (see docs/port/research.md).
//! The token stays in Rust: it is sent only to api.anthropic.com and is never logged or returned to JS.

use crate::core::error::lock;
use crate::core::{paths, profiles};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// The parts of `claudeAiOauth` the usage feature needs. No `Debug`: the token must never be printed.
#[derive(Clone)]
pub struct OAuth {
    pub access_token: String,
    /// When the access token expires, ms since the Unix epoch; 0 when unknown.
    pub expires_at_ms: i64,
    /// "max", "pro", ...
    pub subscription_type: Option<String>,
}

/// The credentials exist but could not be read or parsed (e.g. Claude Code was rewriting the file).
#[derive(Debug, PartialEq, Eq)]
pub struct Unreadable;

/// `Ok(None)` = not signed in.
pub type Creds = Result<Option<OAuth>, Unreadable>;

const SERVICE: &str = "Claude Code-credentials";

/// Parses the credentials JSON Claude Code stores (file or Keychain item).
pub fn parse(text: &str) -> Creds {
    let v: serde_json::Value = serde_json::from_str(text.trim()).map_err(|_| Unreadable)?;
    let Some(o) = v.get("claudeAiOauth") else {
        return Ok(None);
    };
    let token = o.get("accessToken").and_then(|t| t.as_str()).unwrap_or_default();
    if token.is_empty() {
        return Ok(None);
    }
    Ok(Some(OAuth {
        access_token: token.to_string(),
        expires_at_ms: o.get("expiresAt").and_then(|e| e.as_i64()).unwrap_or(0),
        subscription_type: o
            .get("subscriptionType")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }))
}

/// Keychain service names to try for `dir`, in order: Claude Code names a profile's item
/// `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`; the default profile (started
/// without CLAUDE_CONFIG_DIR, see `env::apply_profile`) uses the plain name, which is also the fallback.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn keychain_services(dir: &Path, home: &Path) -> Vec<String> {
    if profiles::is_default(dir, home) {
        return vec![SERVICE.to_string()];
    }
    // the exact string the app passes as CLAUDE_CONFIG_DIR: the normalized folder, no trailing separator
    let config_dir = paths::norm(&dir.to_string_lossy());
    let hash = Sha256::digest(config_dir.as_bytes());
    let suffix: String = hash.iter().take(4).map(|b| format!("{b:02x}")).collect();
    vec![format!("{SERVICE}-{suffix}"), SERVICE.to_string()]
}

fn read_file(dir: &Path) -> Creds {
    match std::fs::read_to_string(dir.join(".credentials.json")) {
        Ok(text) => parse(&text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Unreadable),
    }
}

/// Reads the sign-in of profile `dir`. Blocking (file or `/usr/bin/security`): call it off the UI thread.
pub fn read(dir: &Path) -> Creds {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = paths::home() {
            for service in keychain_services(dir, &home) {
                if let Some(found) = keychain::read(&service) {
                    return found;
                }
            }
        }
    }
    read_file(dir)
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{Creds, parse};
    use crate::core::{env, spawn};
    use std::time::Duration;

    /// `security` exits with 44 when the item does not exist.
    const NOT_FOUND: i32 = 44;

    /// The item's value through /usr/bin/security, which created it for Claude Code and so is trusted by
    /// its ACL: no Keychain prompt. None when the item is missing or the tool fails (try the next one).
    pub fn read(service: &str) -> Option<Creds> {
        let mut cmd = spawn::hidden_command("/usr/bin/security");
        cmd.args(["find-generic-password", "-s", service]);
        if let Some(user) = env::user_name() {
            cmd.args(["-a", &user]);
        }
        cmd.arg("-w");
        let out = match spawn::output_with_timeout(&mut cmd, Duration::from_secs(5)) {
            Ok(out) => out,
            Err(e) => {
                log::warn!("reading the keychain failed: {e}");
                return None;
            }
        };
        if !out.status.success() {
            if out.status.code() != Some(NOT_FOUND) {
                log::warn!("security find-generic-password exited with {:?}", out.status.code());
            }
            return None;
        }
        Some(parse(&String::from_utf8_lossy(&out.stdout)))
    }
}

/// How long a signed-in answer is reused: the profile list asks for every profile on each refresh.
const SIGNED_IN_TTL: Duration = Duration::from_secs(30);
static SIGNED_IN: LazyLock<Mutex<HashMap<String, (Instant, bool)>>> = LazyLock::new(Default::default);

/// Whether profile `dir` has a usable sign-in (an access token, even an expired one: Claude Code renews
/// it on use). Registered as `Profiles::set_signed_in`; answers are cached for 30 s.
pub fn signed_in(dir: &Path) -> Option<bool> {
    let key = paths::key(&dir.to_string_lossy());
    if let Some((at, value)) = lock(&SIGNED_IN).get(&key)
        && at.elapsed() < SIGNED_IN_TTL
    {
        return Some(*value);
    }
    let value = match read(dir) {
        Ok(found) => found.is_some(),
        // being rewritten right now: unknown rather than "signed out"
        Err(Unreadable) => return None,
    };
    lock(&SIGNED_IN).insert(key, (Instant::now(), value));
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_the_oauth_block() {
        let creds = parse(
            r#"{"claudeAiOauth":{"accessToken":"t-1","refreshToken":"r","expiresAt":1761400000000,"subscriptionType":"max"}}"#,
        )
        .unwrap()
        .unwrap();
        assert_eq!(creds.access_token, "t-1");
        assert_eq!(creds.expires_at_ms, 1_761_400_000_000);
        assert_eq!(creds.subscription_type.as_deref(), Some("max"));
    }

    #[test]
    fn tells_signed_out_from_unreadable() {
        assert!(parse("{}").unwrap().is_none());
        assert!(parse(r#"{"claudeAiOauth":{"accessToken":""}}"#).unwrap().is_none());
        assert_eq!(parse(r#"{"claudeAiOauth":{"accessTo"#).err(), Some(Unreadable));
    }

    #[test]
    fn reads_the_credentials_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_file(dir.path()).unwrap().is_none());
        fs::write(
            dir.path().join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"t-2"}}"#,
        )
        .unwrap();
        let creds = read_file(dir.path()).unwrap().unwrap();
        assert_eq!(creds.expires_at_ms, 0);
        assert_eq!(creds.subscription_type, None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn signed_in_follows_the_credentials_file() {
        let dir = tempfile::tempdir().unwrap();
        let signed = dir.path().join(".claude-signed");
        let none = dir.path().join(".claude-none");
        fs::create_dir_all(&signed).unwrap();
        fs::create_dir_all(&none).unwrap();
        fs::write(
            signed.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"t-3"}}"#,
        )
        .unwrap();
        assert_eq!(signed_in(&signed), Some(true));
        assert_eq!(signed_in(&none), Some(false));
    }

    #[test]
    fn keychain_service_names() {
        let home = Path::new("/Users/x");
        assert_eq!(keychain_services(&home.join(".claude"), home), [SERVICE]);
        // sha256("/Users/x/.claude-work") starts with these 8 hex digits
        let hash = Sha256::digest(b"/Users/x/.claude-work");
        let expected = format!("{SERVICE}-{:02x}{:02x}{:02x}{:02x}", hash[0], hash[1], hash[2], hash[3]);
        let work = Path::new("/Users/x/.claude-work");
        assert_eq!(keychain_services(work, home), [expected.clone(), SERVICE.to_string()]);
        // a trailing separator does not change the name
        assert_eq!(
            keychain_services(Path::new("/Users/x/.claude-work/"), home)[0],
            expected
        );
        assert_eq!(expected, "Claude Code-credentials-74ed04d5");
    }
}
