//! Which claude sessions run now, from the markers Claude Code keeps in `<profile>/sessions/`:
//!
//! - `<pid>.json` {pid, sessionId, status, cwd, startedAt (ms), procStart}: older and current versions.
//! - `<pid>.<hash>.key` only: newer versions. The session comes from the process's command line
//!   (`--resume <id>`, `--session-id <id>`), else it is the newest transcript written since the process
//!   started that no other process has claimed.
//!
//! A marker of an ended process is ignored (never deleted: the folder belongs to Claude Code). Pids are
//! reused, so a marker counts only while its process is the one that wrote it: by start time when the
//! marker records one, else by name.

use super::snapshot::{Proc, Snapshot};
use crate::core::profiles::{find_transcript, is_session_id};
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Slack for comparing a marker's times with a process start time (which has one-second resolution).
const START_SLACK_S: u64 = 5;
/// A transcript written this recently means claude is working (`.key` sessions have no status).
const WORKING_WITHIN: Duration = Duration::from_secs(8);
/// The end of a transcript searched for the session's folder.
const CWD_TAIL: u64 = 256 * 1024;

/// A validated running session (before deduplication).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Found {
    pub session_id: String,
    pub pid: u32,
    /// 1 = open, 2 = working.
    pub level: u8,
    pub cwd: Option<String>,
    pub profile: PathBuf,
}

#[derive(Debug, Default)]
pub struct Markers {
    json: Vec<JsonMarker>,
    keys: Vec<KeyMarker>,
}

#[derive(Debug)]
struct JsonMarker {
    pid: u32,
    session_id: String,
    busy: bool,
    cwd: Option<String>,
    started_at_ms: Option<u64>,
    proc_start: Option<String>,
}

#[derive(Debug)]
struct KeyMarker {
    pid: u32,
    /// Last write of the marker, seconds since the Unix epoch.
    written: u64,
}

impl Markers {
    /// Pids whose command line the scan needs.
    pub fn key_pids(&self) -> impl Iterator<Item = u32> + '_ {
        self.keys.iter().map(|k| k.pid)
    }
}

/// Reads `<profile>/sessions/`. Unreadable or damaged files are skipped.
pub fn read_markers(profile: &Path) -> Markers {
    let mut markers = Markers::default();
    let Ok(entries) = std::fs::read_dir(profile.join("sessions")) else {
        return markers;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".json") {
            if stem.parse::<u32>().is_ok()
                && let Some(m) = std::fs::read_to_string(entry.path()).ok().and_then(|t| parse_json(&t))
            {
                markers.json.push(m);
            }
        } else if name.ends_with(".key")
            && let Some(pid) = name.split('.').next().and_then(|p| p.parse::<u32>().ok())
        {
            let written = entry.metadata().ok().and_then(|m| m.modified().ok()).map_or(0, secs);
            markers.keys.push(KeyMarker { pid, written });
        }
    }
    markers
}

fn parse_json(text: &str) -> Option<JsonMarker> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let pid = u32::try_from(v.get("pid")?.as_u64()?).ok().filter(|&p| p > 0)?;
    let session_id = v.get("sessionId")?.as_str().filter(|s| is_session_id(s))?.to_string();
    let proc_start = match v.get("procStart") {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    Some(JsonMarker {
        pid,
        session_id,
        busy: v.get("status").and_then(|s| s.as_str()) == Some("busy"),
        cwd: v
            .get("cwd")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        started_at_ms: v.get("startedAt").and_then(|s| s.as_u64()),
        proc_start,
    })
}

/// Names a claude process can have: the binary, node for the npm package, shells and terminal hosts that
/// older versions recorded, and on macOS the native binary, which is named after its version.
pub fn allowed_name(name: &str) -> bool {
    const NAMES: &[&str] = &[
        "claude",
        "node",
        "pwsh",
        "powershell",
        "cmd",
        "bash",
        "zsh",
        "sh",
        "fish",
        "login",
        "wt",
        "windowsterminal",
        "conhost",
        "openconsole",
    ];
    NAMES.contains(&name) || is_version(name)
}

/// `^\d+\.\d+\.\d+`
fn is_version(name: &str) -> bool {
    let mut parts = name.splitn(3, '.');
    let digits = |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    let lead = |s: Option<&str>| s.is_some_and(|s| s.bytes().next().is_some_and(|b| b.is_ascii_digit()));
    digits(parts.next()) && digits(parts.next()) && lead(parts.next())
}

/// `procStart` as Windows writes it: a FILETIME (100 ns since 1601) -> seconds since the Unix epoch.
/// Other forms (macOS, unknown) give None.
fn filetime_secs(s: &str) -> Option<u64> {
    const UNIX_EPOCH_FT: u64 = 116_444_736_000_000_000;
    let ft = s.trim().parse::<u64>().ok().filter(|&t| t > UNIX_EPOCH_FT)?;
    Some((ft - UNIX_EPOCH_FT) / 10_000_000)
}

