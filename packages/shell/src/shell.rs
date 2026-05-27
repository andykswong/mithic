use std::collections::HashMap;

use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{InputStream, OutputStream, SpawnOptions};
use crate::bindings::wasi::cli::{environment, terminal_stdin};
use crate::io::{self, LineReader};
use crate::parser::{List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};

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
            let exit = self.exec_command(cmds.into_iter().next().unwrap(), None, None);
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

        for (i, cmd) in cmds.into_iter().enumerate() {
            let stdin_opt = pipe_read_ends[i].take();
            let stdout_opt = pipe_write_ends[i].take();

            let args: Vec<String> = cmd.words.iter()
                .map(|w| self.expand_word(w))
                .collect();
            let _ = &cmd.redirects; // Phase 4

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
        stdin: Option<InputStream>,
        stdout: Option<OutputStream>,
    ) -> u8 {
        if cmd.words.is_empty() {
            return 0;
        }

        let args: Vec<String> = cmd.words.iter()
            .map(|w| self.expand_word(w))
            .collect();
        let _ = &cmd.redirects; // Phase 4

        let name = args[0].clone();
        if Self::is_builtin(&name) {
            self.exec_builtin(&name, &args[1..], stdin, stdout)
        } else {
            self.exec_external(&name, &args[1..], stdin, stdout)
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

    fn env_list(&self) -> Vec<(String, String)> {
        self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    fn resolve_path(&self, path: &str) -> String {
        let base = if path.starts_with('/') {
            path.to_string()
        } else if path == "~" || path.starts_with("~/") {
            let home = self.env.get("HOME").cloned().unwrap_or_else(|| "/".to_string());
            if path == "~" {
                home
            } else {
                format!("{}/{}", home.trim_end_matches('/'), &path[2..])
            }
        } else {
            format!("{}/{}", self.cwd.trim_end_matches('/'), path)
        };
        normalize_path(&base)
    }

    fn expand_word(&self, word: &Word) -> String {
        word.parts().iter().map(|p| self.expand_part(p)).collect()
    }

    fn expand_part(&self, part: &WordPart) -> String {
        match part {
            WordPart::Literal(s) => s.clone(),
            WordPart::Var(name) => self.expand_var(name),
            WordPart::BraceVar(raw) => self.expand_brace_var(raw),
            WordPart::CmdSub(_raw) => String::new(), // Phase 4
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
    use super::normalize_path;

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
}
