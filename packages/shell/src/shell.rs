use std::collections::HashMap;

use crate::executor::expansion::{
    expand_tilde, literal_text, normalize_path, parse_array_subscript,
};
use crate::parser::{Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand};
use crate::value::ShellValue;
use crate::jobs::JobTable;
use crate::options::ShellOptions;
use crate::params::PositionalParams;
use crate::runtime::{InputHandle, OutputHandle, ProcessHandle, Runtime, SpawnOpts};

pub struct Shell<R: Runtime> {
    pub(crate) rt: R,
    pub(crate) env: HashMap<String, ShellValue>,
    pub(crate) params: PositionalParams,
    pub(crate) cwd: String,
    pub(crate) last_exit: u8,
    pub(crate) is_interactive: bool,
    pub(crate) exit_requested: bool,
    pub(crate) functions: HashMap<String, Command>,
    pub(crate) break_depth: usize,
    pub(crate) continue_depth: usize,
    pub(crate) return_requested: bool,
    pub(crate) in_loop_depth: usize,
    pub(crate) in_function_depth: usize,
    pub(crate) procsub_counter: u64,
    pub(crate) procsub_paths: Vec<String>,
    pub(crate) jobs: JobTable,
    pub(crate) traps: HashMap<String, String>,
    pub(crate) foreground_pids: Vec<u32>,
    pub(crate) options: ShellOptions,
    pub(crate) in_condition: usize,
}

impl<R: Runtime> Shell<R> {
    pub fn new(rt: R, env: HashMap<String, ShellValue>, cwd: String, is_interactive: bool) -> Self {
        Shell {
            rt,
            env,
            params: PositionalParams::new(),
            cwd,
            last_exit: 0,
            is_interactive,
            exit_requested: false,
            functions: HashMap::new(),
            break_depth: 0,
            continue_depth: 0,
            return_requested: false,
            in_loop_depth: 0,
            in_function_depth: 0,
            procsub_counter: 0,
            procsub_paths: Vec::new(),
            jobs: JobTable::new(),
            traps: HashMap::new(),
            foreground_pids: Vec::new(),
            options: ShellOptions::default(),
            in_condition: 0,
        }
    }

    pub fn run(&mut self) -> u8 {
        if self.is_interactive {
            self.rt.write_stdout("mithic shell v0.1.0\n");
        }

        let mut input_buf = String::new();

        loop {
            if self.is_interactive {
                let prompt = if input_buf.is_empty() {
                    format!("{}$ ", self.cwd)
                } else {
                    "> ".to_string()
                };
                self.rt.write_stdout(&prompt);
            }

            let line = match self.rt.read_line() {
                Some(l) => l,
                None => {
                    // EOF: try to parse whatever is buffered
                    if !input_buf.is_empty() {
                        let trimmed = input_buf.trim().to_string();
                        if !trimmed.is_empty() {
                            let mut parser = Parser::new(&trimmed);
                            let result = parser.parse();
                            for err in parser.errors() {
                                self.rt.write_stderr(&format!(
                                    "msh: syntax error at line {}, col {}: {}\n",
                                    err.span.line, err.span.col, err.message
                                ));
                            }
                            if let Some(list) = result {
                                self.last_exit = self.exec_list(list);
                            }
                        }
                    }
                    break;
                }
            };

            input_buf.push_str(&line);

            let trimmed = input_buf.trim().to_string();
            if trimmed.is_empty() {
                input_buf.clear();
                continue;
            }

            // Check for line continuation (trailing backslash)
            if trimmed.ends_with('\\') {
                let without_backslash = trimmed.trim_end_matches('\\').to_string();
                input_buf = without_backslash;
                input_buf.push(' ');
                continue;
            }

            let mut parser = Parser::new(&trimmed);
            let result = parser.parse();

            if parser.is_incomplete() {
                // Incomplete compound command — keep reading
                continue;
            }

            for err in parser.errors() {
                self.rt.write_stderr(&format!(
                    "msh: syntax error at line {}, col {}: {}\n",
                    err.span.line, err.span.col, err.message
                ));
            }

            if let Some(list) = result {
                self.last_exit = self.exec_list(list);
            }

            input_buf.clear();
            self.check_background_jobs();

            if self.exit_requested {
                break;
            }
        }

        self.run_trap("EXIT");
        self.cleanup_procsub_files();
        self.last_exit
    }

