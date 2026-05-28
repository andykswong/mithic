use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{
    InputStream, OutputStream, Process, SpawnOptions, Signal as WasiSignal,
};
use crate::bindings::wasi::cli::{stdin, stdout, stderr};
use crate::bindings::wasi::filesystem::types::{
    Descriptor, DescriptorFlags, OpenFlags, PathFlags,
};
use crate::bindings::wasi::filesystem::preopens;
use crate::bindings::wasi::io::streams::StreamError;
use crate::runtime::{
    FileType, InputHandle, Io, Filesystem, OutputHandle, ProcessHandle,
    ProcessMgr, Signal, SpawnError, SpawnOpts,
};

const READ_CHUNK: u64 = 1024;

struct LineReader {
    buf: Vec<u8>,
    closed: bool,
}

impl LineReader {
    fn new() -> Self {
        LineReader { buf: Vec::new(), closed: false }
    }

    fn read_line(&mut self) -> Option<String> {
        if self.closed && self.buf.is_empty() {
            return None;
        }

        let stream = stdin::get_stdin();

        loop {
            if let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
                let line = self.buf.drain(..=pos).collect::<Vec<u8>>();
                return Some(String::from_utf8_lossy(&line).into_owned());
            }

            if self.closed {
                if self.buf.is_empty() {
                    return None;
                }
                let line = std::mem::take(&mut self.buf);
                return Some(String::from_utf8_lossy(&line).into_owned());
            }

            match stream.blocking_read(READ_CHUNK) {
                Ok(bytes) if bytes.is_empty() => {
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

pub(crate) struct WasiRuntime {
    inputs: Vec<Option<InputStream>>,
    outputs: Vec<Option<OutputStream>>,
    processes: Vec<Option<Process>>,
    reader: LineReader,
}

impl WasiRuntime {
    pub fn new() -> Self {
        WasiRuntime {
            inputs: Vec::new(),
            outputs: Vec::new(),
            processes: Vec::new(),
            reader: LineReader::new(),
        }
    }

    fn store_input(&mut self, stream: InputStream) -> InputHandle {
        let id = self.inputs.len() as u32;
        self.inputs.push(Some(stream));
        InputHandle(id)
    }

    fn store_output(&mut self, stream: OutputStream) -> OutputHandle {
        let id = self.outputs.len() as u32;
        self.outputs.push(Some(stream));
        OutputHandle(id)
    }

    fn store_process(&mut self, proc: Process) -> ProcessHandle {
        let id = self.processes.len() as u32;
        self.processes.push(Some(proc));
        ProcessHandle(id)
    }

    fn get_root_descriptor() -> Option<Descriptor> {
        preopens::get_directories()
            .into_iter()
            .find(|(_, p)| p == "/")
            .map(|(d, _)| d)
    }
}

fn map_signal(s: Signal) -> WasiSignal {
    match s {
        Signal::Term => WasiSignal::Sigterm,
        Signal::Kill => WasiSignal::Sigkill,
        Signal::Int => WasiSignal::Sigint,
        Signal::Tstp => WasiSignal::Sigtstp,
        Signal::Cont => WasiSignal::Sigcont,
        Signal::Null => WasiSignal::Signull,
    }
}

impl Io for WasiRuntime {
    fn write_stdout(&self, data: &str) {
        let stream = stdout::get_stdout();
        let bytes = data.as_bytes();
        if !bytes.is_empty() {
            let _ = stream.blocking_write_and_flush(bytes);
        }
    }

    fn write_stderr(&self, data: &str) {
        let stream = stderr::get_stderr();
        let bytes = data.as_bytes();
        if !bytes.is_empty() {
            let _ = stream.blocking_write_and_flush(bytes);
        }
    }

    fn read_line(&mut self) -> Option<String> {
        self.reader.read_line()
    }
}

impl Filesystem for WasiRuntime {
    fn open_file_write(&mut self, path: &str, append: bool) -> Option<OutputHandle> {
        let root = Self::get_root_descriptor()?;
        let rel = path.trim_start_matches('/');
        let desc = root
            .open_at(
                PathFlags::SYMLINK_FOLLOW,
                rel,
                OpenFlags::CREATE | if append { OpenFlags::empty() } else { OpenFlags::TRUNCATE },
                DescriptorFlags::WRITE,
            )
            .ok()?;
        let stream = if append {
            desc.append_via_stream().ok()?
        } else {
            desc.write_via_stream(0).ok()?
        };
        Some(self.store_output(stream))
    }

    fn open_file_read(&mut self, path: &str) -> Option<InputHandle> {
        let root = Self::get_root_descriptor()?;
        let rel = path.trim_start_matches('/');
        let desc = root
            .open_at(
                PathFlags::SYMLINK_FOLLOW,
                rel,
                OpenFlags::empty(),
                DescriptorFlags::READ,
            )
            .ok()?;
        let stream = desc.read_via_stream(0).ok()?;
        Some(self.store_input(stream))
    }

    fn read_directory(&self, path: &str) -> Vec<String> {
        match std::fs::read_dir(path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    fn file_exists(&self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn file_type(&self, path: &str) -> FileType {
        match std::fs::metadata(path) {
            Ok(m) => {
                if m.is_file() {
                    FileType::Regular
                } else if m.is_dir() {
                    FileType::Directory
                } else {
                    FileType::Other
                }
            }
            Err(_) => FileType::NotFound,
        }
    }

    fn unlink(&self, path: &str) {
        let _ = std::fs::remove_file(path);
    }

    fn mkdir(&self, path: &str) {
        let _ = std::fs::create_dir_all(path);
    }

    fn write_file(&self, path: &str, data: &[u8]) {
        let _ = std::fs::write(path, data);
    }

    fn read_file(&self, path: &str) -> Vec<u8> {
        std::fs::read(path).unwrap_or_default()
    }
}

impl ProcessMgr for WasiRuntime {
    fn create_pipe(&mut self) -> (InputHandle, OutputHandle) {
        let (inp, out) = proc_manager::create_pipe();
        let ih = self.store_input(inp);
        let oh = self.store_output(out);
        (ih, oh)
    }

    fn dup_output(&mut self, handle: &OutputHandle) -> OutputHandle {
        let out = self.outputs[handle.0 as usize].as_ref().expect("invalid output handle");
        let dup = proc_manager::dup_output_stream(out);
        self.store_output(dup)
    }

    fn spawn(
        &mut self,
        cmd: &str,
        args: &[String],
        opts: SpawnOpts,
    ) -> Result<ProcessHandle, SpawnError> {
        let stdin = opts
            .stdin
            .and_then(|h| self.inputs[h.0 as usize].take());
        let stdout = opts
            .stdout
            .and_then(|h| self.outputs[h.0 as usize].take());
        let stderr = opts
            .stderr
            .and_then(|h| self.outputs[h.0 as usize].take());

        let env_list: Option<Vec<(String, String)>> = opts.env;
        let spawn_opts = SpawnOptions {
            cwd: None,
            env: env_list,
            stdin,
            stdout,
            stderr,
        };

        match proc_manager::spawn(cmd, args, Some(spawn_opts)) {
            Ok(proc) => Ok(self.store_process(proc)),
            Err(_) => Err(SpawnError),
        }
    }

    fn pipe_read_all(&mut self, handle: InputHandle) -> Vec<u8> {
        let stream = match self.inputs[handle.0 as usize].take() {
            Some(s) => s,
            None => return Vec::new(),
        };
        let mut buf = Vec::new();
        loop {
            match stream.blocking_read(4096) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => buf.extend_from_slice(&bytes),
                Err(_) => break,
            }
        }
        buf
    }

    fn pipe_read_line(&mut self, handle: &InputHandle) -> Option<String> {
        let stream = self.inputs[handle.0 as usize].as_ref()?;
        let mut buf = Vec::new();
        loop {
            match stream.blocking_read(1) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => {
                    buf.extend_from_slice(&bytes);
                    if bytes.last() == Some(&b'\n') {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if buf.is_empty() {
            None
        } else {
            Some(String::from_utf8_lossy(&buf).trim_end_matches('\n').to_string())
        }
    }

    fn pipe_write(&mut self, handle: &OutputHandle, data: &[u8]) {
        if let Some(stream) = self.outputs[handle.0 as usize].as_ref() {
            let _ = stream.blocking_write_and_flush(data);
        }
    }

    fn pipe_close_write(&mut self, handle: OutputHandle) {
        self.outputs[handle.0 as usize].take();
    }

    fn wait(&mut self, handle: &ProcessHandle) -> u8 {
        if let Some(proc) = self.processes[handle.0 as usize].as_ref() {
            proc.wait()
        } else {
            0
        }
    }

    fn try_wait(&self, handle: &ProcessHandle) -> Option<u8> {
        self.processes[handle.0 as usize]
            .as_ref()
            .and_then(|p| p.try_wait())
    }

    fn kill(&self, handle: &ProcessHandle, signal: Signal) -> Result<(), ()> {
        match self.processes[handle.0 as usize].as_ref() {
            Some(proc) => proc.kill(map_signal(signal)).map_err(|_| ()),
            None => Err(()),
        }
    }

    fn pid(&self, handle: &ProcessHandle) -> u32 {
        self.processes[handle.0 as usize]
            .as_ref()
            .map(|p| p.pid())
            .unwrap_or(0)
    }
}
