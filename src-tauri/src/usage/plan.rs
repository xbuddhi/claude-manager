//! Plan limits from Anthropic's OAuth usage API: the same numbers as Claude Code's /usage. Gentle with
//! the service: a good answer is reused for 5 minutes per profile, and a 429 pauses every profile.

use super::creds::{Creds, OAuth};
use super::types::{PlanLimit, PlanReport};
use crate::core::error::lock;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT: Duration = Duration::from_secs(15);
/// A successful answer is reused this long per profile.
const MEMO: Duration = Duration::from_secs(5 * 60);

pub const NOT_SIGNED_IN: &str = "Not signed in";
pub const SIGN_IN_EXPIRED: &str = "Sign-in expired \u{2014} use this profile once to refresh";
pub const BUSY: &str = "Usage service busy";
pub const OFFLINE: &str = "Could not reach Anthropic (offline?)";
pub const UNREADABLE: &str = "Could not read usage";

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How long to pause after a 429: Retry-After seconds (120 when absent or not a number), 10 to 60 minutes.
pub fn backoff(retry_after: Option<&str>) -> Duration {
    let wait = retry_after.and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(120.0);
    Duration::from_secs_f64(wait.clamp(600.0, 3600.0))
}

/// The error text for a non-2xx answer.
pub fn status_error(status: u16) -> String {
    match status {
        429 => BUSY.into(),
        401 => SIGN_IN_EXPIRED.into(),
        _ => format!("Usage service unavailable ({status})"),
    }
}

/// An error that says nothing about the numbers (busy, offline, ...): the last good ones stay, marked stale.
pub fn is_transient(error: &str) -> bool {
    !error.starts_with("Sign-in") && !error.starts_with("Not signed")
}

