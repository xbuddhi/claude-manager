//! Token counts from the transcripts Claude Code writes on this computer: today, the last 7 days and the
//! current 5-hour window. Nothing is sent anywhere. Files are parsed once per modification time.

use super::types::UsageReport;
use crate::core::error::lock;
use chrono::{DateTime, Duration, Local, Timelike};
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

/// How far back transcripts are read.
const SPAN_DAYS: i64 = 8;
const BLOCK_HOURS: i64 = 5;

/// One assistant reply.
#[derive(Clone, Debug)]
pub struct Entry {
    pub t: DateTime<Local>,
    /// `message.id`; a reply is logged once per content block, so it is counted once.
    pub id: Option<String>,
    pub tokens: u64,
}

/// A file's replies, with the modification time they were read at.
type Parsed = (SystemTime, Arc<Vec<Entry>>);

/// Parsed files by path.
#[derive(Default)]
pub struct LocalUsage {
    files: Mutex<HashMap<PathBuf, Parsed>>,
    /// One count at a time; a second caller waits and then reuses the parsed files.
    running: Mutex<()>,
}

/// The entry for one transcript line, if it is a counted assistant reply.
pub fn parse_line(line: &str) -> Option<Entry> {
    if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
        return None;
    }
    let root: Value = serde_json::from_str(line).ok()?;
    if root.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let msg = root.get("message")?;
    let usage = msg.get("usage")?;
    if msg.get("model").and_then(Value::as_str) == Some("<synthetic>") {
        return None;
    }
    let t = DateTime::parse_from_rfc3339(root.get("timestamp")?.as_str()?).ok()?;
    // cache reads are left out: they would dwarf the real work
    let tokens = ["input_tokens", "output_tokens", "cache_creation_input_tokens"]
        .iter()
        .filter_map(|k| usage.get(*k).and_then(Value::as_u64))
        .sum();
    Some(Entry {
        t: t.with_timezone(&Local),
        id: msg.get("id").and_then(Value::as_str).map(str::to_string),
        tokens,
    })
}

fn read_file(path: &Path) -> Vec<Entry> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Some(e) = std::str::from_utf8(&buf).ok().and_then(parse_line) {
                    out.push(e);
                }
            }
        }
    }
    out
}

/// Every `*.jsonl` under `root` (sub-agent transcripts included) modified since `since`. Symlinks are
/// not followed.
fn transcripts(root: &Path, since: SystemTime, out: &mut Vec<(PathBuf, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            transcripts(&path, since, out);
        } else if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") {
            let modified = entry.metadata().and_then(|m| m.modified());
            if let Ok(modified) = modified
                && modified >= since
            {
                out.push((path, modified));
            }
        }
    }
}

impl LocalUsage {
    /// Counts the transcripts under `roots` (`<profile>/projects` folders). Blocking.
    pub fn report(&self, roots: &[PathBuf]) -> UsageReport {
        let _one_at_a_time = lock(&self.running);
        let now = Local::now();
        let since = SystemTime::now() - std::time::Duration::from_secs(SPAN_DAYS as u64 * 86_400);
        let mut found = Vec::new();
        for root in roots {
            transcripts(root, since, &mut found);
        }
        let parsed: Vec<Arc<Vec<Entry>>> = found
            .par_iter()
            .map(|(path, modified)| {
                if let Some((at, entries)) = lock(&self.files).get(path)
                    && at == modified
                {
                    return entries.clone();
                }
                let entries = Arc::new(read_file(path));
                lock(&self.files).insert(path.clone(), (*modified, entries.clone()));
                entries
            })
            .collect();
        // forget files that fell out of the window
        lock(&self.files).retain(|_, (at, _)| *at >= since);
        compute(parsed.iter().flat_map(|e| e.iter()), now)
    }
}

/// The report for `entries` as seen at `now`.
pub fn compute<'a>(entries: impl Iterator<Item = &'a Entry>, now: DateTime<Local>) -> UsageReport {
    let since = now - Duration::days(SPAN_DAYS);
    let mut seen = HashSet::new();
    let mut all: Vec<&Entry> = entries
        .filter(|e| e.t >= since)
        .filter(|e| e.id.as_ref().is_none_or(|id| seen.insert(id.clone())))
        .collect();
    all.sort_by_key(|e| e.t);

    let mut rep = UsageReport::default();
    let block = Duration::hours(BLOCK_HOURS);
    let today = now.date_naive();
    // a window starts at the hour of its first reply and lasts 5 hours, or ends after a 5-hour gap
    let mut start: Option<DateTime<Local>> = None;
    let mut last = now;
    let (mut tokens, mut replies) = (0u64, 0u32);
    for e in all {
        let new_block = match start {
            None => true,
            Some(s) => e.t >= s + block || e.t - last >= block,
        };
        if new_block {
            rep.peak_block = rep.peak_block.max(tokens);
            start = Some(floor_hour(e.t));
            tokens = 0;
            replies = 0;
        }
        tokens += e.tokens;
        replies += 1;
        last = e.t;
        let day = 6 - (today - e.t.date_naive()).num_days();
        if (0..7).contains(&day) {
            rep.days[day as usize] += e.tokens;
            rep.week += e.tokens;
        }
        if e.t.date_naive() == today {
            rep.today += e.tokens;
            rep.today_replies += 1;
        }
    }
    if let Some(s) = start {
        rep.peak_block = rep.peak_block.max(tokens);
        if now < s + block {
            rep.block_start = Some(s.timestamp_millis());
            rep.resets_at = Some((s + block).timestamp_millis());
            rep.block_tokens = tokens;
            rep.block_replies = replies;
            if rep.peak_block > 0 {
                rep.fraction = (tokens as f64 / rep.peak_block as f64).min(1.0);
            }
        }
    }
    rep
}

