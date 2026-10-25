//! Reads Claude Code transcripts (`<profile>/projects/<slug>/<id>.jsonl`): the same rules as the Windows app
//! (MacUI.cs `Sessions.Parse`), made incremental. A growing transcript is read on from the end of its last
//! complete line, so a re-read costs only the new lines.

use crate::core::types::Session;
use memchr::memmem::Finder;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::io::{self, Read};
use std::path::Path;
use std::sync::LazyLock;

/// Lines longer than this are not kept in memory; they only get the cheap checks (user line or not).
pub const MAX_LINE: usize = 8 << 20;
/// `"type"` and the start of `content` come before any payload: the user / tool_result checks look only here.
const HEAD: usize = 4096;
/// Stored titles and prompts: whitespace collapsed, one character more than the longest text shown (600),
/// so the shown text still knows it was cut.
const KEEP_CHARS: usize = 601;
const READ_BUF: usize = 256 << 10;

static USER: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""type":"user""#));
static TOOL_RESULT: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""tool_result""#));
static CWD: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""cwd":""#));
static IS_META: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""isMeta":true"#));

thread_local! {
    static BUF: RefCell<Vec<u8>> = RefCell::new(vec![0; READ_BUF]);
}

/// What has been read so far from one transcript. Persisted in the index cache.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ParseState {
    /// File length when it was last read to the end; 0 = never read to the end.
    pub len: u64,
    /// Last write time at that read, ms since the Unix epoch.
    pub mtime_ms: u64,
    /// End of the last complete line: the next read starts here.
    pub offset: u64,
    pub cwd: Option<String>,
    pub prompt: Option<String>,
    /// `customTitle` of the last `custom-title` line.
    pub title: Option<String>,
    /// The first `summary` line.
    pub summary: Option<String>,
    /// `aiTitle` of the last `ai-title` line.
    pub ai_title: Option<String>,
    pub count: u32,
}

impl ParseState {
    /// The text the session is shown with: title, summary, AI title, first prompt, in that order.
    pub fn text(&self) -> &str {
        [&self.title, &self.summary, &self.ai_title, &self.prompt]
            .into_iter()
            .find_map(|t| t.as_deref())
            .unwrap_or("(no prompt)")
    }
}

/// Result of [`read_on`].
pub struct ReadResult {
    /// `state` plus a last line that has no newline yet (that line is read again next time).
    pub view: ParseState,
    /// Stopped at the end of the file (not at the byte budget).
    pub at_end: bool,
}

