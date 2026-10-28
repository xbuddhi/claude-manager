//! Terminal output. A reader thread drains the PTY; a pump thread batches what it read (up to 8 ms or
//! 64 KB), sends it as raw bytes to the attached window, and keeps the last 256 KB for a window that
//! attaches later. Output (raw bytes) and the exit message (JSON `PtyExit`, sent last) share one channel,
//! whose messages the webview receives in order.
//!
//! Flow control: the frontend pauses a terminal while xterm has too much unparsed output. The pump then
//! stops, the small queue to it fills, the reader stops reading, and the child blocks on its next write.
//!
//! The reader never stops before the PTY closes, even when nobody listens: on Windows 10 an undrained
//! ConPTY can make closing it hang.

use super::ring::{RING_BYTES, Ring};
use super::types::PtyExit;
use crate::core::error::lock;
use std::io::{ErrorKind, Read};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};

/// How long output is collected before it is sent, and the most sent at once.
const COALESCE: Duration = Duration::from_millis(8);
const BATCH_BYTES: usize = 64 * 1024;
/// Chunks queued between the reader and the pump (each at most one read).
const QUEUE: usize = 16;
/// How often the pump looks again while it waits out the exit grace or for the exit.
const IDLE: Duration = Duration::from_millis(50);
/// How long the exit message waits for the PTY to close after the child exited. A process the child left
/// behind can hold it open; its output after that is drained but not shown.
const EXIT_GRACE: Duration = Duration::from_millis(500);

/// Where a terminal's output goes: the channel of the window showing it.
pub type Sink = Channel<InvokeResponseBody>;

fn exit_message(exit: &PtyExit) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(exit).unwrap_or_else(|_| r#"{"code":null}"#.into()))
}

pub struct Output {
    state: Mutex<State>,
    changed: Condvar,
}

struct State {
    sink: Sink,
    ring: Ring,
    paused: bool,
    /// Sequence number of the last pause/resume applied. The two commands can reach Rust out of order (they
    /// run concurrently); a late "pause" after its "resume" would otherwise stop the output for good.
    flow_seq: u64,
    /// The terminal was removed: never wait for a resume again.
    closing: bool,
    exit: Option<PtyExit>,
    exit_sent: bool,
    send_failed: bool,
    /// A sender into the pump's queue. The idle pump blocks on the queue, so the exit sends an empty chunk
    /// to wake it; then this is dropped, so the queue closes once the reader ends too.
    wake: Option<SyncSender<Vec<u8>>>,
}

