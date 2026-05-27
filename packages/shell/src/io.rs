use crate::bindings::wasi::cli::{stdin, stdout, stderr};
use crate::bindings::wasi::io::streams::StreamError;

const READ_CHUNK: u64 = 1024;

/// Buffered stdin reader that carries over bytes past the last newline.
pub struct LineReader {
    buf: Vec<u8>,
    closed: bool,
}

impl LineReader {
    pub fn new() -> Self {
        LineReader { buf: Vec::new(), closed: false }
    }

    /// Return the next complete line (including `\n`), or `None` on EOF.
    /// Blocks until data arrives or stream closes.
    pub fn read_line(&mut self) -> Option<String> {
        if self.closed && self.buf.is_empty() {
            return None;
        }

        let stream = stdin::get_stdin();

        loop {
            // Check if we already have a complete line buffered.
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line = self.buf.drain(..=pos).collect::<Vec<u8>>();
                return Some(String::from_utf8_lossy(&line).into_owned());
            }

            if self.closed {
                // No newline, but stream is done — return whatever remains.
                if self.buf.is_empty() {
                    return None;
                }
                let line = std::mem::take(&mut self.buf);
                return Some(String::from_utf8_lossy(&line).into_owned());
            }

            match stream.blocking_read(READ_CHUNK) {
                Ok(bytes) if bytes.is_empty() => {
                    // EOF signal from blocking_read returning empty
                    self.closed = true;
                }
                Ok(bytes) => {
                    self.buf.extend_from_slice(&bytes);
                }
                Err(StreamError::Closed) => {
                    self.closed = true;
                }
                Err(_) => {
                    self.closed = true;
                }
            }
        }
    }
}

pub fn write_stdout(s: &str) {
    let stream = stdout::get_stdout();
    let bytes = s.as_bytes();
    if !bytes.is_empty() {
        let _ = stream.blocking_write_and_flush(bytes);
    }
}

pub fn write_stderr(s: &str) {
    let stream = stderr::get_stderr();
    let bytes = s.as_bytes();
    if !bytes.is_empty() {
        let _ = stream.blocking_write_and_flush(bytes);
    }
}