/// Reads `file` (positioned at `st.offset`) on. Complete lines go into `st` and move its offset; the result
/// also holds a last line without a newline. With a `budget`, stops after that many bytes, leaving a line
/// cut by the budget unread. Lines over [`MAX_LINE`] are not buffered and only get the cheap checks.
pub fn read_on(file: &mut impl Read, st: &mut ParseState, budget: Option<u64>) -> io::Result<ReadResult> {
    BUF.with(|cell| {
        let buf = &mut *cell.borrow_mut();
        let end = budget.map(|b| st.offset.saturating_add(b));
        let mut pos = st.offset;
        let mut line = Line::default();
        let at_end = loop {
            let want = end.map_or(buf.len(), |e| (e - pos).min(buf.len() as u64) as usize);
            if want == 0 {
                break false;
            }
            let n = match file.read(&mut buf[..want]) {
                Ok(0) => break true,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            let chunk = &buf[..n];
            let mut start = 0;
            for nl in memchr::memchr_iter(b'\n', chunk) {
                if line.is_empty() {
                    parse_line(st, &chunk[start..nl], true);
                } else {
                    line.push(&chunk[start..nl]);
                    line.parse_into(st);
                    line = Line::default();
                }
                start = nl + 1;
                st.offset = pos + start as u64;
            }
            line.push(&chunk[start..]);
            pos += n as u64;
        };
        let mut view = st.clone();
        if at_end && !line.is_empty() {
            line.parse_into(&mut view);
        }
        Ok(ReadResult { view, at_end })
    })
}

/// A line that spans reads. Past [`MAX_LINE`] only its head is kept.
#[derive(Default)]
struct Line {
    bytes: Vec<u8>,
    oversized: bool,
}

impl Line {
    fn is_empty(&self) -> bool {
        self.bytes.is_empty() && !self.oversized
    }

    fn push(&mut self, part: &[u8]) {
        if self.oversized {
            return;
        }
        if self.bytes.len() + part.len() > MAX_LINE {
            self.oversized = true;
            let room = HEAD.saturating_sub(self.bytes.len());
            self.bytes.extend_from_slice(&part[..room.min(part.len())]);
            self.bytes.truncate(HEAD);
            self.bytes.shrink_to_fit();
        } else {
            self.bytes.extend_from_slice(part);
        }
    }

    fn parse_into(&self, st: &mut ParseState) {
        parse_line(st, &self.bytes, !self.oversized);
    }
}

/// Applies one line. `complete` = false: only the head of an oversized line is known, so only the
/// user-line count is taken from it.
pub fn parse_line(st: &mut ParseState, raw: &[u8], complete: bool) {
    let line = raw.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(raw);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let head = &line[..line.len().min(HEAD)];
    let user = USER.find(head).is_some() && TOOL_RESULT.find(head).is_none();
    if user {
        st.count += 1;
    }
    if !complete {
        return;
    }
    let want_cwd = st.cwd.is_none() && CWD.find(line).is_some();
    let want_prompt = st.prompt.is_none() && user && IS_META.find(line).is_none();
    let title = line.starts_with(br#"{"type":"custom-title""#);
    let summary = st.summary.is_none() && line.starts_with(br#"{"type":"summary""#);
    let ai_title = line.starts_with(br#"{"type":"ai-title""#);
    if !(want_cwd || want_prompt || title || summary || ai_title) {
        return;
    }
    let Some(v) = json(line) else { return };
    if want_cwd {
        st.cwd = v
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(String::from);
    }
    if want_prompt
        && let Some(t) = prompt_text(&v)
        && !t.trim_start().starts_with('<')
    {
        st.prompt = clip(t);
    }
    if title {
        // last wins; an empty title clears it
        if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
            st.title = clip(t);
        }
    } else if summary {
        st.summary = v.get("summary").and_then(Value::as_str).and_then(clip);
    } else if ai_title && let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
        st.ai_title = clip(t);
    }
}

fn json(line: &[u8]) -> Option<Value> {
    match serde_json::from_slice(line) {
        Ok(v) => Some(v),
        // invalid UTF-8 in a string: read it the lossy way, as the Windows app did
        Err(_) if std::str::from_utf8(line).is_err() => serde_json::from_str(&String::from_utf8_lossy(line)).ok(),
        Err(_) => None,
    }
}

/// `message.content` when it is a string, else the first `{type:"text"}` part.
fn prompt_text(v: &Value) -> Option<&str> {
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s);
    }
    content
        .as_array()?
        .iter()
        .find(|part| part.get("type").and_then(Value::as_str) == Some("text"))?
        .get("text")?
        .as_str()
}

/// Whitespace collapsed and cut to [`KEEP_CHARS`]; None when nothing is left.
pub fn clip(text: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = 0;
    for word in text.split_whitespace() {
        if chars >= KEEP_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
            chars += 1;
        }
        for c in word.chars() {
            if chars >= KEEP_CHARS {
                break;
            }
            out.push(c);
            chars += 1;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// At most `max` characters, then "..." when cut.
pub fn truncate(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}...", &text[..cut]),
        None => text.to_string(),
    }
}

