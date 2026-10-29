//! The app's terminals: each one is a PTY (ConPTY on Windows, a pseudo-terminal on macOS) running claude.
//!
//! - The map lock is held only to look an entry up or remove it, never during I/O; each terminal has its
//!   own locks, a writer thread (writer.rs) and reader + pump threads (reader.rs).
//! - A waiter thread owns the child: when it exits, the waiter records the exit code, removes the entry
//!   (which drops the master, so ConPTY closes and the reader sees the end), and the pump sends the exit
//!   message after the last output.
//! - Killing removes the entry first, then ends the whole process tree (claude, node, MCP servers, tool
//!   shells). Callers run these methods off the UI thread.

use super::reader::{self, Output, Sink};
use super::types::PtyInfo;
use super::writer;
use crate::core::error::{AppError, AppResult, lock};
use crate::core::lifecycle::ShutdownHook;
use crate::core::procs;
use crate::core::terms::TermPids;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the app tells about a terminal (see [`PtyInfo`]).
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub dir: String,
    pub profile: String,
    pub session_id: Option<String>,
    pub title: String,
    /// Label of the window the output goes to.
    pub window: String,
    /// A shell panel's terminal: the tab terminal it belongs to.
    pub owner: Option<u32>,
}

struct Term {
    meta: Mutex<Meta>,
    /// The child's pid while it runs; cleared by the waiter once it has exited (on Unix the pid is then
    /// free for reuse and must not be signalled).
    pid: Arc<Mutex<Option<u32>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input: Sender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Arc<Output>,
}

impl Term {
    fn info(&self, id: u32) -> PtyInfo {
        let meta = lock(&self.meta).clone();
        PtyInfo {
            id,
            pid: *lock(&self.pid),
            dir: meta.dir,
            profile: meta.profile,
            session_id: meta.session_id,
            title: meta.title,
            window: Some(meta.window),
            owner: meta.owner,
        }
    }
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
        rows: rows.clamp(2, 1000),
        cols: cols.clamp(10, 1000),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Maps a portable-pty error (an `anyhow::Error`) to an [`AppError`] that says what failed.
fn pty_error<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> AppError + '_ {
    move |e| AppError::Internal(format!("{what}: {e}"))
}

/// Gives ConPTY a moment to pass on the child's last output before it is closed.
const EXIT_SETTLE: Duration = Duration::from_millis(if cfg!(windows) { 150 } else { 0 });

