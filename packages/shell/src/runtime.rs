// Opaque handles — the runtime maps these to internal resources
#[derive(Clone, Copy)]
pub struct InputHandle(pub u32);
#[derive(Clone, Copy)]
pub struct OutputHandle(pub u32);
#[derive(Clone, Copy)]
pub struct ProcessHandle(pub u32);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FileType { Regular, Directory, Other, NotFound }

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Signal { Term, Kill, Int, Tstp, Cont, Null }

pub struct SpawnOpts {
    pub env: Option<Vec<(String, String)>>,
    pub stdin: Option<InputHandle>,
    pub stdout: Option<OutputHandle>,
    pub stderr: Option<OutputHandle>,
}

pub struct SpawnError;

// Sub-trait 1: I/O (backed by std::io in production)
pub trait Io {
    fn write_stdout(&self, data: &str);
    fn write_stderr(&self, data: &str);
    fn read_line(&mut self) -> Option<String>;
}

// Sub-trait 2: Filesystem
// Methods producing handles MUST use raw WASI (stream resources for spawn).
// Read-only query methods use std::fs on WasiRuntime.
pub trait Filesystem {
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
pub trait ProcessMgr {
    fn create_pipe(&mut self) -> (InputHandle, OutputHandle);
    fn dup_output(&mut self, handle: &OutputHandle) -> OutputHandle;
    fn spawn(&mut self, cmd: &str, args: &[String], opts: SpawnOpts) -> Result<ProcessHandle, SpawnError>;
    fn pipe_read_all(&mut self, handle: InputHandle) -> Vec<u8>;
    /// Read a single line (up to `\n`) from a pipe input handle. Returns None on EOF.
    fn pipe_read_line(&mut self, handle: &InputHandle) -> Option<String>;
    fn pipe_write(&mut self, handle: &OutputHandle, data: &[u8]);
    fn pipe_close_write(&mut self, handle: OutputHandle);
    fn pipe_close_read(&mut self, handle: InputHandle);
    fn wait(&mut self, handle: &ProcessHandle) -> u8;
    fn try_wait(&self, handle: &ProcessHandle) -> Option<u8>;
    fn kill(&self, handle: &ProcessHandle, signal: Signal) -> Result<(), ()>;
    fn pid(&self, handle: &ProcessHandle) -> u32;
}

// Supertrait: blanket implementation
pub trait Runtime: Io + Filesystem + ProcessMgr {}
impl<T: Io + Filesystem + ProcessMgr> Runtime for T {}
