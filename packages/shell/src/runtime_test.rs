#[cfg(test)]
use crate::runtime::*;
use std::cell::RefCell;
use std::collections::HashMap;

/// Test runtime with output capture and mock filesystem.
pub(crate) struct TestRuntime {
    pub stdout: RefCell<String>,
    pub stderr: RefCell<String>,
    pub input_lines: RefCell<Vec<String>>,
    pub fs_entries: HashMap<String, Vec<String>>,
    pub fs_files: HashMap<String, Vec<u8>>,
}

impl TestRuntime {
    pub fn new() -> Self {
        Self {
            stdout: RefCell::new(String::new()),
            stderr: RefCell::new(String::new()),
            input_lines: RefCell::new(Vec::new()),
            fs_entries: HashMap::new(),
            fs_files: HashMap::new(),
        }
    }
}

impl Io for TestRuntime {
    fn write_stdout(&self, data: &str) {
        self.stdout.borrow_mut().push_str(data);
    }

    fn write_stderr(&self, data: &str) {
        self.stderr.borrow_mut().push_str(data);
    }

    fn read_line(&mut self) -> Option<String> {
        let mut lines = self.input_lines.borrow_mut();
        if lines.is_empty() {
            None
        } else {
            Some(lines.remove(0))
        }
    }
}

impl Filesystem for TestRuntime {
    fn open_file_write(&mut self, _path: &str, _append: bool) -> Option<OutputHandle> {
        None
    }

    fn open_file_read(&mut self, _path: &str) -> Option<InputHandle> {
        None
    }

    fn read_directory(&self, path: &str) -> Vec<String> {
        self.fs_entries.get(path).cloned().unwrap_or_default()
    }

    fn file_exists(&self, path: &str) -> bool {
        self.fs_files.contains_key(path) || self.fs_entries.contains_key(path)
    }

    fn file_type(&self, path: &str) -> FileType {
        if self.fs_files.contains_key(path) {
            FileType::Regular
        } else if self.fs_entries.contains_key(path) {
            FileType::Directory
        } else {
            FileType::NotFound
        }
    }

    fn unlink(&self, _path: &str) {}

    fn mkdir(&self, _path: &str) {}

    fn write_file(&self, _path: &str, _data: &[u8]) {}

    fn read_file(&self, path: &str) -> Vec<u8> {
        self.fs_files.get(path).cloned().unwrap_or_default()
    }
}

impl ProcessMgr for TestRuntime {
    fn create_pipe(&mut self) -> (InputHandle, OutputHandle) {
        (InputHandle(0), OutputHandle(0))
    }

    fn dup_output(&mut self, _handle: &OutputHandle) -> OutputHandle {
        OutputHandle(0)
    }

    fn spawn(&mut self, _cmd: &str, _args: &[String], _opts: SpawnOpts) -> Result<ProcessHandle, SpawnError> {
        Err(SpawnError)
    }

    fn pipe_read_all(&mut self, _handle: InputHandle) -> Vec<u8> {
        vec![]
    }

    fn pipe_write(&mut self, _handle: &OutputHandle, _data: &[u8]) {}

    fn pipe_close_write(&mut self, _handle: OutputHandle) {}

    fn wait(&mut self, _handle: &ProcessHandle) -> u8 {
        0
    }

    fn try_wait(&self, _handle: &ProcessHandle) -> Option<u8> {
        Some(0)
    }

    fn kill(&self, _handle: &ProcessHandle, _signal: Signal) -> Result<(), ()> {
        Ok(())
    }

    fn pid(&self, _handle: &ProcessHandle) -> u32 {
        0
    }
}