/// Whether the process `p` is the one that wrote marker `m`.
fn json_matches(p: &Proc, m: &JsonMarker) -> bool {
    if let Some(start) = m.proc_start.as_deref().and_then(filetime_secs) {
        return p.start.abs_diff(start) <= START_SLACK_S;
    }
    if let Some(ms) = m.started_at_ms {
        // a pid is never held by two running processes: one that started before the session did is the
        // process that wrote it; a reused pid belongs to a process that started later
        return p.start <= ms / 1000 + START_SLACK_S;
    }
    allowed_name(&p.name)
}

/// The session id on a claude command line, unless it forks (`--fork-session` starts a new id).
pub fn arg_session_id(cmd: &[String]) -> Option<String> {
    if cmd.iter().any(|a| a == "--fork-session") {
        return None;
    }
    let unquote = |s: &str| s.trim_matches('"').to_string();
    for (i, arg) in cmd.iter().enumerate() {
        let value = match arg.split_once('=') {
            Some(("--resume" | "-r" | "--session-id", v)) => Some(unquote(v)),
            _ if matches!(arg.as_str(), "--resume" | "-r" | "--session-id") => cmd.get(i + 1).map(|v| unquote(v)),
            _ => None,
        };
        if let Some(id) = value.filter(|v| is_session_id(v)) {
            return Some(id);
        }
    }
    None
}

/// Validated running sessions of every profile, in marker order (`.json` first, then `.key` by process
/// start time). The same session can appear more than once (several processes); see `dedupe`.
pub fn evaluate(profiles: &[(PathBuf, Markers)], snap: &Snapshot, now: SystemTime) -> Vec<Found> {
    let mut found: Vec<Found> = Vec::new();
    for (profile, markers) in profiles {
        for m in &markers.json {
            let Some(p) = snap.get(m.pid) else { continue };
            if !json_matches(p, m) {
                continue;
            }
            found.push(Found {
                session_id: m.session_id.clone(),
                pid: m.pid,
                level: if m.busy { 2 } else { 1 },
                cwd: m.cwd.clone(),
                profile: profile.clone(),
            });
        }

        let mut keys: Vec<(&KeyMarker, &Proc)> = markers
            .keys
            .iter()
            .filter(|k| !found.iter().any(|f| f.pid == k.pid))
            .filter_map(|k| snap.get(k.pid).map(|p| (k, p)))
            .filter(|(k, p)| allowed_name(&p.name) && p.start <= k.written + START_SLACK_S)
            .collect();
        keys.sort_by_key(|(_, p)| p.start);
        keys.dedup_by_key(|(k, _)| k.pid);
        let mut transcripts: Option<Vec<(PathBuf, SystemTime)>> = None;
        for (k, p) in keys {
            let from_arg = arg_session_id(&p.cmd);
            let file = match &from_arg {
                Some(id) => find_transcript(profile, id),
                None => {
                    let all = transcripts.get_or_insert_with(|| list_transcripts(profile));
                    let since = UNIX_EPOCH + Duration::from_secs(p.start.saturating_sub(START_SLACK_S));
                    let claimed: HashSet<&str> = found.iter().map(|f| f.session_id.as_str()).collect();
                    newest_since(all, since, &claimed)
                }
            };
            let Some(file) = file else { continue };
            let Some(id) = from_arg.or_else(|| stem(&file)) else {
                continue;
            };
            if found.iter().any(|f| f.session_id == id) {
                continue;
            }
            let modified = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
            let working = modified.is_some_and(|m| now.duration_since(m).unwrap_or_default() < WORKING_WITHIN);
            found.push(Found {
                session_id: id,
                pid: k.pid,
                level: if working { 2 } else { 1 },
                cwd: last_cwd(&file),
                profile: profile.clone(),
            });
        }
    }
    found
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn stem(file: &Path) -> Option<String> {
    let s = file.file_stem()?.to_string_lossy();
    is_session_id(&s).then(|| s.into_owned())
}

/// Every `<profile>/projects/<slug>/<id>.jsonl` with its last write. Symlinks are not followed.
fn list_transcripts(profile: &Path) -> Vec<(PathBuf, SystemTime)> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(profile.join("projects")) else {
        return out;
    };
    for dir in dirs.flatten().filter(|d| d.file_type().is_ok_and(|t| t.is_dir())) {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if f.file_type().is_ok_and(|t| t.is_file())
                && path.extension().is_some_and(|e| e == "jsonl")
                && let Ok(modified) = f.metadata().and_then(|m| m.modified())
            {
                out.push((path, modified));
            }
        }
    }
    out
}