impl Terms {
    /// Starts `cmd` in a new PTY; its output goes to `sink`. Returns the new terminal.
    pub fn spawn(&self, cmd: CommandBuilder, cols: u16, rows: u16, meta: Meta, sink: Sink) -> AppResult<PtyInfo> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(pty_error("Could not open a terminal"))?;
        // take both ends before starting the child, so a failure here cannot leave a child running untracked
        let read = pair
            .master
            .try_clone_reader()
            .map_err(pty_error("Could not read the terminal"))?;
        let write = pair
            .master
            .take_writer()
            .map_err(pty_error("Could not write to the terminal"))?;
        let program = cmd.get_argv().first().map(|p| p.to_string_lossy().into_owned());
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
            AppError::Internal(format!(
                "Could not start {}: {e}",
                program.as_deref().unwrap_or("claude")
            ))
        })?;
        drop(pair.slave); // the child holds its own handle; ours would keep the PTY open after it exits
        let pid = child.process_id();
        #[cfg(windows)]
        if let Some(pid) = pid
            && let Err(e) = procs::assign_to_job(pid)
        {
            log::warn!("terminal {pid} is not in the job object; its processes may outlive a crash: {e}");
        }

        let id = self.inner.next.fetch_add(1, Ordering::Relaxed) + 1;
        let output = Output::new(sink);
        let started = reader::start(id, read, output.clone()).and_then(|()| writer::spawn(id, write));
        let input = match started {
            Ok(tx) => tx,
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Internal(format!("Could not start the terminal threads: {e}")));
            }
        };
        let pid_cell = Arc::new(Mutex::new(pid));
        let term = Arc::new(Term {
            meta: Mutex::new(meta),
            pid: pid_cell.clone(),
            master: Mutex::new(pair.master),
            input,
            killer: Mutex::new(child.clone_killer()),
            output: output.clone(),
        });
        let info = term.info(id);
        lock(&self.inner.map).insert(id, term);

        let terms = self.clone();
        let waited = std::thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => Some(status.exit_code()),
                    Err(e) => {
                        log::warn!("could not wait for terminal {id}: {e}");
                        None
                    }
                };
                *lock(&pid_cell) = None;
                log::info!("terminal {id} exited with {code:?}");
                output.set_exit(code);
                std::thread::sleep(EXIT_SETTLE);
                // dropping the entry drops the master: the PTY closes and the reader sees the end
                drop(terms.remove(id));
            });
        if let Err(e) = waited {
            self.kill(id);
            return Err(AppError::Internal(format!("Could not watch the terminal: {e}")));
        }
        Ok(info)
    }

    fn get(&self, id: u32) -> AppResult<Arc<Term>> {
        lock(&self.inner.map)
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("This terminal has ended.".into()))
    }

    fn remove(&self, id: u32) -> Option<Arc<Term>> {
        lock(&self.inner.map).remove(&id)
    }

    /// Queues input for the terminal; never waits for the child to read it.
    pub fn write(&self, id: u32, data: Vec<u8>) -> AppResult<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.get(id)?
            .input
            .send(data)
            .map_err(|_| AppError::NotFound("This terminal no longer takes input.".into()))
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> AppResult<()> {
        let term = self.get(id)?;
        let master = lock(&term.master);
        master
            .resize(size(cols, rows))
            .map_err(pty_error("Could not resize the terminal"))
    }

    /// Stops (`true`) or resumes sending output; the child blocks once the queue behind it is full.
    pub fn set_paused(&self, id: u32, paused: bool, seq: u64) -> AppResult<()> {
        self.get(id)?.output.set_paused(paused, seq);
        Ok(())
    }

    /// Sends the output to new channels from now on, replaying the kept output first.
    pub fn attach(&self, id: u32, sink: Sink, window: &str) -> AppResult<PtyInfo> {
        let term = self.get(id)?;
        lock(&term.meta).window = window.to_string();
        term.output.attach(sink);
        Ok(term.info(id))
    }

    pub fn set_window(&self, id: u32, window: &str) -> AppResult<()> {
        lock(&self.get(id)?.meta).window = window.to_string();
        Ok(())
    }

    pub fn set_title(&self, id: u32, title: &str) -> AppResult<()> {
        lock(&self.get(id)?.meta).title = title.to_string();
        Ok(())
    }

    pub fn info(&self, id: u32) -> AppResult<PtyInfo> {
        Ok(self.get(id)?.info(id))
    }

    /// Every terminal whose child has not been reported ended, oldest first.
    pub fn list(&self) -> Vec<PtyInfo> {
        let terms: Vec<(u32, Arc<Term>)> = lock(&self.inner.map).iter().map(|(k, v)| (*k, v.clone())).collect();
        let mut list: Vec<PtyInfo> = terms.iter().map(|(id, t)| t.info(*id)).collect();
        list.sort_by_key(|t| t.id);
        list
    }

    /// Ends the terminal and every process it started. An unknown id (already ended) is fine.
    pub fn kill(&self, id: u32) {
        if let Some(term) = self.remove(id) {
            end(vec![term], procs::GRACE);
        }
    }

    pub fn kill_all(&self, grace: Duration) {
        let all: Vec<Arc<Term>> = lock(&self.inner.map).drain().map(|(_, t)| t).collect();
        end(all, grace);
    }

    /// Pids of the terminals whose child still runs.
    pub fn running_pids(&self) -> Vec<u32> {
        let terms: Vec<Arc<Term>> = lock(&self.inner.map).values().cloned().collect();
        terms.iter().filter_map(|t| *lock(&t.pid)).collect()
    }

    pub fn count(&self) -> usize {
        lock(&self.inner.map).len()
    }

    /// Ids of the terminals shown in window `label`.
    pub fn ids_in(&self, label: &str) -> Vec<u32> {
        self.list()
            .into_iter()
            .filter(|t| t.window.as_deref() == Some(label))
            .map(|t| t.id)
            .collect()
    }

    /// The terminal (id and window) whose child is one of `pids`.
    pub fn of_pids(&self, pids: &[u32]) -> Option<(u32, String)> {
        let terms: Vec<(u32, Arc<Term>)> = lock(&self.inner.map).iter().map(|(k, v)| (*k, v.clone())).collect();
        terms.iter().find_map(|(id, t)| {
            let pid = (*lock(&t.pid))?;
            pids.contains(&pid).then(|| (*id, lock(&t.meta).window.clone()))
        })
    }
}

