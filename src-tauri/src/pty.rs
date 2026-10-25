// Terminal tabs: each one is a PTY (ConPTY on Windows, a pseudo-terminal on macOS/Linux) running `claude`.
// Output goes to the window over a Channel; keystrokes and resizes come back as commands.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::ipc::Channel;

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terms {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Term>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// the command a tab runs: `claude <args>` for the given profile
fn claude_command(cwd: &str, profile: &str, args: &[String]) -> CommandBuilder {
    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("claude");
        c.args(args);
        c
    } else {
        // apps started from Finder get a bare PATH; a login shell picks up the user's (~/.local/bin, Homebrew, ...)
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let line = std::iter::once("exec claude".to_string()).chain(args.iter().map(|a| shell_quote(a))).collect::<Vec<_>>().join(" ");
        let mut c = CommandBuilder::new(shell);
        c.args(["-l", "-c", &line]);
        c
    };
    cmd.cwd(cwd);
    // started from inside a Claude Code session? Don't pass its markers down, or new sessions think they are sub-sessions
    for (k, _) in std::env::vars() {
        if k == "NO_COLOR" || k == "CLAUDECODE" || k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_") || k == "CLAUDE_CONFIG_DIR" {
            cmd.env_remove(k);
        }
    }
    let default = dirs::home_dir().map(|h| h.join(".claude"));
    if default.as_deref() != Some(Path::new(profile)) {
        cmd.env("CLAUDE_CONFIG_DIR", profile);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

impl Terms {
    pub fn spawn(&self, cwd: &str, profile: &str, args: &[String], cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> Result<u32, String> {
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
        let child = pair.slave.spawn_command(claude_command(cwd, profile, args)).map_err(|e| format!("could not start claude: {e}"))?;
        drop(pair.slave); // the child holds its own handle; ours would keep the PTY open after it exits
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;

        // pump output until the PTY closes; keep an incomplete UTF-8 sequence for the next read
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            let mut carry: Vec<u8> = vec![];
            loop {
                let n = match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                carry.extend_from_slice(&buf[..n]);
                let valid = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(), // cut mid-character: wait for the rest
                    Err(_) => carry.len(),                                // really invalid: let lossy decoding replace it
                };
                let data = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                if on_event.send(PtyEvent::Data { data }).is_err() {
                    break;
                }
            }
            let _ = on_event.send(PtyEvent::Exit { code: None });
        });

        self.map.lock().unwrap().insert(id, Term { master: pair.master, writer, child });
        Ok(id)
    }

    pub fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let t = map.get_mut(&id).ok_or("no such terminal")?;
        t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        t.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let map = self.map.lock().unwrap();
        let t = map.get(&id).ok_or("no such terminal")?;
        t.master.resize(size(cols, rows)).map_err(|e| e.to_string())
    }

    pub fn kill(&self, id: u32) {
        if let Some(mut t) = self.map.lock().unwrap().remove(&id) {
            let _ = t.child.kill();
        }
    }

    pub fn kill_all(&self) {
        for (_, mut t) in self.map.lock().unwrap().drain() {
            let _ = t.child.kill();
        }
    }
}