    pub(crate) fn exec_list(&mut self, list: List) -> u8 {
        let mut exit = 0u8;
        let mut skip_next = false;

        for ListItem { pipeline, op } in list.items {
            if !skip_next {
                if op == Some(ListOp::Background) {
                    self.exec_pipeline_background(pipeline);
                    exit = 0;
                    self.last_exit = 0;
                } else {
                    exit = self.exec_pipeline(pipeline);
                    self.last_exit = exit;
                }
                if self.exit_requested || self.return_requested || self.break_depth > 0 || self.continue_depth > 0 {
                    break;
                }
                // set -e: exit on non-zero status, but not in condition contexts or && / || chains
                if self.options.errexit && exit != 0 && self.in_condition == 0 {
                    if op == Some(ListOp::Seq) || op.is_none() {
                        self.exit_requested = true;
                        return exit;
                    }
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

    pub(crate) fn dispatch_simple(
        &mut self,
        cmd: SimpleCommand,
        mut stdin: Option<InputHandle>,
        mut stdout: Option<OutputHandle>,
        env_list: Option<&[(String, String)]>,
    ) -> u8 {
        // Detect scalar assignment: `VAR=value` (no spaces, only first word).
        // Also detect indexed array assignment: `arr[idx]=value`.
        // We check the raw (unexpanded) first word for these patterns before
        // expanding everything, because assignment words must not be globbed.
        if cmd.words.len() == 1 {
            if let Some(raw) = literal_text(&cmd.words[0]) {
                if let Some(exit) = self.try_assignment(&raw) {
                    return exit;
                }
            }
        }

        let args: Vec<String> = cmd.words.iter()
            .flat_map(|w| self.expand_word_to_args(w))
            .collect();

        // If nounset triggered during expansion, bail out with error
        if self.exit_requested && self.options.nounset {
            return self.last_exit;
        }

        let mut stderr_opt: Option<OutputHandle> = None;
        if !self.apply_redirects(&cmd.redirects, &mut stdin, &mut stdout, &mut stderr_opt) {
            return 1;
        }

        if args.is_empty() {
            return 0;
        }

        if self.options.xtrace {
            self.rt.write_stderr(&format!("+ {}\n", args.join(" ")));
        }

        let name = args[0].clone();
        if let Some(body) = self.functions.get(&name).cloned() {
            self.exec_function_call(&args[1..], body)
        } else if Self::is_builtin(&name) {
            self.exec_builtin(&name, &args[1..], stdin, stdout)
        } else {
            let env = match env_list {
                Some(list) => list.to_vec(),
                None => self.env_list(),
            };
            let opts = SpawnOpts {
                env: Some(env),
                stdin,
                stdout,
                stderr: stderr_opt,
            };
            match self.rt.spawn(&name, &args[1..], opts) {
                Ok(proc) => {
                    let pid = self.rt.pid(&proc);
                    self.foreground_pids = vec![pid];
                    let exit = self.rt.wait(&proc);
                    self.foreground_pids.clear();
                    if exit >= 128 {
                        let sig_name = signal_name_from_num(exit - 128);
                        if !sig_name.is_empty() {
                            self.run_trap(sig_name);
                        }
                    }
                    exit
                }
                Err(_) => {
                    self.rt.write_stderr(&format!("msh: {}: command not found\n", name));
                    127
                }
            }
        }
    }

    /// If `word` is a standalone assignment (`VAR=val` or `arr[idx]=val`), execute it and return
    /// `Some(exit_code)`. Otherwise return `None`.
    fn try_assignment(&mut self, word: &str) -> Option<u8> {
        // `arr[idx]=value`
        if let Some(eq_pos) = word.find('=') {
            let lhs = &word[..eq_pos];
            let rhs = &word[eq_pos + 1..];
            if let Some((arr_name, subscript)) = parse_array_subscript(lhs) {
                if arr_name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    if let Ok(idx) = subscript.parse::<usize>() {
                        let val = rhs.to_string();
                        let arr_name = arr_name.to_string();
                        let entry = self.env.entry(arr_name).or_insert_with(|| ShellValue::Array(Vec::new()));
                        match entry {
                            ShellValue::Array(v) => {
                                if idx >= v.len() {
                                    v.resize(idx + 1, String::new());
                                }
                                v[idx] = val;
                            }
                            ShellValue::Scalar(_) => {
                                *entry = ShellValue::Array({
                                    let mut v = vec![String::new(); idx + 1];
                                    v[idx] = val;
                                    v
                                });
                            }
                        }
                        return Some(0);
                    }
                }
            }
            // `VAR=value` — plain scalar assignment
            if lhs.chars().all(|c| c.is_alphanumeric() || c == '_') && !lhs.is_empty() {
                self.env.insert(lhs.to_string(), ShellValue::Scalar(rhs.to_string()));
                return Some(0);
            }
        }
        None
    }

    pub(crate) fn is_builtin(name: &str) -> bool {
        matches!(name,
            "exit" | "echo" | "pwd" | "cd" | "export" | "unset" |
            "env" | "true" | "false" | "break" | "continue" |
            "return" | "source" | "." | "read" | "test" | "[" | "[[" |
            "declare" | "local" | "set" |
            "jobs" | "fg" | "bg" | "wait" | "disown" | "kill" | "trap"
        )
    }

    pub(crate) fn exec_pipeline_with_stdout(&mut self, pipeline: Pipeline, stdout: OutputHandle) -> u8 {
        let cmds = pipeline.commands;
        let n = cmds.len();
        if n == 0 { return 0; }

        if n == 1 {
            let cmd = cmds.into_iter().next().unwrap();
            let exit = match cmd {
                Command::Simple(sc) => self.dispatch_simple(sc, None, Some(stdout), None),
                Command::Group(list) => self.exec_list_with_stdout(list, stdout),
                Command::Subshell(list) => {
                    let saved_env = self.env.clone();
                    let saved_cwd = self.cwd.clone();
                    let saved_functions = self.functions.clone();
                    let saved_traps = self.traps.clone();
                    let saved_options = self.options.clone();
                    let saved_params = self.params.clone();
                    let saved_exit_requested = self.exit_requested;
                    let exit = self.exec_list_with_stdout(list, stdout);
                    self.env = saved_env;
                    self.cwd = saved_cwd;
                    self.functions = saved_functions;
                    self.traps = saved_traps;
                    self.options = saved_options;
                    self.params = saved_params;
                    self.exit_requested = saved_exit_requested;
                    exit
                }
                other => { self.rt.pipe_close_write(stdout); self.exec_compound(other) }
            };
            return if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit };
        }

        // Multi-command pipeline: internal pipes + last stage → provided stdout
        let mut pipe_read_ends: Vec<Option<InputHandle>> = Vec::with_capacity(n);
        let mut pipe_write_ends: Vec<Option<OutputHandle>> = Vec::with_capacity(n);
        pipe_read_ends.push(None);
        for _ in 0..n - 1 {
            let (inp, out) = self.rt.create_pipe();
            pipe_read_ends.push(Some(inp));
            pipe_write_ends.push(Some(out));
        }
        pipe_write_ends.push(Some(stdout));

        let env_list = self.env_list();
        let mut processes: Vec<ProcessHandle> = Vec::new();
        let mut last_builtin_exit: Option<u8> = None;

        for (i, command) in cmds.into_iter().enumerate() {
            let cmd = match command {
                Command::Simple(sc) => sc,
                other => {
                    let exit = self.exec_compound(other);
                    if i == n - 1 { last_builtin_exit = Some(exit); }
                    continue;
                }
            };
            let stdin_opt = pipe_read_ends[i].take();
            let stdout_opt = pipe_write_ends[i].take();
            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| self.expand_word_to_args(w))
                .collect();
            if args.is_empty() { continue; }
            let name = args[0].clone();
            if let Some(body) = self.functions.get(&name).cloned() {
                let exit = self.exec_function_call(&args[1..], body);
                if i == n - 1 { last_builtin_exit = Some(exit); }
            } else if Self::is_builtin(&name) {
                let exit = self.exec_builtin(&name, &args[1..], stdin_opt, stdout_opt);
                if self.exit_requested {
                    for p in processes {
                        let _ = self.rt.wait(&p);
                    }
                    return exit;
                }
                if i == n - 1 { last_builtin_exit = Some(exit); }
            } else {
                let opts = SpawnOpts {
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: None,
                };
                match self.rt.spawn(&name, &args[1..], opts) {
                    Ok(proc) => processes.push(proc),
                    Err(_) => {
                        self.rt.write_stderr(&format!("msh: {}: command not found\n", name));
                        for p in processes {
                            let _ = self.rt.wait(&p);
                        }
                        return if pipeline.negate { 0 } else { 127 };
                    }
                }
            }
        }

        let last_proc = processes.pop();
        for p in processes {
            let _ = self.rt.wait(&p);
        }
        let exit = if let Some(p) = last_proc { self.rt.wait(&p) }
                   else { last_builtin_exit.unwrap_or(self.last_exit) };
        if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit }
    }