impl Output {
    pub fn new(sink: Sink) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                sink,
                ring: Ring::new(RING_BYTES),
                paused: false,
                flow_seq: 0,
                closing: false,
                exit: None,
                exit_sent: false,
                send_failed: false,
                wake: None,
            }),
            changed: Condvar::new(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// Sends the output from now on to `sink`, after replaying the kept output to it. Nothing is lost or
    /// sent twice in between: the pump sends under the same lock.
    pub fn attach(&self, sink: Sink) {
        let mut st = self.state();
        let replay = st.ring.contents();
        if !replay.is_empty() {
            let _ = sink.send(InvokeResponseBody::Raw(replay));
        }
        if st.exit_sent
            && let Some(exit) = &st.exit
        {
            let _ = sink.send(exit_message(exit));
        }
        st.sink = sink;
        // the new window starts with nothing unparsed
        st.paused = false;
        st.flow_seq = 0;
        st.send_failed = false;
        self.changed.notify_all();
    }

    /// Applies a pause or resume unless a newer one (higher `seq`) was applied already.
    pub fn set_paused(&self, paused: bool, seq: u64) {
        let mut st = self.state();
        if seq < st.flow_seq {
            return;
        }
        st.flow_seq = seq;
        st.paused = paused;
        drop(st);
        self.changed.notify_all();
    }

    /// The terminal is going away: the pump finishes without waiting for a resume.
    pub fn close(&self) {
        let mut st = self.state();
        st.closing = true;
        st.wake = None;
        drop(st);
        self.changed.notify_all();
    }

    /// Keeps `tx` to wake the pump with when the exit comes.
    fn set_wake(&self, tx: SyncSender<Vec<u8>>) {
        let mut st = self.state();
        if !st.closing {
            st.wake = Some(tx);
        }
    }

    /// Called by the waiter once the child has exited.
    pub fn set_exit(&self, code: Option<u32>) {
        let mut st = self.state();
        st.exit = Some(PtyExit { code });
        st.closing = true;
        // a full queue needs no wake-up: the pump is not waiting on it
        if let Some(wake) = st.wake.take() {
            let _ = wake.try_send(Vec::new());
        }
        drop(st);
        self.changed.notify_all();
    }

    fn send_data(&self, bytes: Vec<u8>) {
        let mut st = self.state();
        st.ring.push(&bytes);
        if let Err(e) = st.sink.send(InvokeResponseBody::Raw(bytes))
            && !st.send_failed
        {
            st.send_failed = true;
            log::info!("terminal output has no listener: {e}");
        }
    }

    fn send_exit(&self) {
        let mut st = self.state();
        let exit = st.exit.clone().unwrap_or(PtyExit { code: None });
        let _ = st.sink.send(exit_message(&exit));
        st.exit_sent = true;
    }

    fn exited(&self) -> bool {
        self.state().exit.is_some()
    }

    fn wait_while_paused(&self) {
        let st = self.state();
        let _st = self
            .changed
            .wait_while(st, |s| s.paused && !s.closing)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }

    fn wait_exit(&self, timeout: Duration) {
        let st = self.state();
        let _st = self
            .changed
            .wait_timeout_while(st, timeout, |s| s.exit.is_none())
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

/// Starts the reader and pump threads of terminal `id`.
pub fn start(id: u32, reader: Box<dyn Read + Send>, out: Arc<Output>) -> std::io::Result<()> {
    let (tx, rx) = sync_channel(QUEUE);
    out.set_wake(tx.clone());
    std::thread::Builder::new()
        .name(format!("pty-{id}-pump"))
        .spawn(move || pump(rx, out))?;
    std::thread::Builder::new()
        .name(format!("pty-{id}-read"))
        .spawn(move || read_loop(reader, tx))?;
    Ok(())
}

fn read_loop(mut reader: Box<dyn Read + Send>, tx: SyncSender<Vec<u8>>) {
    let mut buf = vec![0u8; 64 * 1024];
    let mut forwarding = true;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                // the pump is gone (exit reported): keep reading and dropping until the PTY closes
                if forwarding && tx.send(buf[..n].to_vec()).is_err() {
                    forwarding = false;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
}

fn pump(rx: Receiver<Vec<u8>>, out: Arc<Output>) {
    let mut pending: Vec<u8> = Vec::with_capacity(BATCH_BYTES);
    let mut first = Instant::now();
    let mut eof = false;
    let mut exited_at: Option<Instant> = None;
    loop {
        out.wait_while_paused();
        if !eof {
            let got = if pending.is_empty() && exited_at.is_none() && !out.exited() {
                // idle: sleep until output comes, the PTY closes, or the exit wakes this up
                rx.recv().map_err(|_| RecvTimeoutError::Disconnected)
            } else if pending.is_empty() {
                rx.recv_timeout(IDLE)
            } else {
                rx.recv_timeout(COALESCE.saturating_sub(first.elapsed()))
            };
            match got {
                Ok(chunk) if chunk.is_empty() => {} // the exit's wake-up
                Ok(chunk) => {
                    if pending.is_empty() {
                        first = Instant::now();
                        if chunk.len() >= BATCH_BYTES {
                            // a full batch on its own: sent as it is, not copied
                            pending = chunk;
                        } else {
                            pending.extend_from_slice(&chunk);
                        }
                    } else {
                        pending.extend_from_slice(&chunk);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => eof = true,
            }
        }
        if !pending.is_empty() && (eof || pending.len() >= BATCH_BYTES || first.elapsed() >= COALESCE) {
            out.send_data(std::mem::replace(&mut pending, Vec::with_capacity(BATCH_BYTES)));
        }
        if out.exited() {
            let at = *exited_at.get_or_insert_with(Instant::now);
            if eof || at.elapsed() >= EXIT_GRACE {
                if !pending.is_empty() {
                    out.send_data(std::mem::take(&mut pending));
                }
                out.send_exit();
                return;
            }
        } else if eof {
            // the PTY closed; the waiter reports the exit at any moment
            out.wait_exit(IDLE);
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A channel that records what it receives.
    #[derive(Clone, Default)]
    pub struct Recorder {
        pub data: Arc<Mutex<Vec<u8>>>,
        pub exits: Arc<Mutex<Vec<Option<u32>>>>,
        pub late: Arc<Mutex<bool>>,
    }

    impl Recorder {
        pub fn sink(&self) -> Sink {
            let (data, exits, late) = (self.data.clone(), self.exits.clone(), self.late.clone());
            Channel::new(move |body| {
                match body {
                    InvokeResponseBody::Raw(b) => {
                        // nothing may follow the exit message
                        if !lock(&exits).is_empty() {
                            *lock(&late) = true;
                        }
                        lock(&data).extend_from_slice(&b);
                    }
                    InvokeResponseBody::Json(s) => {
                        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
                        lock(&exits).push(v["code"].as_u64().map(|c| c as u32));
                    }
                }
                Ok(())
            })
        }

        /// Output arrived after the exit message.
        pub fn late(&self) -> bool {
            *lock(&self.late)
        }

        pub fn text(&self) -> String {
            String::from_utf8_lossy(&lock(&self.data)).into_owned()
        }

        pub fn exit(&self) -> Option<Option<u32>> {
            lock(&self.exits).first().copied()
        }

        /// Waits up to `secs` for `cond`.
        pub fn wait(&self, secs: u64, cond: impl Fn(&Self) -> bool) -> bool {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(secs) {
                if cond(self) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            cond(self)
        }
    }

    fn pumped() -> (SyncSender<Vec<u8>>, Arc<Output>, Recorder) {
        let rec = Recorder::default();
        let out = Output::new(rec.sink());
        let (tx, rx) = sync_channel(QUEUE);
        out.set_wake(tx.clone());
        let o = out.clone();
        std::thread::spawn(move || pump(rx, o));
        (tx, out, rec)
    }

    #[test]
    fn sends_output_then_the_exit() {
        let (tx, out, rec) = pumped();
        tx.send(b"hello ".to_vec()).unwrap();
        tx.send(b"world".to_vec()).unwrap();
        assert!(rec.wait(5, |r| r.text() == "hello world"));
        assert_eq!(rec.exit(), None);
        out.set_exit(Some(3));
        drop(tx);
        assert!(rec.wait(5, |r| r.exit() == Some(Some(3))));
    }

    #[test]
    fn exit_is_reported_even_while_the_pty_stays_open() {
        let (tx, out, rec) = pumped();
        out.set_exit(Some(0));
        assert!(rec.wait(5, |r| r.exit() == Some(Some(0))));
        drop(tx);
    }

    #[test]
    fn pause_holds_output_until_resumed() {
        let (tx, out, rec) = pumped();
        out.set_paused(true, 1);
        std::thread::sleep(Duration::from_millis(60)); // let the pump reach the pause
        tx.send(b"later".to_vec()).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(rec.text(), "");
        out.set_paused(false, 2);
        assert!(rec.wait(5, |r| r.text() == "later"));
        drop(tx);
        out.close();
    }

    #[test]
    fn a_late_pause_after_its_resume_is_ignored() {
        let (tx, out, rec) = pumped();
        // resume (seq 2) arrives before the pause it answers (seq 1)
        out.set_paused(false, 2);
        out.set_paused(true, 1);
        tx.send(b"still flowing".to_vec()).unwrap();
        assert!(rec.wait(5, |r| r.text() == "still flowing"));
        drop(tx);
        out.close();
    }

    #[test]
    fn attaching_replays_kept_output_once() {
        let (tx, out, first) = pumped();
        tx.send(b"line one\r\n".to_vec()).unwrap();
        assert!(first.wait(5, |r| r.text() == "line one\r\n"));
        let second = Recorder::default();
        out.attach(second.sink());
        tx.send(b"two".to_vec()).unwrap();
        assert!(second.wait(5, |r| r.text() == "line one\r\ntwo"));
        assert_eq!(first.text(), "line one\r\n");
        drop(tx);
        out.close();
    }

    #[test]
    fn idle_pump_sleeps_until_output_or_the_exit() {
        let (tx, out, rec) = pumped();
        std::thread::sleep(Duration::from_millis(100)); // the pump is blocked on the queue now
        tx.send(b"a".to_vec()).unwrap();
        assert!(rec.wait(5, |r| r.text() == "a"));
        std::thread::sleep(Duration::from_millis(100));
        // the PTY stays open (tx kept): the exit alone wakes the pump
        let started = Instant::now();
        out.set_exit(Some(1));
        assert!(rec.wait(5, |r| r.exit() == Some(Some(1))));
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(!rec.late());
        drop(tx);
    }

    #[test]
    fn sends_a_large_chunk_whole() {
        let (tx, out, rec) = pumped();
        let big = vec![b'x'; BATCH_BYTES + 10];
        tx.send(big.clone()).unwrap();
        tx.send(b"y".to_vec()).unwrap();
        assert!(rec.wait(5, |r| lock(&r.data).len() == big.len() + 1));
        assert!(rec.text().ends_with("xy"));
        out.set_exit(None);
        drop(tx);
        assert!(rec.wait(5, |r| r.exit() == Some(None)));
    }

    #[test]
    fn the_queue_closes_after_close_once_the_reader_ends() {
        let (tx, out, rec) = pumped();
        out.close();
        drop(tx);
        // eof first; the exit still comes and ends the pump
        std::thread::sleep(Duration::from_millis(100));
        out.set_exit(Some(0));
        assert!(rec.wait(5, |r| r.exit() == Some(Some(0))));
    }
}
