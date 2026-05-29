#[derive(Clone, Default)]
pub(crate) struct PositionalParams {
    frames: Vec<Vec<String>>,
}

impl PositionalParams {
    pub fn new() -> Self {
        Self { frames: vec![vec![]] }
    }

    pub fn push_frame(&mut self, args: Vec<String>) {
        self.frames.push(args);
    }

    pub fn pop_frame(&mut self) {
        if self.frames.len() > 1 {
            self.frames.pop();
        }
    }

    pub fn current(&self) -> &[String] {
        self.frames.last().map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Get positional param by 1-based index ($1 = index 1)
    pub fn get(&self, n: usize) -> Option<&str> {
        if n == 0 { return None; }
        self.current().get(n - 1).map(|s| s.as_str())
    }

    pub fn count(&self) -> usize {
        self.current().len()
    }

    pub fn all(&self) -> &[String] {
        self.current()
    }

    pub fn shift(&mut self, n: usize) {
        if let Some(frame) = self.frames.last_mut() {
            let drain = n.min(frame.len());
            frame.drain(..drain);
        }
    }
}