fn time_ms(v: Option<&Value>) -> Option<i64> {
    let text = v?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Limits from the answer: `limits[]` when present, else the older `five_hour` / `seven_day` fields.
pub fn parse_limits(body: &Value) -> Vec<PlanLimit> {
    let mut out = Vec::new();
    if let Some(limits) = body.get("limits").and_then(Value::as_array) {
        for l in limits {
            let text = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or_default();
            let model = l
                .get("scope")
                .and_then(|s| s.get("model"))
                .and_then(|m| m.get("display_name"))
                .and_then(Value::as_str);
            let label = match text("group") {
                "session" => "Current session".to_string(),
                "weekly" => format!("Weekly \u{b7} {}", model.unwrap_or("all models")),
                _ => text("kind").replace('_', " "),
            };
            out.push(PlanLimit {
                label,
                percent: l.get("percent").and_then(Value::as_f64).unwrap_or(0.0),
                resets: time_ms(l.get("resets_at")),
            });
        }
    }
    if out.is_empty() {
        for (key, label) in [
            ("five_hour", "Current session"),
            ("seven_day", "Weekly \u{b7} all models"),
        ] {
            let Some(o) = body.get(key).filter(|o| o.is_object()) else {
                continue;
            };
            out.push(PlanLimit {
                label: label.into(),
                percent: o.get("utilization").and_then(Value::as_f64).unwrap_or(0.0),
                resets: time_ms(o.get("resets_at")),
            });
        }
    }
    out
}

/// "max" -> "Max".
pub fn plan_name(subscription: Option<&str>) -> Option<String> {
    let s = subscription?;
    let mut chars = s.chars();
    let first = chars.next()?;
    Some(first.to_uppercase().chain(chars).collect())
}

/// Asks the usage service, remembering good answers and the service's back-off.
pub struct Fetcher {
    url: String,
    client: reqwest::Client,
    /// Last successful report per profile key.
    memo: Mutex<HashMap<String, (Instant, PlanReport)>>,
    /// While set and in the future, no profile calls the service.
    retry_after: Mutex<Option<Instant>>,
}

impl Fetcher {
    /// Uses the system's proxy settings, like Claude Code.
    pub fn new(url: &str) -> Result<Self, reqwest::Error> {
        Self::with(url, reqwest::Client::builder())
    }

    fn with(url: &str, builder: reqwest::ClientBuilder) -> Result<Self, reqwest::Error> {
        let client = builder.timeout(TIMEOUT).user_agent("claude-manager").build()?;
        Ok(Self {
            url: url.to_string(),
            client,
            memo: Mutex::default(),
            retry_after: Mutex::default(),
        })
    }

    /// The report for one profile. `key` identifies the profile for the memo (`paths::key` of its folder).
    pub async fn fetch(&self, key: &str, profile: &str, name: &str, creds: Creds) -> PlanReport {
        if let Some((at, prev)) = lock(&self.memo).get(key)
            && at.elapsed() < MEMO
        {
            return prev.clone();
        }
        let mut rep = PlanReport {
            profile: profile.to_string(),
            name: name.to_string(),
            plan: None,
            error: None,
            stale: None,
            fetched: now_ms(),
            limits: Vec::new(),
        };
        let oauth = match creds {
            Ok(Some(oauth)) => oauth,
            Ok(None) => {
                rep.error = Some(NOT_SIGNED_IN.into());
                return rep;
            }
            Err(_) => {
                rep.error = Some(UNREADABLE.into());
                return rep;
            }
        };
        rep.plan = plan_name(oauth.subscription_type.as_deref());
        // the app never renews tokens itself; Claude Code does when the profile is used
        if oauth.expires_at_ms > 0 && oauth.expires_at_ms < now_ms() {
            rep.error = Some(SIGN_IN_EXPIRED.into());
            return rep;
        }
        if lock(&self.retry_after).is_some_and(|until| Instant::now() < until) {
            rep.error = Some(BUSY.into());
            return rep;
        }
        match self.call(&oauth).await {
            Ok(limits) => {
                rep.limits = limits;
                if !rep.limits.is_empty() {
                    lock(&self.memo).insert(key.to_string(), (Instant::now(), rep.clone()));
                }
            }
            Err(error) => rep.error = Some(error),
        }
        rep
    }

    async fn call(&self, oauth: &OAuth) -> Result<Vec<PlanLimit>, String> {
        let res = self
            .client
            .get(&self.url)
            .bearer_auth(&oauth.access_token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .await
            .map_err(|e| {
                // reqwest leaves the token out of its errors; still log only the kind
                log::warn!(
                    "usage request failed (connect: {}, timeout: {})",
                    e.is_connect(),
                    e.is_timeout()
                );
                OFFLINE.to_string()
            })?;
        let status = res.status().as_u16();
        if status == 429 {
            let header = res
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok());
            let wait = backoff(header);
            log::info!("usage service busy; pausing for {} s", wait.as_secs());
            *lock(&self.retry_after) = Some(Instant::now() + wait);
        }
        if !res.status().is_success() {
            return Err(status_error(status));
        }
        let body = res.text().await.map_err(|_| OFFLINE.to_string())?;
        let value: Value = serde_json::from_str(&body).map_err(|_| UNREADABLE.to_string())?;
        Ok(parse_limits(&value))
    }
}

/// Merges a fresh round into what is shown: a transient error keeps that profile's last good numbers,
/// marked stale with the error.
pub fn merge(old: &[PlanReport], fresh: Vec<PlanReport>) -> Vec<PlanReport> {
    fresh
        .into_iter()
        .map(|new| {
            let transient = new.error.as_deref().is_some_and(is_transient);
            match old.iter().find(|o| o.profile == new.profile) {
                Some(prev) if transient && !prev.limits.is_empty() => PlanReport {
                    stale: new.error,
                    ..prev.clone()
                },
                _ => new,
            }
        })
        .collect()
}

/// No plans yet, or a profile has no numbers for a reason other than not being signed in.
pub fn needs_retry(plans: &[PlanReport]) -> bool {
    plans.is_empty()
        || plans
            .iter()
            .any(|p| p.limits.is_empty() && !p.error.as_deref().is_some_and(|e| e.starts_with("Not signed")))
}

/// Whether a refresh of `profiles` can be skipped: the same profiles are shown, fetched under 5 minutes
/// ago, and every one has numbers or is not signed in (anything else keeps being retried).
pub fn can_skip(shown: &[PlanReport], profiles: &[String], now: i64) -> bool {
    let same = shown.len() == profiles.len() && shown.iter().zip(profiles).all(|(p, d)| p.profile == *d);
    let fresh = shown.first().is_some_and(|p| now - p.fetched < 300_000);
    let settled = shown.iter().all(|p| {
        (!p.limits.is_empty() && p.stale.is_none()) || p.error.as_deref().is_some_and(|e| e.starts_with("Not signed"))
    });
    same && fresh && settled
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/tests/fixtures/usage/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn ms(text: &str) -> Option<i64> {
        Some(chrono::DateTime::parse_from_rfc3339(text).unwrap().timestamp_millis())
    }

    #[test]
    fn parses_the_limits_list() {
        let limits = parse_limits(&fixture("limits.json"));
        let labels: Vec<&str> = limits.iter().map(|l| l.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Current session", "Weekly · all models", "Weekly · Opus", "extra usage"]
        );
        assert_eq!(limits[0].percent, 37.0);
        assert_eq!(limits[0].resets, ms("2026-10-25T15:00:00Z"));
        assert_eq!(limits[2].percent, 12.5);
        assert_eq!(limits[3].resets, None);
    }

    #[test]
    fn falls_back_to_the_older_fields() {
        let limits = parse_limits(&fixture("legacy.json"));
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].label, "Current session");
        assert_eq!(limits[0].percent, 64.0);
        assert_eq!(limits[0].resets, ms("2026-10-25T15:00:00.123456+00:00"));
        assert_eq!(limits[1].label, "Weekly · all models");
        assert!(parse_limits(&json!({"five_hour": null, "limits": []})).is_empty());
    }

    #[test]
    fn maps_errors_and_backoff() {
        assert_eq!(status_error(401), SIGN_IN_EXPIRED);
        assert_eq!(status_error(429), BUSY);
        assert_eq!(status_error(500), "Usage service unavailable (500)");
        assert_eq!(backoff(None), Duration::from_secs(600));
        assert_eq!(backoff(Some("30")), Duration::from_secs(600));
        assert_eq!(backoff(Some("1200")), Duration::from_secs(1200));
        assert_eq!(backoff(Some("99999")), Duration::from_secs(3600));
        assert_eq!(backoff(Some("Wed, 21 Oct 2026 07:28:00 GMT")), Duration::from_secs(600));
    }

    #[test]
    fn capitalizes_plan_names() {
        assert_eq!(plan_name(Some("max")).as_deref(), Some("Max"));
        assert_eq!(plan_name(Some("")), None);
        assert_eq!(plan_name(None), None);
    }

    fn report(profile: &str, error: Option<&str>, limits: usize) -> PlanReport {
        PlanReport {
            profile: profile.into(),
            name: profile.into(),
            plan: None,
            error: error.map(str::to_string),
            stale: None,
            fetched: 1000,
            limits: (0..limits)
                .map(|_| PlanLimit {
                    label: "Current session".into(),
                    percent: 10.0,
                    resets: None,
                })
                .collect(),
        }
    }

    #[test]
    fn merge_keeps_old_numbers_on_transient_errors() {
        let old = vec![report("a", None, 2), report("b", None, 1), report("c", None, 1)];
        let fresh = vec![
            report("a", Some(BUSY), 0),
            report("b", Some(SIGN_IN_EXPIRED), 0),
            report("c", None, 3),
            report("d", Some(OFFLINE), 0),
        ];
        let merged = merge(&old, fresh);
        assert_eq!(merged[0].limits.len(), 2);
        assert_eq!(merged[0].stale.as_deref(), Some(BUSY));
        assert_eq!(merged[0].error, None);
        assert_eq!(merged[1].error.as_deref(), Some(SIGN_IN_EXPIRED));
        assert!(merged[1].limits.is_empty());
        assert_eq!(merged[2].limits.len(), 3);
        assert_eq!(merged[3].error.as_deref(), Some(OFFLINE));
    }

    #[test]
    fn retry_and_skip_rules() {
        assert!(needs_retry(&[]));
        assert!(!needs_retry(&[
            report("a", None, 1),
            report("b", Some(NOT_SIGNED_IN), 0)
        ]));
        assert!(needs_retry(&[report("a", Some(SIGN_IN_EXPIRED), 0)]));
        let shown = vec![report("a", None, 1), report("b", Some(NOT_SIGNED_IN), 0)];
        let dirs = vec!["a".to_string(), "b".to_string()];
        assert!(can_skip(&shown, &dirs, 1000 + 299_000));
        assert!(!can_skip(&shown, &dirs, 1000 + 301_000));
        assert!(!can_skip(&shown, &dirs[..1], 1000));
        assert!(!can_skip(&[report("a", Some(BUSY), 0)], &dirs[..1], 1000));
    }

    /// Answers one request with `response` and hands back the request text.
    fn serve_once(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/oauth/usage", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let mut request = Vec::new();
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).into_owned()
        });
        (url, handle)
    }

    fn http(status: &str, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        )
    }

    fn creds(expires: i64) -> Creds {
        Ok(Some(OAuth {
            access_token: "test-token".into(),
            expires_at_ms: expires,
            subscription_type: Some("pro".into()),
        }))
    }

    /// A fetcher for the local test server: a proxy from the environment must not get in between.
    fn local(url: &str) -> Fetcher {
        Fetcher::with(url, reqwest::Client::builder().no_proxy()).unwrap()
    }

    fn fetch(fetcher: &Fetcher, creds: Creds) -> PlanReport {
        tauri::async_runtime::block_on(fetcher.fetch("k", "/p", "p", creds))
    }

    #[test]
    fn fetches_with_the_right_headers_and_memoizes() {
        let body = std::fs::read_to_string(format!(
            "{}/tests/fixtures/usage/limits.json",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        let (url, server) = serve_once(http("200 OK", "", &body));
        let fetcher = local(&url);
        let rep = fetch(&fetcher, creds(0));
        let request = server.join().unwrap().to_lowercase();
        assert!(request.starts_with("get /api/oauth/usage "));
        assert!(request.contains("\r\nauthorization: bearer test-token\r\n"));
        assert!(request.contains("\r\nanthropic-beta: oauth-2025-04-20\r\n"));
        assert!(request.contains("\r\nuser-agent: claude-manager\r\n"));
        assert_eq!(rep.error, None);
        assert_eq!(rep.plan.as_deref(), Some("Pro"));
        assert_eq!(rep.limits.len(), 4);
        // no server any more: the memo answers
        assert_eq!(fetch(&fetcher, creds(0)), rep);
    }

    #[test]
    fn a_429_pauses_every_profile() {
        let (url, server) = serve_once(http("429 Too Many Requests", "Retry-After: 5\r\n", "{}"));
        let fetcher = local(&url);
        assert_eq!(fetch(&fetcher, creds(0)).error.as_deref(), Some(BUSY));
        server.join().unwrap();
        let until = lock(&fetcher.retry_after).unwrap();
        let left = until - Instant::now();
        assert!(left > Duration::from_secs(590) && left <= Duration::from_secs(600));
        // the server is gone; a second profile is not even tried
        let rep = tauri::async_runtime::block_on(fetcher.fetch("k2", "/q", "q", creds(0)));
        assert_eq!(rep.error.as_deref(), Some(BUSY));
    }

    #[test]
    fn maps_http_failures() {
        for (status, expected) in [
            ("401 Unauthorized", SIGN_IN_EXPIRED.to_string()),
            (
                "500 Internal Server Error",
                "Usage service unavailable (500)".to_string(),
            ),
        ] {
            let (url, server) = serve_once(http(status, "", "{}"));
            let fetcher = local(&url);
            assert_eq!(fetch(&fetcher, creds(0)).error, Some(expected));
            server.join().unwrap();
        }
        let (url, server) = serve_once(http("200 OK", "", "not json"));
        let fetcher = local(&url);
        assert_eq!(fetch(&fetcher, creds(0)).error.as_deref(), Some(UNREADABLE));
        server.join().unwrap();
    }

    #[test]
    fn reports_offline_expired_and_signed_out_without_calling() {
        // a port nothing listens on
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let fetcher = local(&format!("http://127.0.0.1:{port}/"));
        assert_eq!(fetch(&fetcher, creds(0)).error.as_deref(), Some(OFFLINE));
        assert_eq!(fetch(&fetcher, creds(1)).error.as_deref(), Some(SIGN_IN_EXPIRED));
        assert_eq!(fetch(&fetcher, Ok(None)).error.as_deref(), Some(NOT_SIGNED_IN));
        let unreadable = fetch(&fetcher, Err(super::super::creds::Unreadable));
        assert_eq!(unreadable.error.as_deref(), Some(UNREADABLE));
    }

    #[test]
    fn builds_the_tls_client() {
        assert!(Fetcher::new(USAGE_URL).is_ok());
    }
}
