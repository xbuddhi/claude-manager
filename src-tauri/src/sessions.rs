// Reads Claude Code transcripts (<profile>/projects/<slug>/<id>.jsonl) into sessions grouped by project folder.
// Same rules as the Windows app (MacUI.cs Sessions.Parse). A growing transcript is read on from where the
// last read stopped, so refreshing while Claude writes costs only the new lines.
use serde::Serialize;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub file: String,
    pub cwd: Option<String>,
    pub label: String,
    pub count: u32,
    pub modified: u64, // ms since epoch
    pub size_kb: u64,
    pub profile: String, // profile dir, e.g. ~/.claude-work
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub path: String,
    pub name: String,
    pub modified: u64,
    pub sessions: Vec<Session>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub dir: String,
    pub name: String,
}

// what has been read so far from one file
#[derive(Default, Clone)]
struct ParseState {
    offset: u64, // end of the last complete line
    cwd: Option<String>,
    prompt: Option<String>,
    title: Option<String>,
    summary: Option<String>,
    count: u32,
}

static STATES: LazyLock<Mutex<HashMap<PathBuf, ParseState>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// ~/.claude plus every ~/.claude-* folder (one per account)
pub fn profiles() -> Vec<Profile> {
    let Some(home) = dirs::home_dir() else { return vec![] };
    let mut dirs: Vec<PathBuf> = vec![home.join(".claude")];
    if let Ok(rd) = std::fs::read_dir(&home) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with(".claude-") && e.path().is_dir() {
                dirs.push(e.path());
            }
        }
    }
    dirs.sort();
    dirs.into_iter()
        .filter(|d| d.join("projects").is_dir())
        .map(|d| Profile { name: profile_name(&d), dir: d.to_string_lossy().to_string() })
        .collect()
}

pub fn profile_name(dir: &Path) -> String {
    let n = dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    match n.strip_prefix(".claude-") {
        Some(rest) if !rest.is_empty() => rest.to_string(),
        _ => "default".to_string(),
    }
}

/// every non-empty session of every profile, grouped by working folder, newest first
pub fn projects() -> Vec<Project> {
    let mut files: Vec<(PathBuf, String)> = vec![];
    for p in profiles() {
        let root = Path::new(&p.dir).join("projects");
        let Ok(slugs) = std::fs::read_dir(&root) else { continue };
        for slug in slugs.flatten() {
            let Ok(rd) = std::fs::read_dir(slug.path()) else { continue };
            for f in rd.flatten() {
                let path = f.path();
                if path.extension().is_some_and(|x| x == "jsonl") {
                    files.push((path, p.dir.clone()));
                }
            }
        }
    }
    // read in parallel; the first scan of large transcripts is the only slow part
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let chunk = files.len().div_ceil(threads).max(1);
    let sessions: Vec<Session> = std::thread::scope(|s| {
        let handles: Vec<_> = files
            .chunks(chunk)
            .map(|part| s.spawn(move || part.iter().filter_map(|(f, p)| read_session(f, p)).collect::<Vec<_>>()))
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });

    let mut map: HashMap<String, Project> = HashMap::new();
    for s in sessions.into_iter().filter(|s| s.count > 0) {
        let path = s.cwd.clone().unwrap_or_default();
        let key = if cfg!(windows) { path.to_lowercase() } else { path.clone() };
        let proj = map.entry(key).or_insert_with(|| Project {
            name: Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone()),
            path: path.clone(),
            modified: 0,
            sessions: vec![],
        });
        proj.modified = proj.modified.max(s.modified);
        proj.sessions.push(s);
    }
    let mut list: Vec<Project> = map.into_values().filter(|p| !p.path.is_empty()).collect();
    for p in &mut list {
        p.sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    }
    list.sort_by(|a, b| b.modified.cmp(&a.modified));
    list
}

fn read_session(path: &Path, profile: &str) -> Option<Session> {
    let meta = std::fs::metadata(path).ok()?;
    let st = read_lines(path, meta.len())?;
    let full = st.title.or(st.summary).or(st.prompt).unwrap_or_else(|| "(no prompt)".into());
    let full = full.split_whitespace().collect::<Vec<_>>().join(" ");
    let label = if full.chars().count() > 140 { full.chars().take(140).collect::<String>() + "..." } else { full };
    Some(Session {
        id: path.file_stem()?.to_string_lossy().to_string(),
        file: path.to_string_lossy().to_string(),
        cwd: st.cwd,
        label,
        count: st.count,
        modified: meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64,
        size_kb: meta.len().div_ceil(1024),
        profile: profile.to_string(),
    })
}

// reads from the saved offset to the end; a last line without a newline counts in this result but is read again next time
fn read_lines(path: &Path, len: u64) -> Option<ParseState> {
    let mut st = STATES.lock().ok()?.get(path).cloned().unwrap_or_default();
    if len < st.offset {
        st = ParseState::default(); // rewritten shorter: start over
    }
    let mut f = File::open(path).ok()?;
    f.seek(SeekFrom::Start(st.offset)).ok()?;
    let mut buf = vec![0u8; 1 << 20];
    let mut pending: Vec<u8> = vec![];
    let mut pos = st.offset;
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        let mut start = 0;
        for i in 0..n {
            if buf[i] != b'\n' {
                continue;
            }
            if pending.is_empty() {
                parse_line(&mut st, &buf[start..i]);
            } else {
                pending.extend_from_slice(&buf[start..i]);
                let line = std::mem::take(&mut pending);
                parse_line(&mut st, &line);
            }
            start = i + 1;
            st.offset = pos + i as u64 + 1;
        }
        pending.extend_from_slice(&buf[start..n]);
        pos += n as u64;
    }
    STATES.lock().ok()?.insert(path.to_path_buf(), st.clone());
    if !pending.is_empty() {
        parse_line(&mut st, &pending);
    }
    Some(st)
}

fn parse_line(st: &mut ParseState, bytes: &[u8]) {
    let line = String::from_utf8_lossy(bytes);
    let line = line.trim_end_matches('\r').trim_start_matches('\u{feff}');
    let user = line.contains("\"type\":\"user\"") && !line.contains("\"tool_result\"");
    if user {
        st.count += 1;
    }
    if st.cwd.is_none() && line.contains("\"cwd\":\"") {
        st.cwd = str_field(line, "cwd");
    }
    if st.prompt.is_none() && user && !line.contains("\"isMeta\":true") {
        if let Some(t) = prompt_text(line) {
            if !t.is_empty() && !t.trim_start().starts_with('<') {
                st.prompt = Some(t);
            }
        }
    }
    if line.starts_with("{\"type\":\"custom-title\"") {
        if let Some(t) = str_field(line, "customTitle") {
            st.title = Some(t);
        }
    } else if st.summary.is_none() && line.starts_with("{\"type\":\"summary\"") {
        st.summary = str_field(line, "summary");
    }
}

fn str_field(line: &str, prop: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    v.get(prop)?.as_str().map(String::from)
}

fn prompt_text(line: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    let content = v.get("message")?.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    content.as_array()?.iter().find_map(|part| {
        if part.get("type")?.as_str()? == "text" { part.get("text")?.as_str().map(String::from) } else { None }
    })
}
