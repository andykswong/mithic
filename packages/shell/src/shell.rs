use std::collections::HashMap;

use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{InputStream, OutputStream, SpawnOptions};
use crate::bindings::wasi::cli::{environment, terminal_stdin};
use crate::io::{self, LineReader};
use crate::parser::{Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};

pub struct Shell {
    env: HashMap<String, String>,
    cwd: String,
    last_exit: u8,
    is_interactive: bool,
    exit_requested: bool,
    reader: LineReader,
}

impl Shell {
    pub fn new() -> Self {
        let env: HashMap<String, String> = environment::get_environment()
            .into_iter()
            .collect();

        let cwd = environment::initial_cwd()
            .unwrap_or_else(|| "/".to_string());

        let is_interactive = terminal_stdin::get_terminal_stdin().is_some();

        Shell {
            env,
            cwd,
            last_exit: 0,
            is_interactive,
            exit_requested: false,
            reader: LineReader::new(),
        }
    }

    pub fn run(&mut self) -> u8 {
        if self.is_interactive {
            io::write_stdout("mithic shell v0.1.0\n");
        }

        loop {
            if self.is_interactive {
                let prompt = format!("{}$ ", self.cwd);
                io::write_stdout(&prompt);
            }

            let line = match self.reader.read_line() {
                Some(l) => l,
                None => break,
            };

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let mut parser = Parser::new(trimmed);
            if let Some(list) = parser.parse() {
                self.last_exit = self.exec_list(list);
            }

            if self.exit_requested {
                break;
            }
        }

        self.last_exit
    }

    fn exec_list(&mut self, list: List) -> u8 {
        let mut exit = 0u8;
        let mut skip_next = false;

        for ListItem { pipeline, op } in list.items {
            if !skip_next {
                exit = self.exec_pipeline(pipeline);
                self.last_exit = exit;
                if self.exit_requested {
                    break;
                }
            }

            skip_next = match op {
                Some(ListOp::And) => exit != 0,
                Some(ListOp::Or) => exit == 0,
                _ => false,
            };
        }

        exit
    }

    fn exec_pipeline(&mut self, pipeline: Pipeline) -> u8 {
        let cmds = pipeline.commands;
        let n = cmds.len();

        if n == 0 {
            return 0;
        }

        if n == 1 {
            let cmd = match cmds.into_iter().next().unwrap() {
                Command::Simple(sc) => sc,
                _ => return 0,
            };
            let exit = self.exec_command(cmd, None, None);
            return if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit };
        }

        // Multi-command pipeline: create N-1 pipes.
        // pipes[i] = (read_end, write_end) connecting stage i to stage i+1.
        let mut pipe_read_ends: Vec<Option<InputStream>> = Vec::with_capacity(n);
        let mut pipe_write_ends: Vec<Option<OutputStream>> = Vec::with_capacity(n);

        // Stage 0 has no upstream pipe read end.
        pipe_read_ends.push(None);
        // Stage n-1 has no downstream pipe write end.
        for _ in 0..n - 1 {
            let (inp, out) = proc_manager::create_pipe();
            pipe_read_ends.push(Some(inp));   // read end for stage i+1
            pipe_write_ends.push(Some(out));  // write end for stage i
        }
        pipe_write_ends.push(None); // last stage writes to shell stdout

        let env_list = self.env_list();

        let mut processes: Vec<crate::bindings::mithic::process::types::Process> = Vec::new();
        let mut last_builtin_exit: Option<u8> = None;

        for (i, command) in cmds.into_iter().enumerate() {
            let cmd = match command {
                Command::Simple(sc) => sc,
                _ => continue,
            };
            let mut stdin_opt = pipe_read_ends[i].take();
            let mut stdout_opt = pipe_write_ends[i].take();

            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| {
                    let expanded = self.expand_word(w);
                    if has_glob(&expanded) {
                        self.expand_glob(&expanded)
                    } else {
                        vec![expanded]
                    }
                })
                .collect();
            let mut stderr_opt: Option<OutputStream> = None;
            if !self.apply_redirects(&cmd.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                for p in processes { let _ = p.wait(); }
                return if pipeline.negate { 0 } else { 1 };
            }