/// The session a transcript shows as. `len` and `mtime_ms` are the file's current values.
pub fn session(path: &Path, profile: &str, st: &ParseState, len: u64, mtime_ms: u64, partial: bool) -> Session {
    let text = st.text();
    Session {
        id: stem(path),
        file: path.to_string_lossy().into_owned(),
        cwd: st.cwd.clone(),
        label: truncate(text, 140),
        full: truncate(text, 600),
        count: st.count,
        modified: mtime_ms,
        size_kb: len.div_ceil(1024),
        profile: profile.to_string(),
        slug: path
            .parent()
            .and_then(Path::file_name)
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        partial,
    }
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(bytes: &[u8]) -> (ParseState, ParseState) {
        let mut st = ParseState::default();
        let r = read_on(&mut Cursor::new(bytes), &mut st, None).unwrap();
        assert!(r.at_end);
        (st, r.view)
    }

    fn user(text: &str) -> String {
        format!(
            r#"{{"type":"user","cwd":"C:\\code\\app","message":{{"role":"user","content":{}}}}}"#,
            json_str(text)
        )
    }

    fn json_str(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }

    #[test]
    fn reads_the_first_real_prompt_and_counts_user_lines() {
        let lines = [
            r#"{"type":"file-history-snapshot","messageId":"x"}"#.to_string(),
            r#"{"type":"user","isMeta":true,"cwd":"C:\\code\\app","message":{"content":"meta caveat"}}"#.into(),
            user("<command-name>/clear</command-name>"),
            r#"{"type":"user","message":{"content":[{"tool_use_id":"t","type":"tool_result","content":"ok"}]}}"#.into(),
            r#"{"type":"user","message":{"content":[{"type":"image"},{"type":"text","text":"  fix   the\n bug "}]}}"#
                .into(),
            user("second prompt"),
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}"#.into(),
        ];
        let (_, v) = read_all((lines.join("\n") + "\n").as_bytes());
        assert_eq!(v.count, 4, "meta and '<' lines count, tool results do not");
        assert_eq!(v.cwd.as_deref(), Some(r"C:\code\app"));
        assert_eq!(v.prompt.as_deref(), Some("fix the bug"));
        assert_eq!(v.text(), "fix the bug");
    }

    #[test]
    fn cwd_comes_from_the_top_level_field_only() {
        let lines = [
            r#"{"type":"assistant","message":{"content":"{\"cwd\":\"nested\"}","x":{"cwd":"deep"}}}"#.to_string(),
            r#"{"type":"system","cwd":"/Users/me/proj"}"#.into(),
        ];
        let (_, v) = read_all((lines.join("\n") + "\n").as_bytes());
        assert_eq!(v.cwd.as_deref(), Some("/Users/me/proj"));
    }

    #[test]
    fn titles_win_in_order_custom_summary_ai_prompt() {
        let base = user("the prompt");
        let ai = r#"{"type":"ai-title","aiTitle":"First AI title"}"#;
        let ai2 = r#"{"type":"ai-title","aiTitle":"Better AI title"}"#;
        let summary = r#"{"type":"summary","summary":"The summary","leafUuid":"u"}"#;
        let summary2 = r#"{"type":"summary","summary":"Later summary","leafUuid":"u"}"#;
        let custom = r#"{"type":"custom-title","customTitle":"Mine","sessionId":"s"}"#;
        let custom2 = r#"{"type":"custom-title","customTitle":"Mine again","sessionId":"s"}"#;
        let text = |lines: &[&str]| read_all((lines.join("\n") + "\n").as_bytes()).1.text().to_string();
        assert_eq!(text(&[&base]), "the prompt");
        assert_eq!(text(&[&base, ai, ai2]), "Better AI title");
        assert_eq!(text(&[&base, ai, summary, summary2]), "The summary");
        assert_eq!(text(&[custom, &base, summary, custom2, ai]), "Mine again");
        assert_eq!(text(&[]), "(no prompt)");
    }

    #[test]
    fn strips_bom_and_crlf() {
        let text = format!(
            "\u{feff}{}\r\n{}\r\n",
            user("hello"),
            r#"{"type":"summary","summary":"S"}"#
        );
        let (st, v) = read_all(text.as_bytes());
        assert_eq!(v.count, 1);
        assert_eq!(v.prompt.as_deref(), Some("hello"));
        assert_eq!(v.summary.as_deref(), Some("S"));
        assert_eq!(st.offset, text.len() as u64);
    }

    #[test]
    fn a_line_split_across_reads_is_joined() {
        let long = "x".repeat(READ_BUF + 1000);
        let text = format!("{}\n{}\n", user(&long), user("b"));
        let (_, v) = read_all(text.as_bytes());
        assert_eq!(v.count, 2);
        assert_eq!(v.prompt.as_deref().map(|p| p.chars().count()), Some(KEEP_CHARS));
    }

    #[test]
    fn a_line_without_newline_counts_but_is_read_again() {
        let first = user("one") + "\n";
        let text = format!("{first}{}", user("two"));
        let mut st = ParseState::default();
        let r = read_on(&mut Cursor::new(text.as_bytes()), &mut st, None).unwrap();
        assert_eq!((st.count, r.view.count), (1, 2));
        assert_eq!(st.offset, first.len() as u64);
    }

    #[test]
    fn appended_lines_are_read_from_the_offset() {
        let first = user("one") + "\n";
        let mut st = ParseState::default();
        read_on(&mut Cursor::new(first.as_bytes()), &mut st, None).unwrap();
        let appended = format!("{first}{}\n", user("two"));
        let mut file = Cursor::new(appended.as_bytes());
        file.set_position(st.offset);
        let r = read_on(&mut file, &mut st, None).unwrap();
        assert_eq!(r.view.count, 2);
        assert_eq!(r.view.prompt.as_deref(), Some("one"));
        assert_eq!(st.offset, appended.len() as u64);
    }

    #[test]
    fn a_budget_stops_early_without_parsing_the_cut_line() {
        let text = format!("{}\n{}\n", user("one"), user("two"));
        let mut st = ParseState::default();
        let r = read_on(&mut Cursor::new(text.as_bytes()), &mut st, Some(text.len() as u64 - 3)).unwrap();
        assert!(!r.at_end);
        assert_eq!(r.view.count, 1);
        let mut file = Cursor::new(text.as_bytes());
        file.set_position(st.offset);
        let r = read_on(&mut file, &mut st, None).unwrap();
        assert!(r.at_end);
        assert_eq!(r.view.count, 2);
    }

    #[test]
    fn oversized_lines_only_count() {
        let huge = format!(
            r#"{{"type":"user","cwd":"/big","message":{{"content":"{}"}}}}"#,
            "y".repeat(MAX_LINE + 10)
        );
        let text = format!("{huge}\n{}\n", user("small"));
        let (_, v) = read_all(text.as_bytes());
        assert_eq!(v.count, 2);
        assert_eq!(v.prompt.as_deref(), Some("small"), "the huge line is not parsed");
        assert_eq!(v.cwd.as_deref(), Some(r"C:\code\app"));
    }

    #[test]
    fn tool_result_is_only_looked_for_in_the_line_head() {
        let late = format!(
            r#"{{"type":"user","message":{{"content":"{} \"tool_result\""}}}}"#,
            "z".repeat(HEAD)
        );
        let (_, v) = read_all(format!("{late}\n").as_bytes());
        assert_eq!(v.count, 1);
    }

    #[test]
    fn labels_are_cut_at_140_and_600_characters() {
        let st = ParseState {
            prompt: clip(&"word ".repeat(200)),
            ..Default::default()
        };
        let s = session(Path::new("p/slug/id.jsonl"), "prof", &st, 1025, 7, false);
        assert_eq!(s.label.chars().count(), 140 + 3);
        assert!(s.label.ends_with("..."));
        assert!(s.full.ends_with("...") && s.full.chars().count() <= 603);
        assert_eq!(
            (s.size_kb, s.modified, s.slug.as_str(), s.id.as_str()),
            (2, 7, "slug", "id")
        );
        let short = ParseState {
            title: clip("  Short\ttitle "),
            ..Default::default()
        };
        assert_eq!(
            session(Path::new("a.jsonl"), "p", &short, 0, 0, false).full,
            "Short title"
        );
    }
}
