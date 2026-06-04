use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{
    InputStream, OutputStream, Process, SpawnOptions, Signal as WasiSignal,
};
use crate::bindings::wasi::filesystem::types::{
    Descriptor, DescriptorFlags, OpenFlags, PathFlags,
};
use crate::bindings::wasi::filesystem::preopens;
use crate::runtime::{
    FileType, InputHandle, Io, Filesystem, OutputHandle, ProcessHandle,
    ProcessMgr, Signal, SpawnError, SpawnOpts,
};

use std::io::{self, BufRead, BufReader, Stdin};

struct LineReader {
    reader: BufReader<Stdin>,
}

impl LineReader {
    fn new() -> Self {
        LineReader { reader: BufReader::new(io::stdin()) }
    }

    fn read_line(&mut self) -> Option<String> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(line),
            Err(_) => None,
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

    fn get_input(&self, handle: &InputHandle) -> Option<&InputStream> {
        self.inputs.get(handle.0 as usize).and_then(|o| o.as_ref())
    }

    fn take_input(&mut self, handle: &InputHandle) -> Option<InputStream> {
        self.inputs.get_mut(handle.0 as usize).and_then(|o| o.take())
    }

    fn get_output(&self, handle: &OutputHandle) -> Option<&OutputStream> {
        self.outputs.get(handle.0 as usize).and_then(|o| o.as_ref())
    }

    fn take_output(&mut self, handle: &OutputHandle) -> Option<OutputStream> {
        self.outputs.get_mut(handle.0 as usize).and_then(|o| o.take())
    }

    fn get_process(&self, handle: &ProcessHandle) -> Option<&Process> {
        self.processes.get(handle.0 as usize).and_then(|o| o.as_ref())
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
        use std::io::Write;
        let _ = io::stdout().write_all(data.as_bytes());
        let _ = io::stdout().flush();
    }

    fn write_stderr(&self, data: &str) {
        use std::io::Write;
        let _ = io::stderr().write_all(data.as_bytes());
        let _ = io::stderr().flush();
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
        let out = self.get_output(handle).expect("invalid output handle");
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
            .and_then(|h| self.take_input(&h));
        let stdout = opts
            .stdout
            .and_then(|h| self.take_output(&h));
        let stderr = opts
            .stderr
            .and_then(|h| self.take_output(&h));

        let env_list: Option<Vec<(String, String)>> = opts.env;
        let mut env_with_cwd = env_list.unwrap_or_default();
        if let Some(ref cwd) = opts.cwd {
            env_with_cwd.retain(|(k, _)| k != "PWD");
            env_with_cwd.push(("PWD".to_string(), cwd.clone()));
        }
        let spawn_opts = SpawnOptions {
            cwd: None,
            env: Some(env_with_cwd),
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
        let stream = match self.take_input(&handle) {
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
        let stream = self.get_input(handle)?;
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
        if let Some(stream) = self.get_output(handle) {
            let _ = stream.blocking_write_and_flush(data);
        }
    }

    fn pipe_close_write(&mut self, handle: OutputHandle) {
        self.take_output(&handle);
    }

    fn pipe_close_read(&mut self, handle: InputHandle) {
        self.take_input(&handle);
    }

    fn wait(&mut self, handle: &ProcessHandle) -> u8 {
        if let Some(proc) = self.get_process(handle) {
            proc.wait()
        } else {
            0
        }
    }

    fn try_wait(&self, handle: &ProcessHandle) -> Option<u8> {
        self.get_process(handle)
            .and_then(|p| p.try_wait())
    }

    fn kill(&self, handle: &ProcessHandle, signal: Signal) -> Result<(), ()> {
        match self.get_process(handle) {
            Some(proc) => proc.kill(map_signal(signal)).map_err(|_| ()),
            None => Err(()),
        }
    }

    fn pid(&self, handle: &ProcessHandle) -> u32 {
        self.get_process(handle)
            .map(|p| p.pid())
            .unwrap_or(0)
    }
}