fn end(terms: Vec<Arc<Term>>, grace: Duration) {
    if terms.is_empty() {
        return;
    }
    for t in &terms {
        t.output.close();
    }
    // an exited child's pid is not signalled: it may belong to another process by now
    let pids: Vec<u32> = terms.iter().filter_map(|t| *lock(&t.pid)).collect();
    procs::kill_trees(&pids, grace);
    for t in &terms {
        // covers a child whose pid was unknown; on Unix the killer signals by pid, so only while it runs
        if cfg!(windows) || lock(&t.pid).is_some() {
            let _ = lock(&t.killer).kill();
        }
    }
    // Dropping the last reference drops writer and master; the waiter reaps. Closing a ConPTY can block
    // (Windows 10 waits for conhost, which may still wait for an answer to its cursor query), so it never
    // happens on the caller's thread: quitting must not hang on it.
    let dropped = std::thread::Builder::new()
        .name("pty-close".into())
        .spawn(move || drop(terms));
    if let Err(e) = dropped {
        log::warn!("could not close terminals in the background: {e}");
    }
}

impl ShutdownHook for Terms {
    fn live_count(&self) -> usize {
        self.count()
    }

    fn live_in(&self, label: &str) -> usize {
        self.ids_in(label).len()
    }

    fn hand_over(&self, from: Option<&str>, to: &str) -> Vec<u32> {
        let moved: Vec<u32> = self
            .list()
            .into_iter()
            .filter(|t| t.window.as_deref() != Some(to) && from.is_none_or(|f| t.window.as_deref() == Some(f)))
            .map(|t| t.id)
            .collect();
        for id in &moved {
            let _ = self.set_window(*id, to);
        }
        moved
    }

    fn end_in(&self, label: &str) {
        let terms: Vec<Arc<Term>> = self
            .ids_in(label)
            .into_iter()
            .filter_map(|id| self.remove(id))
            .collect();
        end(terms, procs::GRACE);
    }

    fn shutdown(&self) {
        self.kill_all(procs::GRACE_ON_EXIT);
    }
}

impl TermPids for Terms {
    fn pids(&self) -> Vec<u32> {
        self.running_pids()
    }