/// The newest transcript written after `since` whose session no process has claimed.
fn newest_since(all: &[(PathBuf, SystemTime)], since: SystemTime, claimed: &HashSet<&str>) -> Option<PathBuf> {
    all.iter()
        .filter(|(_, t)| *t > since)
        .filter(|(p, _)| stem(p).is_some_and(|id| !claimed.contains(id.as_str())))
        .max_by_key(|(_, t)| *t)
        .map(|(p, _)| p.clone())
}

/// The folder a session runs in: the last `"cwd":"..."` in the end of its transcript.
pub fn last_cwd(file: &Path) -> Option<String> {
    let mut f = std::fs::File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    let n = len.min(CWD_TAIL);
    f.seek(SeekFrom::Start(len - n)).ok()?;
    let mut buf = Vec::with_capacity(n as usize);
    f.take(n).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    const KEY: &str = "\"cwd\":\"";
    text.rmatch_indices(KEY)
        .find_map(|(i, _)| json_string(&text[i + KEY.len() - 1..]))
}

/// Decodes the JSON string literal at the start of `s` (which begins with its opening quote).
fn json_string(s: &str) -> Option<String> {
    let mut escaped = false;
    for (i, c) in s.char_indices().skip(1) {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return serde_json::from_str::<String>(&s[..=i]).ok().filter(|v| !v.is_empty()),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::snapshot::tests::proc;
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    const A: &str = "0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    const B: &str = "1f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
    const C: &str = "2f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";

    fn profile() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("sessions")).unwrap();
        fs::create_dir_all(dir.path().join("projects").join("C--code-app")).unwrap();
        dir
    }

    fn write_json(profile: &Path, pid: u32, body: serde_json::Value) {
        fs::write(profile.join("sessions").join(format!("{pid}.json")), body.to_string()).unwrap();
    }

    fn write_transcript(profile: &Path, id: &str, text: &str) -> PathBuf {
        let f = profile.join("projects").join("C--code-app").join(format!("{id}.jsonl"));
        fs::write(&f, text).unwrap();
        f
    }

    fn run(profile: &Path, snap: &Snapshot) -> Vec<Found> {
        let markers = read_markers(profile);
        evaluate(&[(profile.to_path_buf(), markers)], snap, SystemTime::now())
    }

    #[test]
    fn json_markers_of_live_processes_count() {
        let dir = profile();
        let p = dir.path();
        let me = std::process::id();
        let now_ms = secs(SystemTime::now()) * 1000;
        write_json(
            p,
            me,
            serde_json::json!({"pid": me, "sessionId": A, "status": "busy", "cwd": "C:\\code\\app", "startedAt": now_ms}),
        );
        // a pid no process has
        write_json(
            p,
            4_000_000_000,
            serde_json::json!({"pid": 4_000_000_000u32, "sessionId": B, "status": "idle"}),
        );
        fs::write(p.join("sessions").join("junk.json"), "{").unwrap();
        let snap = Snapshot::take(&crate::core::procs::Procs::new(), &HashSet::new());
        let found = run(p, &snap);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, A);
        assert_eq!(found[0].level, 2);
        assert_eq!(found[0].cwd.as_deref(), Some("C:\\code\\app"));
        // the stale marker is left alone
        assert!(p.join("sessions").join("4000000000.json").exists());

        write_json(
            p,
            me,
            serde_json::json!({"pid": me, "sessionId": A, "status": "idle", "startedAt": now_ms}),
        );
        assert_eq!(run(p, &snap)[0].level, 1);
    }

    #[test]
    fn reused_pids_are_ignored() {
        let dir = profile();
        let p = dir.path();
        let snap = Snapshot::from_map(HashMap::from([
            (10, proc(None, 1_000, "chrome")),
            (11, proc(None, 1_000, "claude")),
            (12, proc(None, 1_000, "chrome")),
            (13, proc(None, 1_000, "2.1.310")),
        ]));
        // started after the session did: another process now has the pid
        write_json(
            p,
            10,
            serde_json::json!({"pid": 10, "sessionId": A, "startedAt": 900_000}),
        );
        // procStart (FILETIME) must match within 5 s
        let ft = |s: u64| (s * 10_000_000 + 116_444_736_000_000_000).to_string();
        write_json(
            p,
            11,
            serde_json::json!({"pid": 11, "sessionId": B, "procStart": ft(1_003), "startedAt": 1_000_000}),
        );
        write_json(
            p,
            12,
            serde_json::json!({"pid": 12, "sessionId": C, "procStart": ft(1_100)}),
        );
        // no times recorded: by name (the macOS binary is named after its version)
        write_json(
            p,
            13,
            serde_json::json!({"pid": 13, "sessionId": "3f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6"}),
        );
        let ids: Vec<String> = run(p, &snap).into_iter().map(|f| f.session_id).collect();
        assert_eq!(ids, [B, "3f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6"]);
    }

    #[test]
    fn key_markers_use_the_command_line_then_the_newest_transcript() {
        let dir = profile();
        let p = dir.path();
        let start = secs(SystemTime::now()) - 60;
        let mut by_arg = proc(None, start, "claude");
        by_arg.cmd = vec!["claude".into(), "--resume".into(), A.into()];
        let mut by_eq = proc(None, start + 1, "node");
        by_eq.cmd = vec!["node".into(), "cli.js".into(), format!("--session-id={B}")];
        let fresh = proc(None, start + 2, "claude");
        let snap = Snapshot::from_map(HashMap::from([
            (21, by_arg),
            (22, by_eq),
            (23, fresh),
            (24, proc(None, start, "notepad")),
        ]));
        for pid in [21, 22, 23, 24] {
            fs::write(p.join("sessions").join(format!("{pid}.abc123.key")), "").unwrap();
        }
        write_transcript(
            p,
            A,
            "{\"cwd\":\"C:\\\\old\"}\n{\"type\":\"user\",\"cwd\":\"C:\\\\code\\\\app\"}\n",
        );
        write_transcript(p, B, "{}");
        write_transcript(p, C, "{\"cwd\":\"/Users/me/x\"}\n");
        let found = run(p, &snap);
        let got: Vec<(u32, &str, u8)> = found.iter().map(|f| (f.pid, f.session_id.as_str(), f.level)).collect();
        // written just now, so working; 24 is not a claude process
        assert_eq!(got, [(21, A, 2), (22, B, 2), (23, C, 2)]);
        assert_eq!(found[0].cwd.as_deref(), Some("C:\\code\\app"));
        assert_eq!(found[2].cwd.as_deref(), Some("/Users/me/x"));
    }

    #[test]
    fn spawned_child_with_resume_on_its_command_line_is_found() {
        let dir = profile();
        let p = dir.path();
        write_transcript(p, A, "{}");
        // a shell (an allowed name) that waits, with the flag as separate arguments it ignores
        let mut child = if cfg!(windows) {
            std::process::Command::new("cmd")
                .args([
                    "/d",
                    "/c",
                    "ping",
                    "-n",
                    "30",
                    "127.0.0.1",
                    ">NUL",
                    "&",
                    "rem",
                    "--resume",
                    A,
                ])
                .spawn()
                .unwrap()
        } else {
            std::process::Command::new("sh")
                .args(["-c", "sleep 30; true", "sh", "--resume", A])
                .spawn()
                .unwrap()
        };
        let pid = child.id();
        fs::write(p.join("sessions").join(format!("{pid}.f00d.key")), "").unwrap();
        let markers = read_markers(p);
        let snap = Snapshot::take(&crate::core::procs::Procs::new(), &markers.key_pids().collect());
        let found = evaluate(&[(p.to_path_buf(), markers)], &snap, SystemTime::now());
        child.kill().unwrap();
        let _ = child.wait();
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].pid, found[0].session_id.as_str()), (pid, A));
    }

    #[test]
    fn parses_session_arguments() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(arg_session_id(&args(&["claude", "-r", A])).as_deref(), Some(A));
        assert_eq!(
            arg_session_id(&args(&["claude", &format!("--resume=\"{A}\"")])).as_deref(),
            Some(A)
        );
        assert_eq!(
            arg_session_id(&args(&["claude", "--resume", A, "--fork-session"])),
            None
        );
        assert_eq!(arg_session_id(&args(&["claude", "--resume", "--x"])), None);
        assert_eq!(arg_session_id(&args(&["claude"])), None);
    }

    #[test]
    fn names_and_times() {
        assert!(allowed_name("claude") && allowed_name("2.1.310") && allowed_name("10.0.1-beta"));
        assert!(!allowed_name("chrome") && !allowed_name("2.1") && !allowed_name("v2.1.3"));
        assert_eq!(filetime_secs("134373824445101316"), Some(1_792_908_844));
        assert_eq!(filetime_secs("1792908844510"), None);
        assert_eq!(filetime_secs("Mon Oct 20"), None);
    }

    #[test]
    fn last_cwd_reads_only_the_tail() {
        let dir = profile();
        let mut text = String::from("{\"cwd\":\"C:\\\\first\"}\n");
        text.push_str(&"x".repeat(300 * 1024));
        text.push_str("\n{\"cwd\":\"C:\\\\a \\\"quoted\\\" name\"}\n{\"cwd\":\"\"}\n");
        let f = write_transcript(dir.path(), A, &text);
        assert_eq!(last_cwd(&f).as_deref(), Some("C:\\a \"quoted\" name"));
        let g = write_transcript(
            dir.path(),
            B,
            &format!("{{\"cwd\":\"C:\\\\first\"}}\n{}", "x".repeat(300 * 1024)),
        );
        assert_eq!(last_cwd(&g), None);
    }
}
