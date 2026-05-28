use std::collections::HashMap;

use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{InputStream, OutputStream, SpawnOptions};
use crate::bindings::wasi::cli::{environment, terminal_stdin};
use crate::brace::expand_braces;
use crate::executor::expansion::{
    expand_tilde, has_glob, glob_match, glob_replace_first, glob_replace_all,
    remove_shortest_prefix, remove_longest_prefix, remove_shortest_suffix, remove_longest_suffix,
    shell_substring, split_var_and_op, literal_text, normalize_path,
};
use crate::io::{self, LineReader};
use crate::parser::{ArrayAssign, Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};
use crate::value::ShellValue;
use crate::jobs::{JobTable, JobStatus};

pub struct Shell {
    env: HashMap<String, ShellValue>,
    cwd: String,
    last_exit: u8,
    is_interactive: bool,
    exit_requested: bool,
    reader: LineReader,
    functions: HashMap<String, Command>,
    break_depth: usize,
    continue_depth: usize,
    return_requested: bool,
    in_loop_depth: usize,
    in_function_depth: usize,
    procsub_counter: u64,
    procsub_paths: Vec<String>,
    jobs: JobTable,
    traps: HashMap<String, String>,
    foreground_pids: Vec<u32>,
}

impl Shell {
    pub fn new() -> Self {
        let env: HashMap<String, ShellValue> = environment::get_environment()
            .into_iter()
            .map(|(k, v)| (k, ShellValue::Scalar(v)))
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
        }
    }

    pub fn run(&mut self) -> u8 {
        if self.is_interactive {
            io::write_stdout("mithic shell v0.1.0\n");
        }

        let mut input_buf = String::new();

        loop {
            if self.is_interactive {
                let prompt = if input_buf.is_empty() {
                    format!("{}$ ", self.cwd)
                } else {
                    "> ".to_string()
                };
                io::write_stdout(&prompt);
            }

            let line = match self.reader.read_line() {
                Some(l) => l,
                None => {
                    // EOF: try to parse whatever is buffered
                    if !input_buf.is_empty() {
                        let trimmed = input_buf.trim().to_string();
                        if !trimmed.is_empty() {
                            let mut parser = Parser::new(&trimmed);
                            if let Some(list) = parser.parse() {
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

    fn exec_list(&mut self, list: List) -> u8 {
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
            }

            skip_next = match op {
                Some(ListOp::And) => exit != 0,
                Some(ListOp::Or) => exit == 0,
                _ => false,
            };
        }

        exit
    }

    fn exec_pipeline_background(&mut self, pipeline: Pipeline) {
        let cmds = pipeline.commands;
        let n = cmds.len();
        if n == 0 { return; }

        if n == 1 {
            let cmd = cmds.into_iter().next().unwrap();
            match cmd {
                Command::Simple(sc) => {
                    let args: Vec<String> = sc.words.iter()
                        .flat_map(|w| self.expand_word_to_args(w))
                        .collect();
                    if args.is_empty() { return; }
                    let name = args[0].clone();
                    let display = args.join(" ");

                    if Self::is_builtin(&name) || self.functions.contains_key(&name) {
                        self.dispatch_simple(sc, None, None, None);
                        return;
                    }

                    let mut stdin_opt: Option<InputStream> = None;
                    let mut stdout_opt: Option<OutputStream> = None;
                    let mut stderr_opt: Option<OutputStream> = None;
                    if !self.apply_redirects(&sc.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                        return;
                    }

                    let env_list = self.env_list();
                    let opts = SpawnOptions {
                        cwd: None,
                        env: Some(env_list),
                        stdin: stdin_opt,
                        stdout: stdout_opt,
                        stderr: stderr_opt,
                    };
                    match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                        Ok(proc) => {
                            let pid = proc.pid();
                            let job_id = self.jobs.add(vec![proc], display);
                            io::write_stderr(&format!("[{}] {}\n", job_id, pid));
                            self.env.insert("!".to_string(), ShellValue::Scalar(pid.to_string()));
                        }
                        Err(_) => {
                            io::write_stderr(&format!("msh: {}: command not found\n", name));
                        }
                    }
                }
                other => { self.exec_compound(other); }
            }
        } else {
            let mut pipe_read_ends: Vec<Option<InputStream>> = Vec::with_capacity(n);
            let mut pipe_write_ends: Vec<Option<OutputStream>> = Vec::with_capacity(n);
            pipe_read_ends.push(None);
            for _ in 0..n - 1 {
                let (inp, out) = proc_manager::create_pipe();
                pipe_read_ends.push(Some(inp));
                pipe_write_ends.push(Some(out));
            }
            pipe_write_ends.push(None);

            let env_list = self.env_list();
            let mut processes: Vec<crate::bindings::mithic::process::types::Process> = Vec::new();
            let mut display_parts: Vec<String> = Vec::new();

            for (i, command) in cmds.into_iter().enumerate() {
                let cmd = match command {
                    Command::Simple(sc) => sc,
                    _ => continue,
                };
                let mut stdin_opt = pipe_read_ends[i].take();
                let mut stdout_opt = pipe_write_ends[i].take();
                let args: Vec<String> = cmd.words.iter()
                    .flat_map(|w| self.expand_word_to_args(w))
                    .collect();
                if args.is_empty() { continue; }
                let name = args[0].clone();
                display_parts.push(args.join(" "));
                let mut stderr_opt: Option<OutputStream> = None;
                if !self.apply_redirects(&cmd.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                    continue;
                }
                let opts = SpawnOptions {
                    cwd: None,
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: stderr_opt,
                };
                match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                    Ok(proc) => processes.push(proc),
                    Err(_) => {
                        io::write_stderr(&format!("msh: {}: command not found\n", name));
                    }
                }
            }

            if !processes.is_empty() {
                let last_pid = processes.last().map(|p| p.pid()).unwrap_or(0);
                let display = display_parts.join(" | ");
                let job_id = self.jobs.add(processes, display);
                io::write_stderr(&format!("[{}] {}\n", job_id, last_pid));
                self.env.insert("!".to_string(), ShellValue::Scalar(last_pid.to_string()));
            }
        }
    }

    fn exec_pipeline(&mut self, pipeline: Pipeline) -> u8 {
        let cmds = pipeline.commands;
        let n = cmds.len();

        if n == 0 {
            return 0;
        }

        if n == 1 {
            let cmd = cmds.into_iter().next().unwrap();
            let exit = match cmd {
                Command::Simple(sc) => self.dispatch_simple(sc, None, None, None),
                other => self.exec_compound(other),
            };
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
                other => {
                    let exit = self.exec_compound(other);
                    if i == n - 1 { last_builtin_exit = Some(exit); }
                    continue;
                }
            };
            let mut stdin_opt = pipe_read_ends[i].take();
            let mut stdout_opt = pipe_write_ends[i].take();

            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| self.expand_word_to_args(w))
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
            if let Some(body) = self.functions.get(&name).cloned() {
                let exit = self.exec_function_call(&args[1..], body);
                if i == n - 1 {
                    last_builtin_exit = Some(exit);
                }
            } else if Self::is_builtin(&name) {
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

        self.foreground_pids = processes.iter().map(|p| p.pid()).collect();

        let last_proc = processes.pop();
        for p in processes { let _ = p.wait(); }
        let exit = if let Some(p) = last_proc {
            p.wait() as u8
        } else {
            last_builtin_exit.unwrap_or(self.last_exit)
        };

        self.foreground_pids.clear();
        if exit >= 128 {
            let sig_name = signal_name_from_num(exit - 128);
            if !sig_name.is_empty() {
                self.run_trap(sig_name);
            }
        }
        if pipeline.negate { if exit == 0 { 1 } else { 0 } } else { exit }
    }

    fn dispatch_simple(
        &mut self,
        cmd: SimpleCommand,
        mut stdin: Option<InputStream>,
        mut stdout: Option<OutputStream>,
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
        let mut stderr_opt: Option<OutputStream> = None;
        if !self.apply_redirects(&cmd.redirects, &mut stdin, &mut stdout, &mut stderr_opt) {
            return 1;
        }

        if args.is_empty() {
            return 0;
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
            let opts = SpawnOptions {
                cwd: None,
                env: Some(env),
                stdin,
                stdout,
                stderr: stderr_opt,
            };
            match proc_manager::spawn(&name, &args[1..], Some(opts)) {
                Ok(proc) => {
                    self.foreground_pids = vec![proc.pid()];
                    let exit = proc.wait() as u8;
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
                    io::write_stderr(&format!("msh: {}: command not found\n", name));
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

    fn is_builtin(name: &str) -> bool {
        matches!(name,
            "exit" | "echo" | "pwd" | "cd" | "export" | "unset" |
            "env" | "true" | "false" | "break" | "continue" |
            "return" | "source" | "." | "read" | "test" | "[" | "[[" |
            "declare" | "local" |
            "jobs" | "fg" | "bg" | "wait" | "disown" | "kill" | "trap"
        )
    }

    fn exec_builtin(
        &mut self,
        name: &str,
        args: &[String],
        stdin: Option<InputStream>,
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
                    .unwrap_or_else(|| self.env.get("HOME").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "/".to_string()));
                let resolved = self.resolve_path(&target);
                self.cwd = resolved;
                self.env.insert("PWD".to_string(), ShellValue::Scalar(self.cwd.clone()));
                0
            }
            "export" => {
                for arg in args {
                    if let Some((key, value)) = arg.split_once('=') {
                        self.env.insert(key.to_string(), ShellValue::Scalar(value.to_string()));
                    }
                }
                0
            }
            "unset" => {
                for arg in args {
                    if let Some((name, subscript)) = parse_array_subscript(arg) {
                        if let Some(ShellValue::Array(v)) = self.env.get_mut(name) {
                            if let Ok(idx) = subscript.parse::<i64>() {
                                let actual = if idx < 0 {
                                    (v.len() as i64 + idx).max(0) as usize
                                } else {
                                    idx as usize
                                };
                                if actual < v.len() {
                                    v[actual] = String::new();
                                }
                            }
                        }
                    } else {
                        self.env.remove(arg.as_str());
                    }
                }
                0
            }
            "env" => {
                for (key, value) in &self.env {
                    write_out!(&format!("{}={}\n", key, value.as_scalar()));
                }
                0
            }
            "true" => 0,
            "false" => 1,
            "break" => {
                if self.in_loop_depth == 0 {
                    io::write_stderr("msh: break: only meaningful in a loop\n");
                    return 1;
                }
                let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
                self.break_depth = n;
                0
            }
            "continue" => {
                if self.in_loop_depth == 0 {
                    io::write_stderr("msh: continue: only meaningful in a loop\n");
                    return 1;
                }
                let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
                self.continue_depth = n;
                0
            }
            "return" => {
                if self.in_function_depth == 0 {
                    io::write_stderr("msh: return: can only return from a function or sourced script\n");
                    return 1;
                }
                let code: u8 = args.first().and_then(|s| s.parse().ok()).unwrap_or(self.last_exit);
                self.return_requested = true;
                code
            }
            "source" | "." => {
                let file = match args.first() {
                    Some(f) => f.clone(),
                    None => {
                        io::write_stderr("msh: source: filename argument required\n");
                        return 2;
                    }
                };
                self.exec_source(&file)
            }
            "read" => {
                self.exec_read(args, stdin)
            }
            "test" | "[" => {
                let test_args: &[String] = if name == "[" {
                    if args.last().map(|s| s.as_str()) == Some("]") {
                        &args[..args.len() - 1]
                    } else {
                        io::write_stderr("msh: [: missing `]'\n");
                        return 2;
                    }
                } else {
                    args
                };
                if self.eval_test(test_args) { 0 } else { 1 }
            }
            "[[" => {
                if self.eval_extended_test(args) { 0 } else { 1 }
            }
            "declare" | "local" => {
                self.exec_declare(args)
            }
            "jobs" => {
                for job in self.jobs.iter() {
                    let marker = if self.jobs.current_id() == Some(job.id) { "+" } else { "-" };
                    let status_str = match job.status {
                        JobStatus::Running => "Running",
                        JobStatus::Stopped => "Stopped",
                        JobStatus::Done(_) => "Done",
                    };
                    let line = format!("[{}]{} {:24}{}\n", job.id, marker, status_str, job.command);
                    write_out!(&line);
                }
                0
            }
            "fg" => {
                let job_id = match self.resolve_job_id(args) {
                    Ok(id) => id,
                    Err(msg) => { io::write_stderr(&msg); return 1; }
                };

                let job = match self.jobs.get_mut(job_id) {
                    Some(j) => j,
                    None => {
                        io::write_stderr(&format!("msh: fg: %{}: no such job\n", job_id));
                        return 1;
                    }
                };

                io::write_stderr(&format!("{}\n", job.command));

                if job.status == JobStatus::Stopped {
                    for proc in &job.processes {
                        let _ = proc.kill(crate::bindings::mithic::process::types::Signal::Sigcont);
                    }
                    job.status = JobStatus::Running;
                }

                let mut job = self.jobs.remove(job_id).unwrap();
                self.foreground_pids = job.pids.clone();

                let last = job.processes.pop();
                for p in job.processes { let _ = p.wait(); }
                let exit = if let Some(p) = last { p.wait() as u8 } else { 0 };

                self.foreground_pids.clear();
                if exit >= 128 {
                    let sig_name = signal_name_from_num(exit - 128);
                    if !sig_name.is_empty() {
                        self.run_trap(sig_name);
                    }
                }
                exit
            }
            "bg" => {
                let job_id = match self.resolve_job_id(args) {
                    Ok(id) => id,
                    Err(msg) => { io::write_stderr(&msg); return 1; }
                };

                let job = match self.jobs.get_mut(job_id) {
                    Some(j) => j,
                    None => {
                        io::write_stderr(&format!("msh: bg: %{}: no such job\n", job_id));
                        return 1;
                    }
                };

                if job.status == JobStatus::Stopped {
                    for proc in &job.processes {
                        let _ = proc.kill(crate::bindings::mithic::process::types::Signal::Sigcont);
                    }
                    job.status = JobStatus::Running;
                    io::write_stderr(&format!("[{}]+ {} &\n", job.id, job.command));
                }
                0
            }
            "wait" => {
                if args.is_empty() {
                    let ids: Vec<usize> = self.jobs.iter().map(|j| j.id).collect();
                    let mut last_exit = 0u8;
                    for id in ids {
                        if let Some(mut job) = self.jobs.remove(id) {
                            let last = job.processes.pop();
                            for p in job.processes { let _ = p.wait(); }
                            if let Some(p) = last {
                                last_exit = p.wait() as u8;
                            }
                        }
                    }
                    last_exit
                } else {
                    let job_id = match self.resolve_job_id(args) {
                        Ok(id) => id,
                        Err(msg) => { io::write_stderr(&msg); return 127; }
                    };
                    if let Some(mut job) = self.jobs.remove(job_id) {
                        let last = job.processes.pop();
                        for p in job.processes { let _ = p.wait(); }
                        if let Some(p) = last { p.wait() as u8 } else { 0 }
                    } else {
                        io::write_stderr(&format!("msh: wait: %{}: no such job\n", job_id));
                        127
                    }
                }
            }
            "disown" => {
                let job_id = match self.resolve_job_id(args) {
                    Ok(id) => id,
                    Err(msg) => { io::write_stderr(&msg); return 1; }
                };
                if self.jobs.remove(job_id).is_none() {
                    io::write_stderr(&format!("msh: disown: %{}: no such job\n", job_id));
                    return 1;
                }
                0
            }
            "kill" => {
                use crate::bindings::mithic::process::types::Signal;
                let mut signal = Signal::Sigterm;
                let mut targets: Vec<String> = Vec::new();

                for arg in args {
                    if let Some(sig) = parse_signal_flag(arg) {
                        signal = sig;
                    } else {
                        targets.push(arg.clone());
                    }
                }

                if targets.is_empty() {
                    io::write_stderr("msh: kill: usage: kill [-signal] pid|%job ...\n");
                    return 1;
                }

                let mut exit = 0u8;
                for target in &targets {
                    if target.starts_with('%') {
                        let id_str = &target[1..];
                        if let Ok(id) = id_str.parse::<usize>() {
                            if let Some(job) = self.jobs.get(id) {
                                for proc in &job.processes {
                                    let _ = proc.kill(signal);
                                }
                            } else {
                                io::write_stderr(&format!("msh: kill: %{}: no such job\n", id));
                                exit = 1;
                            }
                        }
                    } else if let Ok(_pid) = target.parse::<u32>() {
                        let found = self.jobs.iter()
                            .find(|j| j.pids.contains(&_pid));
                        if let Some(job) = found {
                            for proc in &job.processes {
                                if proc.pid() == _pid {
                                    let _ = proc.kill(signal);
                                }
                            }
                        } else {
                            io::write_stderr(&format!("msh: kill: ({}) - No such process\n", _pid));
                            exit = 1;
                        }
                    }
                }
                exit
            }
            "trap" => {
                if args.is_empty() {
                    for (sig, handler) in &self.traps {
                        write_out!(&format!("trap -- '{}' {}\n", handler, sig));
                    }
                    return 0;
                }

                if args.len() == 1 && args[0] == "-" {
                    self.traps.clear();
                    return 0;
                }

                if args.len() < 2 {
                    io::write_stderr("msh: trap: usage: trap 'command' signal ...\n");
                    return 2;
                }

                let handler = &args[0];
                for sig_name in &args[1..] {
                    let normalized = if let Ok(num) = sig_name.parse::<u8>() {
                        signal_name_from_num(num).to_string()
                    } else {
                        let upper = sig_name.to_uppercase();
                        upper.strip_prefix("SIG").unwrap_or(&upper).to_string()
                    };
                    if normalized.is_empty() {
                        io::write_stderr(&format!("msh: trap: {}: invalid signal\n", sig_name));
                        continue;
                    }
                    if handler == "-" {
                        self.traps.remove(&normalized);
                    } else {
                        self.traps.insert(normalized, handler.clone());
                    }
                }
                0
            }
            _ => 127,
        }
    }

    fn exec_declare(&mut self, args: &[String]) -> u8 {
        let mut is_array = false;
        let mut print_mode = false;
        let mut remaining_args: Vec<&str> = Vec::new();

        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "-a" => is_array = true,
                "-p" => print_mode = true,
                arg if arg.starts_with('-') => {
                    // Unknown flag — ignore for now
                }
                _ => remaining_args.push(&args[i]),
            }
            i += 1;
        }

        if print_mode {
            for name in &remaining_args {
                match self.env.get(*name) {
                    Some(ShellValue::Scalar(s)) => {
                        io::write_stdout(&format!("declare -- {}=\"{}\"\n", name, s));
                    }
                    Some(ShellValue::Array(v)) => {
                        let elements: Vec<String> = v.iter().map(|e| format!("\"{}\"", e)).collect();
                        io::write_stdout(&format!("declare -a {}=({})\n", name, elements.join(" ")));
                    }
                    None => {
                        io::write_stderr(&format!("declare: {}: not found\n", name));
                    }
                }
            }
            return 0;
        }

        for arg in &remaining_args {
            if let Some((name, value)) = arg.split_once('=') {
                if is_array {
                    self.env.insert(name.to_string(), ShellValue::Array(vec![value.to_string()]));
                } else {
                    self.env.insert(name.to_string(), ShellValue::Scalar(value.to_string()));
                }
            } else if is_array {
                if !self.env.contains_key(*arg) {
                    self.env.insert(arg.to_string(), ShellValue::Array(Vec::new()));
                }
            }
        }
        0
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
            let cmd = cmds.into_iter().next().unwrap();
            let exit = match cmd {
                Command::Simple(sc) => self.dispatch_simple(sc, None, Some(stdout), None),
                other => { drop(stdout); self.exec_compound(other) }
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

    fn check_background_jobs(&mut self) {
        let mut done_ids: Vec<(usize, String)> = Vec::new();
        for job in self.jobs.iter() {
            if job.status != JobStatus::Running { continue; }
            if let Some(proc) = job.processes.last() {
                if proc.kill(crate::bindings::mithic::process::types::Signal::Signull).is_err() {
                    done_ids.push((job.id, job.command.clone()));
                }
            }
        }
        for (id, cmd) in &done_ids {
            if self.is_interactive {
                io::write_stderr(&format!("[{}]+ Done                    {}\n", id, cmd));
            }
            self.jobs.remove(*id);
        }
    }

    fn run_trap(&mut self, signal: &str) {
        if let Some(handler) = self.traps.get(signal).cloned() {
            if !handler.is_empty() {
                let mut parser = Parser::new(&handler);
                if let Some(list) = parser.parse() {
                    self.exec_list(list);
                }
            }
        }
    }

    fn resolve_job_id(&self, args: &[String]) -> Result<usize, String> {
        if let Some(arg) = args.first() {
            let id_str = arg.strip_prefix('%').unwrap_or(arg);
            match id_str.parse::<usize>() {
                Ok(id) => Ok(id),
                Err(_) => Err(format!("msh: {}: no such job\n", arg)),
            }
        } else {
            match self.jobs.current_id() {
                Some(id) => Ok(id),
                None => Err("msh: no current job\n".to_string()),
            }
        }
    }

    fn env_list(&self) -> Vec<(String, String)> {
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

    pub(crate) fn expand_word(&mut self, word: &Word) -> String {
        let parts: Vec<_> = word.parts().to_vec();
        parts.iter().map(|p| self.expand_part(p)).collect()
    }

    fn expand_word_to_args(&mut self, w: &Word) -> Vec<String> {
        // Special case: a word that is just ${arr[@]}, ${arr[*]}, $@, or $* should expand
        // to multiple words rather than a single space-joined string.
        if let Some(elements) = self.try_expand_array_all(w) {
            return elements;
        }

        let expanded = self.expand_word(w);
        // Only apply brace expansion when the word has unquoted parts containing braces.
        let has_unquoted_braces = w.parts().iter().any(|p| {
            matches!(p, WordPart::Literal(s) if s.contains('{') || s.contains('}'))
        });
        // Only apply glob expansion when the word has unquoted parts containing glob chars.
        let has_unquoted_globs = w.parts().iter().any(|p| {
            matches!(p, WordPart::Literal(s) if has_glob(s))
        });

        let brace_results = if has_unquoted_braces {
            expand_braces(&expanded)
        } else {
            vec![expanded]
        };
        brace_results.into_iter().flat_map(|s| {
            if has_unquoted_globs && has_glob(&s) { self.expand_glob(&s) } else { vec![s] }
        }).collect()
    }

    /// If the word is a standalone `${arr[@]}`, `${arr[*]}`, `$@`, or `$*`, return all elements
    /// as separate words. Returns `None` if the word isn't this pattern.
    fn try_expand_array_all(&self, w: &Word) -> Option<Vec<String>> {
        let parts = w.parts();
        if parts.len() != 1 {
            return None;
        }

        match &parts[0] {
            WordPart::BraceVar(raw) => {
                let (name, subscript) = parse_array_subscript(raw)?;
                if subscript != "@" && subscript != "*" {
                    return None;
                }
                match self.env.get(name) {
                    Some(ShellValue::Array(elements)) => Some(elements.clone()),
                    Some(ShellValue::Scalar(s)) => Some(vec![s.clone()]),
                    None => Some(Vec::new()),
                }
            }
            WordPart::Var(name) if name == "@" || name == "*" => {
                let val = self.env.get("@")
                    .map(|v| v.as_scalar().to_string())
                    .unwrap_or_default();
                if val.is_empty() {
                    Some(Vec::new())
                } else {
                    Some(val.split_whitespace().map(|s| s.to_string()).collect())
                }
            }
            _ => None,
        }
    }

    fn expand_part(&mut self, part: &WordPart) -> String {
        match part {
            WordPart::Literal(s) => {
                let home = self.env.get("HOME").map(|v| v.as_scalar()).unwrap_or("/");
                expand_tilde(s, home)
            }
            WordPart::Quoted(s) => s.clone(),
            WordPart::Var(name) => self.expand_var(name),
            WordPart::BraceVar(raw) => self.expand_brace_var(raw),
            WordPart::CmdSub(raw) => self.exec_capturing(raw),
            WordPart::ArithSub(expr) => self.eval_arithmetic(expr),
            WordPart::ProcSubIn(raw) => self.exec_proc_sub_in(raw),
            WordPart::ProcSubOut(raw) => self.exec_proc_sub_out(raw),
        }
    }

    #[cfg(not(test))]
    fn exec_proc_sub_in(&mut self, raw: &str) -> String {
        use crate::bindings::wasi::filesystem::types as fs_types;
        use fs_types::{DescriptorFlags, OpenFlags, PathFlags};

        let output = self.exec_capturing(raw);

        let tmp_path = format!("/tmp/.procsub_{}", self.next_id());

        let root = match get_root_descriptor() {
            Some(d) => d,
            None => return String::new(),
        };

        let _ = root.create_directory_at("tmp");

        let rel = tmp_path.trim_start_matches('/');
        if let Ok(fd) = root.open_at(
            PathFlags::empty(),
            rel,
            OpenFlags::CREATE | OpenFlags::TRUNCATE,
            DescriptorFlags::WRITE,
        ) {
            if let Ok(stream) = fd.write_via_stream(0) {
                let mut data = output.into_bytes();
                data.push(b'\n');
                let _ = stream.blocking_write_and_flush(&data);
            }
        }

        self.procsub_paths.push(tmp_path.clone());
        tmp_path
    }

    #[cfg(not(test))]
    fn exec_proc_sub_out(&mut self, _raw: &str) -> String {
        io::write_stderr("msh: >(cmd) process substitution not yet supported\n");
        String::new()
    }

    #[cfg(test)]
    fn exec_proc_sub_in(&mut self, _raw: &str) -> String {
        "/dev/fd/63".to_string()
    }

    #[cfg(test)]
    fn exec_proc_sub_out(&mut self, _raw: &str) -> String {
        "/dev/fd/62".to_string()
    }

    fn next_id(&mut self) -> u64 {
        self.procsub_counter += 1;
        self.procsub_counter
    }

    #[cfg(not(test))]
    fn cleanup_procsub_files(&self) {
        if let Some(root) = get_root_descriptor() {
            for path in &self.procsub_paths {
                let rel = path.trim_start_matches('/');
                let _ = root.unlink_file_at(rel);
            }
        }
    }

    #[cfg(test)]
    fn cleanup_procsub_files(&self) {}

    fn eval_arithmetic(&mut self, expr: &str) -> String {
        use std::cell::RefCell;

        let expanded_expr = self.expand_arith_vars(expr);

        let working: RefCell<std::collections::HashMap<String, i64>> = RefCell::new(
            self.env.iter()
                .map(|(k, v)| (k.clone(), v.as_scalar().parse::<i64>().unwrap_or(0)))
                .collect()
        );

        let lookup = |name: &str| -> i64 { *working.borrow().get(name).unwrap_or(&0) };
        let mut assign = |name: &str, val: i64| { working.borrow_mut().insert(name.to_string(), val); };
        let result = crate::arith::eval(&expanded_expr, &lookup, &mut assign);

        for (k, v) in working.into_inner() {
            let orig = self.env.get(&k)
                .map(|sv| sv.as_scalar().parse::<i64>().unwrap_or(0))
                .unwrap_or(0);
            if v != orig {
                self.env.insert(k, ShellValue::Scalar(v.to_string()));
            }
        }

        result.to_string()
    }

    fn expand_arith_vars(&self, expr: &str) -> String {
        let mut result = String::new();
        let chars: Vec<char> = expr.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '$' {
                i += 1;
                if i < chars.len() && chars[i] == '{' {
                    i += 1;
                    let start = i;
                    while i < chars.len() && chars[i] != '}' { i += 1; }
                    let name: String = chars[start..i].iter().collect();
                    result.push_str(self.env.get(&name).map(|v| v.as_scalar()).unwrap_or("0"));
                    if i < chars.len() { i += 1; }
                } else if i < chars.len() && (chars[i].is_alphabetic() || chars[i] == '_') {
                    let start = i;
                    while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') { i += 1; }
                    let name: String = chars[start..i].iter().collect();
                    result.push_str(self.env.get(&name).map(|v| v.as_scalar()).unwrap_or("0"));
                } else {
                    result.push('$');
                }
            } else {
                result.push(chars[i]);
                i += 1;
            }
        }
        result
    }

    fn expand_var(&self, name: &str) -> String {
        match name {
            "?" => self.last_exit.to_string(),
            "#" => self.env.get("#").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "0".to_string()),
            "@" | "*" => self.env.get("@").map(|v| v.as_scalar().to_string()).unwrap_or_default(),
            _ => self.env.get(name).map(|v| v.as_scalar().to_string()).unwrap_or_default(),
        }
    }

    fn expand_brace_var(&self, raw: &str) -> String {
        // ${#arr[@]} or ${#arr[*]} — array length
        if let Some(inner) = raw.strip_prefix('#') {
            if let Some((arr_name, subscript)) = parse_array_subscript(inner) {
                if subscript == "@" || subscript == "*" {
                    return match self.env.get(arr_name) {
                        Some(v) => v.len().to_string(),
                        None => "0".to_string(),
                    };
                }
                // ${#arr[n]} — length of element at index (supports negative indices)
                if let Ok(idx) = subscript.parse::<i64>() {
                    return match self.env.get(arr_name) {
                        Some(v) => {
                            let actual_idx = if idx < 0 {
                                (v.len() as i64 + idx).max(0) as usize
                            } else {
                                idx as usize
                            };
                            v.index(actual_idx).len().to_string()
                        }
                        None => "0".to_string(),
                    };
                }
            }
            // ${#VAR} — length of scalar variable
            return self.expand_var(inner).len().to_string();
        }

        // ${arr[@]} or ${arr[*]} — all elements space-joined
        // ${arr[n]} — single element at index n
        if let Some((arr_name, subscript)) = parse_array_subscript(raw) {
            return match self.env.get(arr_name) {
                Some(v) => {
                    if subscript == "@" || subscript == "*" {
                        v.all_elements()
                    } else if let Ok(idx) = subscript.parse::<i64>() {
                        let actual_idx = if idx < 0 {
                            (v.len() as i64 + idx).max(0) as usize
                        } else {
                            idx as usize
                        };
                        v.index(actual_idx).to_string()
                    } else {
                        String::new()
                    }
                }
                None => String::new(),
            };
        }

        // Split into variable name and operator+pattern
        let (var_name, op_and_rest) = split_var_and_op(raw);

        // ${VAR//pat/rep} — replace all occurrences (glob-based)
        if let Some(pat_rep) = op_and_rest.strip_prefix("//") {
            let val = self.expand_var(var_name);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_all(&val, pat, rep);
        }

        // ${VAR/pat/rep} — replace first occurrence (glob-based)
        if let Some(pat_rep) = op_and_rest.strip_prefix('/') {
            let val = self.expand_var(var_name);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_first(&val, pat, rep);
        }

        // ${VAR##pat} — remove longest matching prefix (check before single #)
        if let Some(pat) = op_and_rest.strip_prefix("##") {
            let val = self.expand_var(var_name);
            return remove_longest_prefix(&val, pat);
        }

        // ${VAR#pat} — remove shortest matching prefix
        if let Some(pat) = op_and_rest.strip_prefix('#') {
            let val = self.expand_var(var_name);
            return remove_shortest_prefix(&val, pat);
        }

        // ${VAR%%pat} — remove longest matching suffix (check before single %)
        if let Some(pat) = op_and_rest.strip_prefix("%%") {
            let val = self.expand_var(var_name);
            return remove_longest_suffix(&val, pat);
        }

        // ${VAR%pat} — remove shortest matching suffix
        if let Some(pat) = op_and_rest.strip_prefix('%') {
            let val = self.expand_var(var_name);
            return remove_shortest_suffix(&val, pat);
        }

        // ${VAR:...} — substring or default/alternate
        if let Some(colon_rest) = op_and_rest.strip_prefix(':') {
            // ${VAR:-default} — default if empty
            if let Some(default) = colon_rest.strip_prefix('-') {
                let val = self.expand_var(var_name);
                return if val.is_empty() { default.to_string() } else { val };
            }
            // ${VAR:+alt} — alternate if not empty
            if let Some(alt) = colon_rest.strip_prefix('+') {
                let val = self.expand_var(var_name);
                return if val.is_empty() { String::new() } else { alt.to_string() };
            }
            // ${VAR:offset} or ${VAR:offset:length} — substring (digit or minus sign)
            if colon_rest.starts_with(|c: char| c.is_ascii_digit() || c == '-') {
                let val = self.expand_var(var_name);
                return shell_substring(&val, colon_rest);
            }
        }

        // Plain ${VAR} — but use raw if var_name is empty (shouldn't happen) or op is empty
        if op_and_rest.is_empty() {
            self.expand_var(var_name)
        } else {
            // Fallback: treat entire raw as a variable name
            self.expand_var(raw)
        }
    }

    #[cfg(not(test))]
    fn expand_glob(&self, pattern: &str) -> Vec<String> {
        use crate::bindings::wasi::filesystem::types as fs_types;
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

        let root_desc = match get_root_descriptor() {
            Some(d) => d,
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

    fn exec_compound(&mut self, cmd: Command) -> u8 {
        match cmd {
            Command::Simple(sc) => self.dispatch_simple(sc, None, None, None),
            Command::If(ic) => self.exec_if(ic),
            Command::While(wc) => self.exec_while(wc),
            Command::Until(wc) => self.exec_until(wc),
            Command::For(fc) => self.exec_for(fc),
            Command::Case(cc) => self.exec_case(cc),
            Command::FunctionDef(fd) => {
                self.functions.insert(fd.name, *fd.body);
                0
            }
            Command::Group(list) => self.exec_list(list),
            Command::Subshell(list) => self.exec_list(list),
            Command::ArrayAssign(aa) => self.exec_array_assign(aa),
            Command::Arithmetic(expr) => {
                let result_str = self.eval_arithmetic(&expr);
                let n: i64 = result_str.parse().unwrap_or(0);
                if n != 0 { 0 } else { 1 }
            }
        }
    }

    fn exec_array_assign(&mut self, aa: ArrayAssign) -> u8 {
        let elements: Vec<String> = aa.elements.iter()
            .flat_map(|w| self.expand_word_to_args(w))
            .collect();

        if aa.append {
            let existing = match self.env.get(&aa.name) {
                Some(ShellValue::Array(v)) => v.clone(),
                Some(ShellValue::Scalar(s)) if !s.is_empty() => vec![s.clone()],
                _ => Vec::new(),
            };
            let mut combined = existing;
            combined.extend(elements);
            self.env.insert(aa.name, ShellValue::Array(combined));
        } else {
            self.env.insert(aa.name, ShellValue::Array(elements));
        }
        0
    }

    fn exec_if(&mut self, cmd: crate::parser::IfCommand) -> u8 {
        let cond_exit = self.exec_list(cmd.condition);
        if cond_exit == 0 {
            return self.exec_list(cmd.then_body);
        }

        for (elif_cond, elif_body) in cmd.elifs {
            let elif_exit = self.exec_list(elif_cond);
            if elif_exit == 0 {
                return self.exec_list(elif_body);
            }
        }

        if let Some(else_body) = cmd.else_body {
            return self.exec_list(else_body);
        }

        cond_exit
    }

    fn exec_while(&mut self, cmd: crate::parser::WhileCommand) -> u8 {
        self.in_loop_depth += 1;
        let mut exit = 0u8;
        loop {
            let cond = self.exec_list(cmd.condition.clone());
            if cond != 0 { break; }
            exit = self.exec_list(cmd.body.clone());
            if self.exit_requested || self.return_requested { break; }
            if self.break_depth > 0 {
                self.break_depth -= 1;
                break;
            }
            if self.continue_depth > 0 {
                self.continue_depth -= 1;
            }
        }
        self.in_loop_depth -= 1;
        exit
    }

    fn exec_until(&mut self, cmd: crate::parser::WhileCommand) -> u8 {
        self.in_loop_depth += 1;
        let mut exit = 0u8;
        loop {
            let cond = self.exec_list(cmd.condition.clone());
            if cond == 0 { break; }
            exit = self.exec_list(cmd.body.clone());
            if self.exit_requested || self.return_requested { break; }
            if self.break_depth > 0 {
                self.break_depth -= 1;
                break;
            }
            if self.continue_depth > 0 {
                self.continue_depth -= 1;
            }
        }
        self.in_loop_depth -= 1;
        exit
    }

    fn exec_for(&mut self, cmd: crate::parser::ForCommand) -> u8 {
        let items: Vec<String> = match cmd.words {
            Some(words) => words.iter()
                .flat_map(|w| self.expand_word_to_args(w))
                .collect(),
            None => {
                let at = self.env.get("@").map(|v| v.as_scalar().to_string()).unwrap_or_default();
                if at.is_empty() {
                    Vec::new()
                } else {
                    at.split_whitespace().map(|s| s.to_string()).collect()
                }
            }
        };

        self.in_loop_depth += 1;
        let mut exit = 0u8;
        for item in items {
            self.env.insert(cmd.var.clone(), ShellValue::Scalar(item));
            exit = self.exec_list(cmd.body.clone());
            self.last_exit = exit;
            if self.exit_requested || self.return_requested { break; }
            if self.break_depth > 0 {
                self.break_depth -= 1;
                break;
            }
            if self.continue_depth > 0 {
                self.continue_depth -= 1;
            }
        }
        self.in_loop_depth -= 1;
        exit
    }

    fn exec_case(&mut self, cmd: crate::parser::CaseCommand) -> u8 {
        let value = self.expand_word(&cmd.word);

        for arm in cmd.arms {
            let matched = arm.patterns.iter().any(|pat| {
                let pattern = self.expand_word(pat);
                glob_match(&pattern, &value)
            });
            if matched {
                return self.exec_list(arm.body);
            }
        }
        0
    }

    fn exec_function_call(&mut self, args: &[String], body: Command) -> u8 {
        let old_hash = self.env.get("#").map(|v| v.as_scalar().to_string());
        let old_at = self.env.get("@").map(|v| v.as_scalar().to_string());
        let mut old_positional: Vec<(String, Option<String>)> = Vec::new();
        for (i, arg) in args.iter().enumerate() {
            let key = (i + 1).to_string();
            old_positional.push((key.clone(), self.env.get(&key).map(|v| v.as_scalar().to_string())));
            self.env.insert(key, ShellValue::Scalar(arg.clone()));
        }
        self.env.insert("#".to_string(), ShellValue::Scalar(args.len().to_string()));
        self.env.insert("@".to_string(), ShellValue::Scalar(args.join(" ")));

        self.in_function_depth += 1;
        let exit = self.exec_compound(body);
        self.in_function_depth -= 1;
        self.return_requested = false;

        for (key, old_val) in old_positional {
            match old_val {
                Some(v) => { self.env.insert(key, ShellValue::Scalar(v)); }
                None => { self.env.remove(&key); }
            };
        }
        let mut i = args.len() + 1;
        loop {
            let key = i.to_string();
            if self.env.remove(&key).is_none() { break; }
            i += 1;
        }
        match old_hash {
            Some(v) => { self.env.insert("#".to_string(), ShellValue::Scalar(v)); }
            None => { self.env.remove("#"); }
        };
        match old_at {
            Some(v) => { self.env.insert("@".to_string(), ShellValue::Scalar(v)); }
            None => { self.env.remove("@"); }
        };

        exit
    }

    fn eval_test(&self, args: &[String]) -> bool {
        if args.is_empty() { return false; }

        if args[0] == "!" {
            return !self.eval_test(&args[1..]);
        }

        if args.len() == 1 {
            return !args[0].is_empty();
        }

        if args.len() == 2 {
            let op = args[0].as_str();
            let val = &args[1];
            return match op {
                "-z" => val.is_empty(),
                "-n" => !val.is_empty(),
                "-e" | "-f" | "-d" | "-r" | "-w" | "-x" => self.test_file(op, val),
                _ => false,
            };
        }

        if args.len() == 3 {
            let left = &args[0];
            let op = args[1].as_str();
            let right = &args[2];
            return match op {
                "=" | "==" => left == right,
                "!=" => left != right,
                "-eq" => self.parse_int(left) == self.parse_int(right),
                "-ne" => self.parse_int(left) != self.parse_int(right),
                "-lt" => self.parse_int(left) < self.parse_int(right),
                "-gt" => self.parse_int(left) > self.parse_int(right),
                "-le" => self.parse_int(left) <= self.parse_int(right),
                "-ge" => self.parse_int(left) >= self.parse_int(right),
                "-a" => self.eval_test(&args[..1]) && self.eval_test(&args[2..]),
                "-o" => self.eval_test(&args[..1]) || self.eval_test(&args[2..]),
                _ => false,
            };
        }

        for i in 0..args.len() {
            if args[i] == "-a" {
                return self.eval_test(&args[..i]) && self.eval_test(&args[i+1..]);
            }
        }
        for i in 0..args.len() {
            if args[i] == "-o" {
                return self.eval_test(&args[..i]) || self.eval_test(&args[i+1..]);
            }
        }

        false
    }

    fn parse_int(&self, s: &str) -> i64 {
        s.parse().unwrap_or(0)
    }

    #[cfg(not(test))]
    fn test_file(&self, op: &str, path: &str) -> bool {
        use crate::bindings::wasi::filesystem::types::{DescriptorFlags, DescriptorType, OpenFlags, PathFlags};

        let resolved = self.resolve_path(path);
        let rel = resolved.trim_start_matches('/');

        let root = match get_root_descriptor() {
            Some(d) => d,
            None => return false,
        };

        match op {
            "-e" | "-r" | "-w" | "-x" => {
                root.open_at(PathFlags::SYMLINK_FOLLOW, rel, OpenFlags::empty(), DescriptorFlags::READ).is_ok()
            }
            "-f" => {
                match root.open_at(PathFlags::SYMLINK_FOLLOW, rel, OpenFlags::empty(), DescriptorFlags::READ) {
                    Ok(desc) => matches!(desc.get_type(), Ok(DescriptorType::RegularFile)),
                    Err(_) => false,
                }
            }
            "-d" => {
                match root.open_at(PathFlags::SYMLINK_FOLLOW, rel, OpenFlags::DIRECTORY, DescriptorFlags::READ) {
                    Ok(desc) => matches!(desc.get_type(), Ok(DescriptorType::Directory)),
                    Err(_) => false,
                }
            }
            _ => false,
        }
    }

    #[cfg(test)]
    fn test_file(&self, _op: &str, _path: &str) -> bool { false }

    fn eval_extended_test(&self, args: &[String]) -> bool {
        if args.is_empty() { return false; }

        if args[0] == "!" {
            return !self.eval_extended_test(&args[1..]);
        }

        for i in 0..args.len() {
            if args[i] == "&&" {
                return self.eval_extended_test(&args[..i]) && self.eval_extended_test(&args[i+1..]);
            }
        }
        for i in 0..args.len() {
            if args[i] == "||" {
                return self.eval_extended_test(&args[..i]) || self.eval_extended_test(&args[i+1..]);
            }
        }

        if args.len() == 1 {
            return !args[0].is_empty();
        }

        if args.len() == 2 {
            return match args[0].as_str() {
                "-z" => args[1].is_empty(),
                "-n" => !args[1].is_empty(),
                "-e" | "-f" | "-d" | "-r" | "-w" | "-x" => self.test_file(&args[0], &args[1]),
                _ => false,
            };
        }

        if args.len() == 3 {
            let left = &args[0];
            let op = args[1].as_str();
            let right = &args[2];
            return match op {
                "==" | "=" => glob_match(right, left),
                "!=" => !glob_match(right, left),
                "<" => left < right,
                ">" => left > right,
                "-eq" => self.parse_int(left) == self.parse_int(right),
                "-ne" => self.parse_int(left) != self.parse_int(right),
                "-lt" => self.parse_int(left) < self.parse_int(right),
                "-gt" => self.parse_int(left) > self.parse_int(right),
                "-le" => self.parse_int(left) <= self.parse_int(right),
                "-ge" => self.parse_int(left) >= self.parse_int(right),
                _ => false,
            };
        }

        false
    }

    #[cfg(not(test))]
    fn exec_source(&mut self, file: &str) -> u8 {
        use crate::bindings::wasi::filesystem::types::{DescriptorFlags, OpenFlags, PathFlags};

        let path = self.resolve_path(file);
        let rel = path.trim_start_matches('/');

        let root = match get_root_descriptor() {
            Some(d) => d,
            None => {
                io::write_stderr(&format!("msh: source: {}: No such file or directory\n", file));
                return 1;
            }
        };

        let desc = match root.open_at(
            PathFlags::SYMLINK_FOLLOW, rel,
            OpenFlags::empty(), DescriptorFlags::READ,
        ) {
            Ok(d) => d,
            Err(_) => {
                io::write_stderr(&format!("msh: source: {}: No such file or directory\n", file));
                return 1;
            }
        };

        let stream = match desc.read_via_stream(0) {
            Ok(s) => s,
            Err(_) => return 1,
        };

        let mut contents = Vec::new();
        loop {
            match stream.blocking_read(4096) {
                Ok(bytes) if bytes.is_empty() => break,
                Ok(bytes) => contents.extend_from_slice(&bytes),
                Err(_) => break,
            }
        }

        let script = String::from_utf8_lossy(&contents);
        let mut parser = Parser::new(&script);
        if let Some(list) = parser.parse() {
            self.in_function_depth += 1;
            let result = self.exec_list(list);
            self.in_function_depth -= 1;
            self.return_requested = false;
            result
        } else {
            0
        }
    }

    #[cfg(test)]
    fn exec_source(&mut self, _file: &str) -> u8 { 0 }

    #[cfg(not(test))]
    fn exec_read(&mut self, args: &[String], stdin: Option<InputStream>) -> u8 {
        let mut var_names: Vec<&str> = Vec::new();
        let mut prompt = None;
        let mut raw = false;
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "-p" => {
                    i += 1;
                    if i < args.len() { prompt = Some(args[i].as_str()); }
                }
                "-r" => { raw = true; }
                _ => { var_names.push(&args[i]); }
            }
            i += 1;
        }

        if var_names.is_empty() {
            var_names.push("REPLY");
        }

        if let Some(p) = prompt {
            io::write_stderr(p);
        }

        let line = match &stdin {
            Some(s) => {
                let mut buf = Vec::new();
                loop {
                    match s.blocking_read(1) {
                        Ok(bytes) if bytes.is_empty() => break,
                        Ok(bytes) => {
                            buf.extend_from_slice(&bytes);
                            if bytes.last() == Some(&b'\n') { break; }
                        }
                        Err(_) => break,
                    }
                }
                if buf.is_empty() { return 1; }
                String::from_utf8_lossy(&buf).trim_end_matches('\n').to_string()
            }
            None => {
                match self.reader.read_line() {
                    Some(l) => l.trim_end_matches('\n').to_string(),
                    None => return 1,
                }
            }
        };

        let line = if raw { line } else { line.replace("\\\n", "") };

        let ifs = self.env.get("IFS").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| " \t\n".to_string());
        let fields: Vec<&str> = if ifs.is_empty() {
            vec![&line]
        } else {
            line.split(|c: char| ifs.contains(c))
                .filter(|s| !s.is_empty())
                .collect()
        };

        for (idx, var_name) in var_names.iter().enumerate() {
            if idx == var_names.len() - 1 {
                let remaining: Vec<&str> = if idx < fields.len() { fields[idx..].to_vec() } else { vec![] };
                self.env.insert(var_name.to_string(), ShellValue::Scalar(remaining.join(" ")));
            } else if idx < fields.len() {
                self.env.insert(var_name.to_string(), ShellValue::Scalar(fields[idx].to_string()));
            } else {
                self.env.insert(var_name.to_string(), ShellValue::Scalar(String::new()));
            }
        }

        0
    }

    #[cfg(test)]
    fn exec_read(&mut self, _args: &[String], _stdin: Option<InputStream>) -> u8 { 0 }

}

fn parse_array_subscript(s: &str) -> Option<(&str, &str)> {
    let open = s.find('[')?;
    let close = s.rfind(']')?;
    if close <= open { return None; }
    let name = &s[..open];
    let subscript = &s[open + 1..close];
    if name.is_empty() { return None; }
    // Name must be a valid identifier (only alphanumeric + underscore)
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') { return None; }
    Some((name, subscript))
}

#[cfg(not(test))]
pub(crate) fn get_root_descriptor() -> Option<crate::bindings::wasi::filesystem::types::Descriptor> {
    use crate::bindings::wasi::filesystem::preopens;
    preopens::get_directories().into_iter().find(|(_, p)| p == "/").map(|(d, _)| d)
}

fn signal_name_from_num(num: u8) -> &'static str {
    match num {
        2 => "INT",
        9 => "KILL",
        15 => "TERM",
        18 => "CONT",
        20 => "TSTP",
        _ => "",
    }
}

fn parse_signal_flag(arg: &str) -> Option<crate::bindings::mithic::process::types::Signal> {
    use crate::bindings::mithic::process::types::Signal;
    if !arg.starts_with('-') { return None; }
    let s = &arg[1..];
    match s {
        "INT" | "SIGINT" | "2" => Some(Signal::Sigint),
        "TERM" | "SIGTERM" | "15" => Some(Signal::Sigterm),
        "KILL" | "SIGKILL" | "9" => Some(Signal::Sigkill),
        "TSTP" | "SIGTSTP" | "20" => Some(Signal::Sigtstp),
        "CONT" | "SIGCONT" | "18" => Some(Signal::Sigcont),
        _ => None,
    }
}