fn floor_hour(t: DateTime<Local>) -> DateTime<Local> {
    t.with_minute(0)
        .and_then(|t| t.with_second(0))
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(day: u32, h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, day, h, m, 0).unwrap()
    }

    fn line(t: DateTime<Local>, id: &str, model: &str, input: u64, output: u64, created: u64, read: u64) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{}","message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_creation_input_tokens":{created},"cache_read_input_tokens":{read}}}}}}}"#,
            t.with_timezone(&chrono::Utc).to_rfc3339()
        )
    }

    #[test]
    fn parses_counted_replies_only() {
        let e = parse_line(&line(at(25, 9, 30), "m1", "claude-opus", 10, 20, 30, 5000)).unwrap();
        assert_eq!(e.tokens, 60);
        assert_eq!(e.id.as_deref(), Some("m1"));
        assert_eq!(e.t, at(25, 9, 30));
        assert!(parse_line(&line(at(25, 9, 30), "m2", "<synthetic>", 1, 1, 1, 0)).is_none());
        assert!(parse_line(r#"{"type":"user","message":{"usage":{},"role":"assistant"}}"#).is_none());
        assert!(parse_line(r#"{"type":"assistant","message":{"usage":{"input_tokens":1}}}"#).is_none());
        assert!(parse_line("not json \"usage\" \"assistant\"").is_none());
    }

    fn entry(t: DateTime<Local>, id: Option<&str>, tokens: u64) -> Entry {
        Entry {
            t,
            id: id.map(str::to_string),
            tokens,
        }
    }

    #[test]
    fn splits_windows_dedupes_and_fills_days() {
        let now = at(25, 12, 0);
        let entries = [
            entry(at(20, 10, 0), Some("old"), 1000), // day index 1
            entry(at(24, 8, 15), Some("a"), 100),    // window 8:00
            entry(at(24, 8, 45), Some("a"), 100),    // same reply logged twice
            entry(at(24, 12, 59), None, 50),         // still in the 8:00 window
            entry(at(24, 13, 1), None, 70),          // past 13:00: new window
            entry(at(25, 9, 20), Some("b"), 200),    // gap over 5 h: window 9:00 today
            entry(at(25, 11, 40), None, 300),
            entry(at(16, 10, 0), Some("x"), 9999), // older than 8 days
        ];
        let rep = compute(entries.iter(), now);
        assert_eq!(rep.block_start, Some(at(25, 9, 0).timestamp_millis()));
        assert_eq!(rep.resets_at, Some(at(25, 14, 0).timestamp_millis()));
        assert_eq!(rep.block_tokens, 500);
        assert_eq!(rep.block_replies, 2);
        assert_eq!(rep.peak_block, 1000);
        assert_eq!(rep.fraction, 0.5);
        assert_eq!(rep.today, 500);
        assert_eq!(rep.today_replies, 2);
        assert_eq!(rep.days, [0, 1000, 0, 0, 0, 220, 500]);
        assert_eq!(rep.week, 1720);
    }

    #[test]
    fn no_window_after_it_ends() {
        let rep = compute([entry(at(25, 6, 10), None, 10)].iter(), at(25, 11, 0));
        assert_eq!(rep.block_start, None);
        assert_eq!(rep.fraction, 0.0);
        assert_eq!(rep.peak_block, 10);
        assert_eq!(rep.today, 10);
    }

    #[test]
    fn reads_transcripts_recursively_and_caches_by_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path().join("projects");
        let sub = projects.join("C--code-app").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        let now = Local::now();
        let main = projects.join("C--code-app").join("s.jsonl");
        std::fs::write(
            &main,
            format!("{}\n{{\"type\":\"user\"}}\n", line(now, "r1", "m", 1, 2, 3, 4)),
        )
        .unwrap();
        std::fs::write(sub.join("agent.jsonl"), line(now, "r2", "m", 10, 0, 0, 0)).unwrap();
        std::fs::write(sub.join("notes.txt"), line(now, "r3", "m", 100, 0, 0, 0)).unwrap();
        let usage = LocalUsage::default();
        let rep = usage.report(std::slice::from_ref(&projects));
        assert_eq!(rep.today, 16);
        assert_eq!(lock(&usage.files).len(), 2);
        // same mtime: the cached entries are used even though the file changed
        let modified = std::fs::metadata(&main).unwrap().modified().unwrap();
        std::fs::write(&main, line(now, "r4", "m", 1000, 0, 0, 0)).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&main)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(usage.report(std::slice::from_ref(&projects)).today, 16);
        assert_eq!(usage.report(&[dir.path().join("missing")]).today, 0);
    }
}
