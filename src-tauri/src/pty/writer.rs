//! Keystrokes and pastes to a terminal. Each terminal has its own writer thread, fed in order through a
//! channel: `pty_write` only queues, so a child that stops reading its input (a 5 MB paste, a hung
//! program) blocks that thread and nothing else.

use std::io::Write;
use std::sync::mpsc::{Sender, channel};

/// Starts the writer thread for `out`. It ends when the returned sender is dropped (after the write in
/// progress) or when the PTY stops accepting input.
pub fn spawn(id: u32, mut out: Box<dyn Write + Send>) -> std::io::Result<Sender<Vec<u8>>> {
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::Builder::new()
        .name(format!("pty-{id}-write"))
        .spawn(move || {
            for chunk in rx {
                if let Err(e) = out.write_all(&chunk).and_then(|()| out.flush()) {
                    log::info!("terminal {id} no longer takes input: {e}");
                    break;
                }
            }
        })?;
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn writes_chunks_in_order() {
        let sink = Shared::default();
        let tx = spawn(1, Box::new(sink.clone())).unwrap();
        for part in ["a", "bc", "def"] {
            tx.send(part.as_bytes().to_vec()).unwrap();
        }
        drop(tx);
        let start = std::time::Instant::now();
        while sink.0.lock().unwrap().len() < 6 && start.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(&*sink.0.lock().unwrap(), b"abcdef");
    }
}