    pub(crate) fn run_trap(&mut self, signal: &str) {
        if let Some(handler) = self.traps.get(signal).cloned() {
            if !handler.is_empty() {
                let mut parser = Parser::new(&handler);
                if let Some(list) = parser.parse() {
                    self.exec_list(list);
                }
            }
        }
    }

    pub(crate) fn env_list(&self) -> Vec<(String, String)> {
        self.env.iter().map(|(k, v)| (k.clone(), v.as_scalar().to_string())).collect()
    }

    pub(crate) fn resolve_path(&self, path: &str) -> String {
        let home = self.env.get("HOME").map(|v| v.as_scalar()).unwrap_or("/");
        let expanded = expand_tilde(path, home);
        let base = if expanded.starts_with('/') {
            expanded
        } else {
            format!("{}/{}", self.cwd.trim_end_matches('/'), expanded)
        };
        normalize_path(&base)
    }

    pub(crate) fn check_background_jobs(&mut self) {
        let mut done_ids: Vec<(usize, String, u8)> = Vec::new();
        for job in self.jobs.iter() {
            if job.status != crate::jobs::JobStatus::Running { continue; }
            if let Some(proc) = job.processes.last() {
                if let Some(exit_code) = self.rt.try_wait(proc) {
                    done_ids.push((job.id, job.command.clone(), exit_code));
                }
            }
        }
        for (id, cmd, exit_code) in &done_ids {
            if self.is_interactive {
                self.rt.write_stderr(&format!("[{}]+ Done ({})             {}\n", id, exit_code, cmd));
            }
            self.jobs.remove(*id);
        }
    }
}

pub(crate) fn signal_name_from_num(num: u8) -> &'static str {
    match num {
        2 => "INT",
        9 => "KILL",
        15 => "TERM",
        18 => "CONT",
        20 => "TSTP",
        _ => "",
    }
}