            if args.is_empty() {
                continue;
            }

            let name = args[0].clone();
            if Self::is_builtin(&name) {
                let exit = self.exec_builtin(&name, &args[1..], stdin_opt, stdout_opt);
                if self.exit_requested {
                    for p in processes { let _ = p.wait(); }
                    return exit;
                }
                if i == n - 1 {
                    last_builtin_exit = Some(exit);
                }
            } else {
                let opts = SpawnOptions {
                    cwd: None, // inherit; cwd is a Descriptor in WIT, we propagate env instead
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: stderr_opt,
                };
                match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                    Ok(proc) => processes.push(proc),
                    Err(_) => {
                        io::write_stderr(&format!("msh: {}: command not found\n", name));
                        for p in processes { let _ = p.wait(); }
                        return if pipeline.negate { 0 } else { 127 };
                    }
                }
            }
        }

        // Wait for all spawned processes; exit code = last stage.
        let last_proc = processes.pop();
        for p in processes { let _ = p.wait(); }
        let exit = if let Some(p) = last_proc {
            p.wait() as u8
        } else {
            last_builtin_exit.unwrap_or(self.last_exit)
        };
        if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit }
    }

    /// Execute a single command with optional pre-wired stdin/stdout (used in pipeline).
    fn exec_command(
        &mut self,
        cmd: SimpleCommand,
        mut stdin: Option<InputStream>,
        mut stdout: Option<OutputStream>,
    ) -> u8 {
        if cmd.words.is_empty() {
            return 0;
        }

        let args: Vec<String> = cmd.words.iter()
            .flat_map(|w| {
                let expanded = self.expand_word(w);
                if has_glob(&expanded) {
                    self.expand_glob(&expanded)
                } else {
                    vec![expanded]
                }
            })
            .collect();
        let mut stderr_opt: Option<OutputStream> = None;
        if !self.apply_redirects(&cmd.redirects, &mut stdin, &mut stdout, &mut stderr_opt) {
            return 1;
        }

        let name = args[0].clone();
        if Self::is_builtin(&name) {
            self.exec_builtin(&name, &args[1..], stdin, stdout)
        } else {
            let opts = SpawnOptions {
                cwd: None,
                env: Some(self.env_list()),
                stdin,
                stdout,
                stderr: stderr_opt,
            };
            match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                Ok(proc) => proc.wait() as u8,
                Err(_) => {
                    io::write_stderr(&format!("msh: {}: command not found\n", name));
                    127
                }
            }
        }
    }

    fn is_builtin(name: &str) -> bool {
        matches!(name,
            "exit" | "echo" | "pwd" | "cd" | "export" | "unset" |
            "env" | "true" | "false"
        )
    }

    fn exec_builtin(
        &mut self,
        name: &str,
        args: &[String],
        _stdin: Option<InputStream>,
        stdout: Option<OutputStream>,
    ) -> u8 {
        macro_rules! write_out {
            ($s:expr) => {
                if let Some(ref out) = stdout {
                    let _ = out.blocking_write_and_flush($s.as_bytes());
                } else {
                    io::write_stdout($s);
                }
            };
        }

        match name {
            "exit" => {
                let code: u8 = args.first()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(self.last_exit);
                self.exit_requested = true;
                code
            }
            "echo" => {
                let output = args.join(" ");
                write_out!(&output);
                write_out!("\n");
                0
            }
            "pwd" => {
                write_out!(&self.cwd);
                write_out!("\n");
                0
            }
            "cd" => {
                let target = args.first().cloned()
                    .unwrap_or_else(|| self.env.get("HOME").cloned().unwrap_or_else(|| "/".to_string()));
                let resolved = self.resolve_path(&target);
                self.cwd = resolved;
                self.env.insert("PWD".to_string(), self.cwd.clone());
                0
            }
            "export" => {
                for arg in args {
                    if let Some((key, value)) = arg.split_once('=') {
                        self.env.insert(key.to_string(), value.to_string());
                    }
                }
                0
            }
            "unset" => {
                for arg in args { self.env.remove(arg.as_str()); }
                0
            }
            "env" => {
                for (key, value) in &self.env {
                    write_out!(&format!("{}={}\n", key, value));
                }
                0
            }
            "true" => 0,
            "false" => 1,
            _ => 127,
        }
    }

    #[allow(dead_code)]
    fn exec_external(
        &self,
        name: &str,
        args: &[String],
        stdin: Option<InputStream>,
        stdout: Option<OutputStream>,
    ) -> u8 {
        let opts = SpawnOptions {
            cwd: None,
            env: Some(self.env_list()),
            stdin,
            stdout,
            stderr: None,
        };
        match proc_manager::spawn(name, args, Some(opts)) {
            Ok(proc) => proc.wait() as u8,
            Err(_) => {
                io::write_stderr(&format!("msh: {}: command not found\n", name));
                127
            }
        }
    }

    #[cfg(not(test))]
    fn exec_capturing(&mut self, raw: &str) -> String {
        let (inp, out) = proc_manager::create_pipe();
        let mut parser = Parser::new(raw);
        if let Some(list) = parser.parse() {
            self.exec_list_with_stdout(list, out);
        } else {
            drop(out);
        }
        let mut buf = Vec::new();
        loop {
            match inp.blocking_read(4096) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => buf.extend_from_slice(&bytes),
                Err(_) => break,
            }
        }
        let s = String::from_utf8_lossy(&buf).into_owned();
        s.trim_end_matches('\n').to_string()
    }

    #[cfg(test)]
    fn exec_capturing(&mut self, _raw: &str) -> String {
        String::new()
    }

    #[cfg(not(test))]
    fn exec_list_with_stdout(&mut self, list: List, stdout: OutputStream) -> u8 {
        let mut exit = 0u8;
        let mut skip_next = false;

        for ListItem { pipeline, op } in list.items {
            if !skip_next {
                let out = proc_manager::dup_output_stream(&stdout);
                exit = self.exec_pipeline_with_stdout(pipeline, out);
                if self.exit_requested { break; }
            }
            skip_next = match op {
                Some(ListOp::And) => exit != 0,
                Some(ListOp::Or)  => exit == 0,
                _ => false,
            };
        }
        drop(stdout);
        exit
    }

    #[cfg(not(test))]
    fn exec_pipeline_with_stdout(&mut self, pipeline: Pipeline, stdout: OutputStream) -> u8 {
        let cmds = pipeline.commands;
        let n = cmds.len();
        if n == 0 { return 0; }

        if n == 1 {
            let cmd = match cmds.into_iter().next().unwrap() {
                Command::Simple(sc) => sc,
                _ => { drop(stdout); return 0; }
            };
            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| {
                    let expanded = self.expand_word(w);
                    if has_glob(&expanded) { self.expand_glob(&expanded) } else { vec![expanded] }
                })
                .collect();
            if args.is_empty() { drop(stdout); return 0; }
            let name = args[0].clone();
            let exit = if Self::is_builtin(&name) {
                self.exec_builtin(&name, &args[1..], None, Some(stdout))
            } else {
                let opts = SpawnOptions {
                    cwd: None,
                    env: Some(self.env_list()),
                    stdin: None,
                    stdout: Some(stdout),
                    stderr: None,
                };
                match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                    Ok(proc) => proc.wait() as u8,
                    Err(_) => {
                        io::write_stderr(&format!("msh: {}: command not found\n", name));
                        127
                    }
                }
            };
            return if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit };
        }

        // Multi-command pipeline: internal pipes + last stage → provided stdout
        let mut pipe_read_ends: Vec<Option<InputStream>> = Vec::with_capacity(n);
        let mut pipe_write_ends: Vec<Option<OutputStream>> = Vec::with_capacity(n);
        pipe_read_ends.push(None);
        for _ in 0..n - 1 {
            let (inp, out) = proc_manager::create_pipe();
            pipe_read_ends.push(Some(inp));
            pipe_write_ends.push(Some(out));
        }
        pipe_write_ends.push(Some(stdout));

        let env_list = self.env_list();
        let mut processes: Vec<crate::bindings::mithic::process::types::Process> = Vec::new();
        let mut last_builtin_exit: Option<u8> = None;

        for (i, command) in cmds.into_iter().enumerate() {
            let cmd = match command {
                Command::Simple(sc) => sc,
                _ => continue,
            };
            let stdin_opt = pipe_read_ends[i].take();
            let stdout_opt = pipe_write_ends[i].take();
            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| {
                    let expanded = self.expand_word(w);
                    if has_glob(&expanded) { self.expand_glob(&expanded) } else { vec![expanded] }
                })
                .collect();
            if args.is_empty() { continue; }
            let name = args[0].clone();
            if Self::is_builtin(&name) {
                let exit = self.exec_builtin(&name, &args[1..], stdin_opt, stdout_opt);
                if self.exit_requested {
                    for p in processes { let _ = p.wait(); }
                    return exit;
                }
                if i == n - 1 { last_builtin_exit = Some(exit); }
            } else {
                let opts = SpawnOptions {
                    cwd: None,
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: None,
                };
                match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                    Ok(proc) => processes.push(proc),
                    Err(_) => {
                        io::write_stderr(&format!("msh: {}: command not found\n", name));
                        for p in processes { let _ = p.wait(); }
                        return if pipeline.negate { 0 } else { 127 };
                    }
                }
            }
        }

        let last_proc = processes.pop();
        for p in processes { let _ = p.wait(); }
        let exit = if let Some(p) = last_proc { p.wait() as u8 }
                   else { last_builtin_exit.unwrap_or(self.last_exit) };
        if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit }
    }

    fn env_list(&self) -> Vec<(String, String)> {
        self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn resolve_path(&self, path: &str) -> String {
        let home = self.env.get("HOME").map(|s| s.as_str()).unwrap_or("/");
        let expanded = expand_tilde(path, home);
        let base = if expanded.starts_with('/') {
            expanded
        } else {
            format!("{}/{}", self.cwd.trim_end_matches('/'), expanded)
        };
        normalize_path(&base)
    }

    fn expand_word(&mut self, word: &Word) -> String {
        let parts: Vec<_> = word.parts().to_vec();
        parts.iter().map(|p| self.expand_part(p)).collect()
    }

    fn expand_part(&mut self, part: &WordPart) -> String {
        match part {
            WordPart::Literal(s) => {
                let home = self.env.get("HOME").map(|s| s.as_str()).unwrap_or("/");
                expand_tilde(s, home)
            }
            WordPart::Var(name) => self.expand_var(name),
            WordPart::BraceVar(raw) => self.expand_brace_var(raw),
            WordPart::CmdSub(raw) => self.exec_capturing(raw),
        }
    }

    fn expand_var(&self, name: &str) -> String {
        match name {
            "?" => self.last_exit.to_string(),
            "#" => "0".to_string(),
            "@" | "*" => String::new(),
            _ => self.env.get(name).cloned().unwrap_or_default(),
        }
    }

    fn expand_brace_var(&self, raw: &str) -> String {
        if let Some((name, rest)) = raw.split_once(":-") {
            let val = self.expand_var(name);
            if val.is_empty() { rest.to_string() } else { val }
        } else if let Some((name, alt)) = raw.split_once(":+") {
            let val = self.expand_var(name);
            if val.is_empty() { String::new() } else { alt.to_string() }
        } else if let Some(name) = raw.strip_prefix('#') {
            self.expand_var(name).len().to_string()
        } else {
            self.expand_var(raw)
        }
    }

    #[cfg(not(test))]
    fn expand_glob(&self, pattern: &str) -> Vec<String> {
        use crate::bindings::wasi::filesystem::{preopens, types as fs_types};
        use fs_types::{DescriptorFlags, OpenFlags, PathFlags};

        let (dir_part, name_pat) = match pattern.rfind('/') {
            Some(pos) => (&pattern[..pos], &pattern[pos + 1..]),
            None => ("", pattern),
        };

        let dir_path = if dir_part.is_empty() {
            self.cwd.clone()
        } else {
            self.resolve_path(dir_part)
        };

        let dirs = preopens::get_directories();
        let root_desc = match dirs.into_iter().find(|(_, p)| p == "/") {
            Some((d, _)) => d,
            None => return vec![pattern.to_string()],
        };

        let rel_path = dir_path.trim_start_matches('/');
        let target_desc = if rel_path.is_empty() {
            root_desc
        } else {
            match root_desc.open_at(
                PathFlags::SYMLINK_FOLLOW,
                rel_path,
                OpenFlags::DIRECTORY,
                DescriptorFlags::READ | DescriptorFlags::MUTATE_DIRECTORY,
            ) {
                Ok(d) => d,
                Err(_) => return vec![pattern.to_string()],
            }
        };

        let stream = match target_desc.read_directory() {
            Ok(s) => s,
            Err(_) => return vec![pattern.to_string()],
        };

        let mut matches: Vec<String> = Vec::new();
        loop {
            match stream.read_directory_entry() {
                Ok(Some(entry)) => {
                    if entry.name.starts_with('.') && !name_pat.starts_with('.') {
                        continue;
                    }
                    if glob_match(name_pat, &entry.name) {
                        let full = if dir_part.is_empty() {
                            entry.name
                        } else {
                            format!("{}/{}", dir_part, entry.name)
                        };
                        matches.push(full);
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }

        if matches.is_empty() {
            vec![pattern.to_string()]
        } else {
            matches.sort();
            matches
        }
    }

    #[cfg(test)]
    fn expand_glob(&self, pattern: &str) -> Vec<String> {
        vec![pattern.to_string()]
    }

    #[cfg(not(test))]
    /// Returns `true` on success, `false` if a redirect failed (command should not execute).
    fn apply_redirects(
        &mut self,
        redirects: &[crate::parser::Redirect],
        stdin: &mut Option<InputStream>,
        stdout: &mut Option<OutputStream>,
        stderr: &mut Option<OutputStream>,
    ) -> bool {
        use crate::bindings::wasi::filesystem::types::{DescriptorFlags, OpenFlags, PathFlags};
        use crate::bindings::wasi::filesystem::preopens;
        use crate::parser::Redirect;

        let root = match preopens::get_directories().into_iter().find(|(_, p)| p == "/") {
            Some((d, _)) => d,
            None => return true,
        };

        for redirect in redirects {
            match redirect {
                Redirect::Out(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => *stdout = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::OutAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.append_via_stream() {
                            Ok(stream) => *stdout = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for appending\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::In(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::empty(), DescriptorFlags::READ,
                    ) {
                        Ok(desc) => match desc.read_via_stream(0) {
                            Ok(stream) => *stdin = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for reading\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::Err(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => *stderr = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::ErrAppend(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.append_via_stream() {
                            Ok(stream) => *stderr = Some(stream),
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for appending\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::ErrToOut => {
                    if let Some(out) = stdout.as_ref() {
                        *stderr = Some(proc_manager::dup_output_stream(out));
                    }
                }
                Redirect::Both(w) => {
                    let expanded = self.expand_word(w);
                    let path = self.resolve_path(&expanded);
                    let rel = path.trim_start_matches('/');
                    match root.open_at(
                        PathFlags::SYMLINK_FOLLOW, rel,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE, DescriptorFlags::WRITE,
                    ) {
                        Ok(desc) => match desc.write_via_stream(0) {
                            Ok(stream) => {
                                let dup = proc_manager::dup_output_stream(&stream);
                                *stdout = Some(stream);
                                *stderr = Some(dup);
                            },
                            Err(_) => { io::write_stderr(&format!("msh: {}: cannot open for writing\n", expanded)); return false; }
                        },
                        Err(_) => { io::write_stderr(&format!("msh: {}: No such file or directory\n", expanded)); return false; }
                    }
                }
                Redirect::HereString(w) => {
                    let content = self.expand_word(w);
                    let mut bytes = content.into_bytes();
                    bytes.push(b'\n');
                    let (inp, out) = proc_manager::create_pipe();
                    let _ = out.blocking_write_and_flush(&bytes);
                    drop(out);
                    *stdin = Some(inp);
                }
            }
        }
        true
    }

    #[cfg(test)]
    fn apply_redirects(
        &mut self,
        _redirects: &[crate::parser::Redirect],
        _stdin: &mut Option<InputStream>,
        _stdout: &mut Option<OutputStream>,
        _stderr: &mut Option<OutputStream>,
    ) -> bool { true }
}

fn expand_tilde(s: &str, home: &str) -> String {
    if s == "~" {
        home.to_string()
    } else if let Some(rest) = s.strip_prefix("~/") {
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        s.to_string()
    }
}

fn has_glob(s: &str) -> bool {
    s.contains('*') || s.contains('?') || s.contains('[')
}

fn glob_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let nam: Vec<char> = name.chars().collect();
    glob_match_inner(&pat, &nam)
}

fn glob_match_inner(pat: &[char], name: &[char]) -> bool {
    match (pat.first(), name.first()) {
        (None, None) => true,
        (None, _) => false,
        (Some(&'*'), _) => {
            for skip in 0..=name.len() {
                if glob_match_inner(&pat[1..], &name[skip..]) {
                    return true;
                }
            }
            false
        }
        (Some(&'?'), Some(_)) => glob_match_inner(&pat[1..], &name[1..]),
        (Some(&'?'), None) => false,
        (Some(&'['), _) => {
            let close = pat[1..].iter().position(|&c| c == ']');
            if let Some(rel) = close {
                let class = &pat[1..1 + rel];
                let rest = &pat[2 + rel..];
                if let Some(&nc) = name.first() {
                    if class.contains(&nc) {
                        return glob_match_inner(rest, &name[1..]);
                    }
                }
                false
            } else {
                if name.first() == Some(&'[') {
                    glob_match_inner(&pat[1..], &name[1..])
                } else {
                    false
                }
            }
        }
        (Some(pc), Some(nc)) => {
            if pc == nc {
                glob_match_inner(&pat[1..], &name[1..])
            } else {
                false
            }
        }
        (Some(_), None) => false,
    }
}

fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => { parts.pop(); }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_tilde, glob_match, has_glob, normalize_path};

    #[test]
    fn test_tilde_expansion_in_word() {
        assert_eq!(expand_tilde("~/foo", "/home"), "/home/foo");
        assert_eq!(expand_tilde("~", "/home"), "/home");
        assert_eq!(expand_tilde("/abs/path", "/home"), "/abs/path");
        assert_eq!(expand_tilde("relative", "/home"), "relative");
    }

    #[test]
    fn test_normalize_simple() {
        assert_eq!(normalize_path("/home/user"), "/home/user");
    }

    #[test]
    fn test_normalize_dotdot() {
        assert_eq!(normalize_path("/home/user/../other"), "/home/other");
    }

    #[test]
    fn test_normalize_dot() {
        assert_eq!(normalize_path("/home/./user"), "/home/user");
    }

    #[test]
    fn test_normalize_trailing_slash() {
        assert_eq!(normalize_path("/home/user/"), "/home/user");
    }

    #[test]
    fn test_normalize_double_slash() {
        assert_eq!(normalize_path("/home//user"), "/home/user");
    }

    #[test]
    fn test_normalize_to_root() {
        assert_eq!(normalize_path("/home/.."), "/");
    }

    #[test]
    fn test_normalize_above_root() {
        assert_eq!(normalize_path("/../.."), "/");
    }

    #[test]
    fn test_glob_match_star() {
        assert!(glob_match("*.rs", "foo.rs"));
        assert!(glob_match("*.rs", ".rs"));
        assert!(!glob_match("*.rs", "foo.txt"));
        assert!(glob_match("foo*", "foobar"));
        assert!(!glob_match("foo*", "barfoo"));
    }

    #[test]
    fn test_glob_match_question() {
        assert!(glob_match("f?o", "foo"));
        assert!(glob_match("f?o", "fXo"));
        assert!(!glob_match("f?o", "fo"));
        assert!(!glob_match("f?o", "fooo"));
    }

    #[test]
    fn test_glob_match_bracket() {
        assert!(glob_match("[abc]at", "bat"));
        assert!(glob_match("[abc]at", "cat"));
        assert!(!glob_match("[abc]at", "dat"));
    }

    #[test]
    fn test_has_glob() {
        assert!(has_glob("*.rs"));
        assert!(has_glob("foo?bar"));
        assert!(has_glob("[abc]"));
        assert!(!has_glob("normal"));
        assert!(!has_glob("/path/to/file"));
    }
}