    fn tab_of(&self, pids: &[u32]) -> Option<(u32, String)> {
        self.of_pids(pids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::reader::tests::Recorder;

    fn shell(script: &str) -> CommandBuilder {
        let mut cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/d", "/c", script]);
            c
        } else {
            let mut c = CommandBuilder::new("/bin/sh");
            c.args(["-c", script]);
            c
        };
        cmd.cwd(std::env::temp_dir());
        cmd
    }

    fn interactive_shell() -> CommandBuilder {
        let mut cmd = if cfg!(windows) {
            let mut c = CommandBuilder::new("cmd.exe");
            c.args(["/d", "/q"]);
            c
        } else {
            CommandBuilder::new("/bin/sh")
        };
        cmd.cwd(std::env::temp_dir());
        cmd
    }

    /// ConPTY asks for the cursor position before the program may run; xterm answers it in the app.
    fn answer_cursor_query(terms: &Terms, id: u32, rec: &Recorder) {
        if cfg!(windows) && rec.wait(10, |r| r.text().contains("\x1b[6n")) {
            terms.write(id, b"\x1b[1;1R".to_vec()).unwrap();
        }
    }

    fn spawn(terms: &Terms, cmd: CommandBuilder, rec: &Recorder) -> PtyInfo {
        let info = terms.spawn(cmd, 80, 24, meta(), rec.sink()).unwrap();
        answer_cursor_query(terms, info.id, rec);
        info
    }

    fn meta() -> Meta {
        Meta {
            dir: "/tmp".into(),
            profile: "/p".into(),
            title: "New session".into(),
            window: "main".into(),
            ..Meta::default()
        }
    }

    /// Ends whatever a test left running, also when it fails.
    struct Cleanup(Terms);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.0.kill_all(procs::GRACE_ON_EXIT);
        }
    }

    fn gone(terms: &Terms, id: u32) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < Duration::from_secs(10) {
            if terms.info(id).is_err() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn runs_a_program_and_reports_output_and_exit_code() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let rec = Recorder::default();
        let info = spawn(&terms, shell("echo hello-pty&& exit 3"), &rec);
        assert!(info.pid.is_some());
        assert_eq!(info.title, "New session");
        assert_eq!(terms.list().len(), 1);
        assert!(rec.wait(15, |r| r.exit().is_some()), "no exit; output: {}", rec.text());
        assert!(rec.text().contains("hello-pty"), "output: {}", rec.text());
        assert_eq!(rec.exit(), Some(Some(3)));
        assert!(!rec.late(), "output after the exit message");
        assert!(gone(&terms, info.id), "the exited terminal stayed listed");
        assert_eq!(terms.list(), []);
        assert_eq!(terms.running_pids(), Vec::<u32>::new());
        // closing an exited tab later is fine
        terms.kill(info.id);
    }

    #[test]
    fn input_reaches_the_program_in_order() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let rec = Recorder::default();
        let info = spawn(&terms, interactive_shell(), &rec);
        let (probe, expect) = if cfg!(windows) {
            ("echo got-%OS%\r", "got-Windows_NT")
        } else {
            ("echo got-$((2+3))\n", "got-5")
        };
        terms.write(info.id, probe.as_bytes().to_vec()).unwrap();
        assert!(rec.wait(15, |r| r.text().contains(expect)), "output: {}", rec.text());
        let exit = if cfg!(windows) { "exit 5\r" } else { "exit 5\n" };
        for b in exit.bytes() {
            terms.write(info.id, vec![b]).unwrap();
        }
        assert!(rec.wait(15, |r| r.exit().is_some()), "no exit; output: {}", rec.text());
        assert_eq!(rec.exit(), Some(Some(5)));
        assert!(gone(&terms, info.id));
        assert!(matches!(
            terms.write(info.id, b"x".to_vec()),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn kill_ends_the_program_and_its_children() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let rec = Recorder::default();
        let script = if cfg!(windows) {
            "ping -n 60 127.0.0.1 >NUL"
        } else {
            "sleep 60; true"
        };
        let info = spawn(&terms, shell(script), &rec);
        let pid = info.pid.unwrap();
        let procs = procs::Procs::new();
        let start = std::time::Instant::now();
        while procs.descendants_of(pid).is_empty() && start.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let tree = procs.descendants_of(pid);
        assert!(!tree.is_empty(), "the child never started its own child");
        assert_eq!(terms.running_pids(), [pid]);
        terms.kill(info.id);
        assert_eq!(terms.list(), []);
        assert!(rec.wait(15, |r| r.exit().is_some()), "no exit after kill");
        assert!(
            rec.wait(10, |_| tree.iter().chain([&pid]).all(|&p| !procs.alive(p))),
            "a process survived"
        );
    }

    #[test]
    fn attach_moves_output_to_the_new_window_and_resize_works() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let first = Recorder::default();
        let info = spawn(&terms, interactive_shell(), &first);
        let second = Recorder::default();
        let attached = terms.attach(info.id, second.sink(), "term-1").unwrap();
        assert_eq!(attached.window.as_deref(), Some("term-1"));
        terms.resize(info.id, 120, 40).unwrap();
        terms.set_title(info.id, "Fixing tests").unwrap();
        assert_eq!(terms.info(info.id).unwrap().title, "Fixing tests");
        let probe = if cfg!(windows) {
            "echo attached-%OS%\r"
        } else {
            "echo attached-$((1+1))\n"
        };
        terms.write(info.id, probe.as_bytes().to_vec()).unwrap();
        let expect = if cfg!(windows) {
            "attached-Windows_NT"
        } else {
            "attached-2"
        };
        assert!(
            second.wait(15, |r| r.text().contains(expect)),
            "output: {}",
            second.text()
        );
        assert!(!first.text().contains(expect));
        terms.kill(info.id);
        assert!(second.wait(15, |r| r.exit().is_some()));
        assert!(matches!(terms.resize(info.id, 80, 24), Err(AppError::NotFound(_))));
    }

    #[test]
    fn kill_all_empties_the_map() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let script = if cfg!(windows) {
            "ping -n 60 127.0.0.1 >NUL"
        } else {
            "sleep 60"
        };
        for _ in 0..2 {
            spawn(&terms, shell(script), &Recorder::default());
        }
        assert_eq!(terms.live_count(), 2);
        terms.kill_all(procs::GRACE_ON_EXIT);
        assert_eq!(terms.live_count(), 0);
    }

    #[test]
    fn windows_hand_over_and_end_their_terminals() {
        let terms = Terms::default();
        let _cleanup = Cleanup(terms.clone());
        let script = if cfg!(windows) {
            "ping -n 60 127.0.0.1 >NUL"
        } else {
            "sleep 60"
        };
        let a = spawn(&terms, shell(script), &Recorder::default());
        let b = spawn(&terms, shell(script), &Recorder::default());
        terms.set_window(b.id, "win-2").unwrap();
        assert_eq!((terms.live_in("main"), terms.live_in("win-2")), (1, 1));
        assert_eq!(terms.of_pids(&[b.pid.unwrap()]), Some((b.id, "win-2".to_string())));
        // into the main window: only what is elsewhere moves
        assert_eq!(terms.hand_over(None, "main"), vec![b.id]);
        assert_eq!(terms.ids_in("main"), vec![a.id, b.id]);
        assert_eq!(terms.hand_over(Some("main"), "win-3"), vec![a.id, b.id]);
        terms.end_in("win-3");
        assert_eq!(terms.live_count(), 0);
    }
}
