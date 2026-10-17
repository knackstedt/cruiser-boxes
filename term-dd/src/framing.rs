//! framing.rs — length-prefixed frame codec shared semantics with
//! libraries/app-shell/src/term/framing.ts (keep the tag numbers in sync).
//!
//! Wire format (both directions):  [u32 LE len][u8 tag][payload]
//!
//!   host → term-dd:  0x01 DATA   raw bytes written to the PTY
//!                    0x02 RESIZE u16le cols ++ u16le rows
//!                    0x03 KILL   kill the spawned child
//!
//!   term-dd → host:  0x01 DATA   raw bytes read from the PTY
//!                    0x02 EXIT   i32le exit status
//!                    0x03 ERR    utf8 error message (spawn failures)

use std::io::{Result as IoResult, Write};

pub const TAG_DATA: u8 = 0x01;
pub const TAG_RESIZE: u8 = 0x02; // host→child: resize; child→host: exit
pub const TAG_KILL: u8 = 0x03; // host→child: kill;   child→host: error

/// Write one framed message to `w`.
pub fn write_frame(w: &mut impl Write, tag: u8, payload: &[u8]) -> IoResult<()> {
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(&[tag])?;
    w.write_all(payload)
}

/// Incremental decoder — buffers partial frames across reads. Consumed
/// bytes are tracked by a cursor and compacted lazily: drain-per-frame is
/// O(remaining) each time, which goes quadratic on a read full of frames.
#[derive(Default)]
pub struct Decoder {
    buf: Vec<u8>,
    start: usize,
}

impl Decoder {
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(8192), start: 0 }
    }

    /// Feed bytes; returns each complete frame as (tag, payload).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(u8, Vec<u8>)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let avail = self.buf.len() - self.start;
            if avail < 5 {
                break;
            }
            let i = self.start;
            let len = u32::from_le_bytes([self.buf[i], self.buf[i + 1], self.buf[i + 2], self.buf[i + 3]]) as usize;
            if avail < 5 + len {
                break;
            }
            out.push((self.buf[i + 4], self.buf[i + 5..i + 5 + len].to_vec()));
            self.start = i + 5 + len;
        }
        // Compact the dead prefix only when it's all dead or large — keeps
        // push() amortized O(chunk) instead of O(frames × buf).
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 64 * 1024 {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut buf = Vec::new();
        write_frame(&mut buf, TAG_DATA, b"hello").unwrap();
        write_frame(&mut buf, TAG_RESIZE, &[80, 0, 24, 0]).unwrap();
        let mut dec = Decoder::new();
        let frames = dec.push(&buf);
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0], (TAG_DATA, b"hello".to_vec()));
        assert_eq!(frames[1], (TAG_RESIZE, vec![80, 0, 24, 0]));
    }

    #[test]
    fn split_writes() {
        let mut buf = Vec::new();
        write_frame(&mut buf, TAG_DATA, b"abcdef").unwrap();
        let mut dec = Decoder::new();
        assert!(dec.push(&buf[..3]).is_empty()); // partial header
        assert!(dec.push(&buf[3..7]).is_empty()); // tag + partial payload
        let frames = dec.push(&buf[7..]);
        assert_eq!(frames, vec![(TAG_DATA, b"abcdef".to_vec())]);
    }

    #[test]
    fn empty_payload() {
        let mut buf = Vec::new();
        write_frame(&mut buf, TAG_KILL, &[]).unwrap();
        let mut dec = Decoder::new();
        let frames = dec.push(&buf);
        assert_eq!(frames, vec![(TAG_KILL, Vec::new())]);
    }
}
