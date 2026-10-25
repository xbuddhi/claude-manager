//! The most recent output of a terminal, replayed when another window attaches to it (pop-out, page reload).

use std::collections::VecDeque;

/// Output kept per terminal.
pub const RING_BYTES: usize = 256 * 1024;

pub struct Ring {
    buf: VecDeque<u8>,
    cap: usize,
    /// Older bytes were dropped, so the buffer may start inside a character or an escape sequence.
    wrapped: bool,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap.min(64 * 1024)),
            cap,
            wrapped: false,
        }
    }

    pub fn push(&mut self, data: &[u8]) {
        if data.len() > self.cap {
            self.wrapped = true;
        }
        let data = &data[data.len().saturating_sub(self.cap)..];
        let overflow = (self.buf.len() + data.len()).saturating_sub(self.cap);
        if overflow > 0 {
            self.buf.drain(..overflow);
            self.wrapped = true;
        }
        self.buf.extend(data);
    }

    /// The kept output. Once older output was dropped it starts at the first line break, so the replay
    /// never begins in the middle of a character or an escape sequence.
    pub fn contents(&self) -> Vec<u8> {
        let skip = if self.wrapped {
            self.buf
                .iter()
                .position(|&b| b == b'\n')
                .map_or(self.buf.len(), |i| i + 1)
        } else {
            0
        };
        self.buf.iter().skip(skip).copied().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_everything_until_full() {
        let mut r = Ring::new(16);
        r.push(b"hello ");
        r.push(b"world");
        assert_eq!(r.contents(), b"hello world");
    }

    #[test]
    fn drops_the_oldest_bytes_and_starts_on_a_new_line() {
        let mut r = Ring::new(16);
        r.push(b"aaaa\nbbbb\ncccc\n");
        r.push(b"dddd");
        // kept: "a\nbbbb\ncccc\ndddd" -> replay starts after the first line break
        assert_eq!(r.contents(), b"bbbb\ncccc\ndddd");
    }

    #[test]
    fn a_chunk_larger_than_the_ring_keeps_its_tail() {
        let mut r = Ring::new(8);
        r.push(b"0123456789\nabcdefgh");
        assert_eq!(r.buf.len(), 8);
        // no line break in what is left: nothing safe to replay
        assert_eq!(r.contents(), b"");
        r.push(b"\nxy");
        assert_eq!(r.contents(), b"xy");
    }
}
