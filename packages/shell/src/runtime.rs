// Opaque handles — the runtime maps these to internal resources
pub(crate) struct InputHandle(pub(crate) u32);
pub(crate) struct OutputHandle(pub(crate) u32);
pub(crate) struct ProcessHandle(pub(crate) u32);

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum FileType { Regular, Directory, Other, NotFound }

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Signal { Term, Kill, Int, Tstp, Cont, Null }

pub(crate) struct SpawnOpts {
    pub env: Option<Vec<(String, String)>>,
    pub stdin: Option<InputHandle>,
    pub stdout: Option<OutputHandle>,
    pub stderr: Option<OutputHandle>,
}

pub(crate) struct SpawnError;

// Sub-trait 1: I/O (backed by std::io in production)
pub(crate) trait Io {
    fn write_stdout(&self, data: &str);
    fn write_stderr(&self, data: &str);
    fn read_line(&mut self) -> Option<String>;
}

// Sub-trait 2: Filesystem
// Methods producing handles MUST use raw WASI (stream resources for spawn).
// Read-only query methods use std::fs on WasiRuntime.
pub(crate) trait Filesystem {
    /// Open file for writing, return stream handle for spawn. Uses raw WASI binding.
    fn open_file_write(&mut self, path: &str, append: bool) -> Option<OutputHandle>;
    /// Open file for reading, return stream handle for spawn. Uses raw WASI binding.
    fn open_file_read(&mut self, path: &str) -> Option<InputHandle>;
    /// List directory entries (for glob). Uses std::fs on WasiRuntime.
    fn read_directory(&self, path: &str) -> Vec<String>;
    fn file_exists(&self, path: &str) -> bool;
    fn file_type(&self, path: &str) -> FileType;
    fn unlink(&self, path: &str);
    fn mkdir(&self, path: &str);
    fn write_file(&self, path: &str, data: &[u8]);
    fn read_file(&self, path: &str) -> Vec<u8>;
}

// Sub-trait 3: Process management (mithic:process WIT — no std equivalent)
pub(crate) trait ProcessMgr {
    fn create_pipe(&mut self) -> (InputHandle, OutputHandle);
    fn dup_output(&mut self, handle: &OutputHandle) -> OutputHandle;
    fn spawn(&mut self, cmd: &str, args: &[String], opts: SpawnOpts) -> Result<ProcessHandle, SpawnError>;
    fn pipe_read_all(&mut self, handle: InputHandle) -> Vec<u8>;
    /// Read a single line (up to `\n`) from a pipe input handle. Returns None on EOF.
    fn pipe_read_line(&mut self, handle: &InputHandle) -> Option<String>;
    fn pipe_write(&mut self, handle: &OutputHandle, data: &[u8]);
    fn pipe_close_write(&mut self, handle: OutputHandle);
    fn wait(&mut self, handle: &ProcessHandle) -> u8;
    fn try_wait(&self, handle: &ProcessHandle) -> Option<u8>;
    fn kill(&self, handle: &ProcessHandle, signal: Signal) -> Result<(), ()>;
    fn pid(&self, handle: &ProcessHandle) -> u32;
}

// Supertrait: blanket implementation
pub(crate) trait Runtime: Io + Filesystem + ProcessMgr {}
impl<T: Io + Filesystem + ProcessMgr> Runtime for T {}
