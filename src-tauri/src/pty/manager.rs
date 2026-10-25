// Terminal tabs: each one is a PTY (ConPTY on Windows, a pseudo-terminal on macOS/Linux) running `claude`.
// Output goes to the window over a Channel; keystrokes and resizes come back as commands.
//
// Each terminal has its own locks, and the map lock is only held to look an entry up, so a child that
// stops reading its input blocks writes to that one terminal only. Callers run these methods off the
// UI thread. Exit detection on Windows, removing exited entries and flow control come with WP2.
use crate::core::error::{AppError, AppResult, lock};
use crate::core::lifecycle::ShutdownHook;
use crate::core::procs;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use ts_rs::TS;

/// Messages on a terminal's output channel.
#[derive(Serialize, TS, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export)]
pub enum PtyEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

struct Term {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    pid: Option<u32>,
}

/// All terminals. Cheap to clone; clones share the same map.
#[derive(Clone, Default)]
pub struct Terms {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    next: AtomicU32,
    map: Mutex<HashMap<u32, Arc<Term>>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(2),
        cols: cols.max(10),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Maps a portable-pty error (an `anyhow::Error`) to an [`AppError`] that says what failed.
fn pty_error<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> AppError + '_ {
    move |e| AppError::Internal(format!("{what}: {e}"))
}

impl Terms {
    /// Starts `cmd` in a new PTY and streams its output to `on_event`. Returns the terminal id.
    pub fn spawn(&self, cmd: CommandBuilder, cols: u16, rows: u16, on_event: Channel<PtyEvent>) -> AppResult<u32> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(pty_error("could not open a terminal"))?;
        // take both ends before starting the child, so a failure here cannot leave a child running untracked
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(pty_error("could not read the terminal"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(pty_error("could not write to the terminal"))?;
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(pty_error("could not start claude"))?;
        drop(pair.slave); // the child holds its own handle; ours would keep the PTY open after it exits
        let pid = child.process_id();
        #[cfg(windows)]
        if let Some(pid) = pid
            && let Err(e) = procs::assign_to_job(pid)
        {
            log::warn!("terminal {pid} is not in the job object; its processes may outlive a crash: {e}");
        }

        let id = self.inner.next.fetch_add(1, Ordering::Relaxed) + 1;
        let term = Term {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            pid,
        };
        lock(&self.inner.map).insert(id, Arc::new(term));

        // pump output until the PTY closes; keep an incomplete UTF-8 sequence for the next read
        let pumped = std::thread::Builder::new().name(format!("pty-{id}")).spawn(move || {
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
                    Err(_) => carry.len(), // really invalid: let lossy decoding replace it
                };
                let data = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                if on_event.send(PtyEvent::Data { data }).is_err() {
                    break;
                }
            }
            let _ = on_event.send(PtyEvent::Exit { code: None });
        });
        if let Err(e) = pumped {
            self.kill(id);
            return Err(AppError::Internal(format!("could not start the terminal reader: {e}")));
        }
        Ok(id)
    }

    fn get(&self, id: u32) -> AppResult<Arc<Term>> {
        lock(&self.inner.map)
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("no such terminal".into()))
    }

    pub fn write(&self, id: u32, data: &str) -> AppResult<()> {
        let term = self.get(id)?;
        let mut writer = lock(&term.writer);
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> AppResult<()> {
        let term = self.get(id)?;
        lock(&term.master)
            .resize(size(cols, rows))
            .map_err(pty_error("could not resize the terminal"))
    }

    /// Ends the terminal and every process it started.
    pub fn kill(&self, id: u32) {
        let removed = lock(&self.inner.map).remove(&id);
        if let Some(term) = removed {
            end(&[term]);
        }
    }

    pub fn kill_all(&self) {
        let all: Vec<Arc<Term>> = lock(&self.inner.map).drain().map(|(_, t)| t).collect();
        end(&all);
    }

    /// Terminals whose process is still running.
    pub fn live_count(&self) -> usize {
        let terms: Vec<Arc<Term>> = lock(&self.inner.map).values().cloned().collect();
        terms
            .iter()
            .filter(|t| matches!(lock(&t.child).try_wait(), Ok(None)))
            .count()
    }
}

fn end(terms: &[Arc<Term>]) {
    let pids: Vec<u32> = terms.iter().filter_map(|t| t.pid).collect();
    procs::kill_trees(&pids);
    for t in terms {
        // covers a child whose pid was unknown; harmless when it already ended
        let _ = lock(&t.child).kill();
    }
}

impl ShutdownHook for Terms {
    fn live_count(&self) -> usize {
        Terms::live_count(self)
    }

    fn shutdown(&self) {
        self.kill_all();
    }
}
