use std::collections::HashMap;

use crate::executor::expansion::{
    expand_tilde, glob_match, literal_text, normalize_path, parse_array_subscript,
};
use crate::parser::{ArrayAssign, Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand};
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

    pub(crate) fn exec_list_with_stdout(&mut self, list: List, stdout: OutputHandle) -> u8 {
        let mut exit = 0u8;
        let mut skip_next = false;

        for ListItem { pipeline, op } in list.items {
            if !skip_next {
                let out = self.rt.dup_output(&stdout);
                exit = self.exec_pipeline_with_stdout(pipeline, out);
                if self.exit_requested { break; }
            }
            skip_next = match op {
                Some(ListOp::And) => exit != 0,
                Some(ListOp::Or)  => exit == 0,
                _ => false,
            };
        }
        self.rt.pipe_close_write(stdout);
        exit
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

    /// Execute a list, applying the given redirects. If redirects include a stdout redirect,
    /// the body is executed with `exec_list_with_stdout`. Otherwise falls back to `exec_list`.
    pub(crate) fn exec_list_redirected(
        &mut self,
        list: List,
        redirects: &[crate::parser::Redirect],
    ) -> u8 {
        if redirects.is_empty() {
            return self.exec_list(list);
        }
        let mut stdin_opt: Option<InputHandle> = None;
        let mut stdout_opt: Option<OutputHandle> = None;
        let mut stderr_opt: Option<OutputHandle> = None;
        if !self.apply_redirects(redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
            return 1;
        }
        match stdout_opt {
            Some(out) => self.exec_list_with_stdout(list, out),
            None => self.exec_list(list),
        }
    }

    pub(crate) fn exec_compound(&mut self, cmd: Command) -> u8 {
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
            Command::Subshell(list) => {
                let saved_env = self.env.clone();
                let saved_cwd = self.cwd.clone();
                let saved_functions = self.functions.clone();
                let saved_traps = self.traps.clone();
                let saved_options = self.options.clone();
                let saved_params = self.params.clone();
                let saved_exit_requested = self.exit_requested;
                let saved_in_condition = self.in_condition;
                let saved_in_loop_depth = self.in_loop_depth;
                let saved_in_function_depth = self.in_function_depth;
                let saved_break_depth = self.break_depth;
                let saved_continue_depth = self.continue_depth;
                let saved_return_requested = self.return_requested;

                self.in_loop_depth = 0;
                self.in_function_depth = 0;
                self.in_condition = 0;
                self.break_depth = 0;
                self.continue_depth = 0;
                self.return_requested = false;

                let exit = self.exec_list(list);

                self.env = saved_env;
                self.cwd = saved_cwd;
                self.functions = saved_functions;
                self.traps = saved_traps;
                self.options = saved_options;
                self.params = saved_params;
                self.exit_requested = saved_exit_requested;
                self.in_condition = saved_in_condition;
                self.in_loop_depth = saved_in_loop_depth;
                self.in_function_depth = saved_in_function_depth;
                self.break_depth = saved_break_depth;
                self.continue_depth = saved_continue_depth;
                self.return_requested = saved_return_requested;

                exit
            }
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
        self.in_condition += 1;
        let cond_exit = self.exec_list(cmd.condition);
        self.in_condition -= 1;
        let body = if cond_exit == 0 {
            Some(cmd.then_body)
        } else {
            let mut found = None;
            for (elif_cond, elif_body) in cmd.elifs {
                self.in_condition += 1;
                let elif_exit = self.exec_list(elif_cond);
                self.in_condition -= 1;
                if elif_exit == 0 {
                    found = Some(elif_body);
                    break;
                }
            }
            found.or(cmd.else_body)
        };
        match body {
            Some(list) => self.exec_list_redirected(list, &cmd.redirects),
            None => 0,
        }
    }

    fn exec_while(&mut self, cmd: crate::parser::WhileCommand) -> u8 {
        self.exec_while_inner(cmd, false)
    }

    fn exec_until(&mut self, cmd: crate::parser::WhileCommand) -> u8 {
        self.exec_while_inner(cmd, true)
    }

    /// Shared implementation for while/until loops.
    /// `invert` = true means "until" semantics (loop while condition is *false*).
    fn exec_while_inner(&mut self, cmd: crate::parser::WhileCommand, invert: bool) -> u8 {
        // Open redirect streams once before the loop so all iterations share the same file.
        let loop_stdout = if !cmd.redirects.is_empty() {
            let mut stdin_opt = None;
            let mut stdout_opt = None;
            let mut stderr_opt = None;
            if !self.apply_redirects(&cmd.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                return 1;
            }
            stdout_opt
        } else {
            None
        };

        self.in_loop_depth += 1;
        let mut exit = 0u8;
        loop {
            self.in_condition += 1;
            let cond = self.exec_list(cmd.condition.clone());
            self.in_condition -= 1;
            let keep_looping = if invert { cond != 0 } else { cond == 0 };
            if !keep_looping { break; }
            exit = match &loop_stdout {
                Some(out) => {
                    let duped = self.rt.dup_output(out);
                    self.exec_list_with_stdout(cmd.body.clone(), duped)
                }
                None => self.exec_list(cmd.body.clone()),
            };
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
            None => self.params.all().to_vec(),
        };

        self.exec_for_inner(cmd.var, items, cmd.body, &cmd.redirects)
    }

    fn exec_for_inner(
        &mut self,
        var: String,
        items: Vec<String>,
        body: List,
        redirects: &[crate::parser::Redirect],
    ) -> u8 {
        // Open redirect streams once before the loop.
        let loop_stdout = if !redirects.is_empty() {
            let mut stdin_opt = None;
            let mut stdout_opt = None;
            let mut stderr_opt = None;
            if !self.apply_redirects(redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                return 1;
            }
            stdout_opt
        } else {
            None
        };

        self.in_loop_depth += 1;
        let mut exit = 0u8;
        for item in items {
            self.env.insert(var.clone(), ShellValue::Scalar(item));
            exit = match &loop_stdout {
                Some(out) => {
                    let duped = self.rt.dup_output(out);
                    self.exec_list_with_stdout(body.clone(), duped)
                }
                None => self.exec_list(body.clone()),
            };
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
                return self.exec_list_redirected(arm.body, &cmd.redirects);
            }
        }
        0
    }

    pub(crate) fn exec_function_call(&mut self, args: &[String], body: Command) -> u8 {
        self.params.push_frame(args.to_vec());
        self.in_function_depth += 1;
        let exit = self.exec_compound(body);
        self.in_function_depth -= 1;
        self.return_requested = false;
        self.params.pop_frame();
        exit
    }

    pub(crate) fn eval_test(&self, args: &[String]) -> bool {
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

    pub(crate) fn parse_int(&self, s: &str) -> i64 {
        s.parse().unwrap_or(0)
    }

    pub(crate) fn test_file(&self, op: &str, path: &str) -> bool {
        use crate::runtime::FileType;
        let resolved = self.resolve_path(path);
        match op {
            "-e" | "-r" | "-w" | "-x" => self.rt.file_exists(&resolved),
            "-f" => self.rt.file_type(&resolved) == FileType::Regular,
            "-d" => self.rt.file_type(&resolved) == FileType::Directory,
            _ => false,
        }
    }

    pub(crate) fn eval_extended_test(&mut self, args: &[String]) -> bool {
        if args.is_empty() { return false; }

        if args[0] == "!" {
            return !self.eval_extended_test(&args[1..].to_vec());
        }

        for i in 0..args.len() {
            if args[i] == "&&" {
                let left = args[..i].to_vec();
                let right = args[i+1..].to_vec();
                return self.eval_extended_test(&left) && self.eval_extended_test(&right);
            }
        }
        for i in 0..args.len() {
            if args[i] == "||" {
                let left = args[..i].to_vec();
                let right = args[i+1..].to_vec();
                return self.eval_extended_test(&left) || self.eval_extended_test(&right);
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
            let left = args[0].clone();
            let op = args[1].as_str().to_string();
            let right = args[2].clone();
            return match op.as_str() {
                "==" | "=" => glob_match(&right, &left),
                "!=" => !glob_match(&right, &left),
                "<" => left < right,
                ">" => left > right,
                "-eq" => self.parse_int(&left) == self.parse_int(&right),
                "-ne" => self.parse_int(&left) != self.parse_int(&right),
                "-lt" => self.parse_int(&left) < self.parse_int(&right),
                "-gt" => self.parse_int(&left) > self.parse_int(&right),
                "-le" => self.parse_int(&left) <= self.parse_int(&right),
                "-ge" => self.parse_int(&left) >= self.parse_int(&right),
                "=~" => {
                    let m = crate::regex::regex_match(&left, &right);
                    self.env.insert(
                        "BASH_REMATCH".to_string(),
                        ShellValue::Array(if m.matched { m.groups } else { vec![] }),
                    );
                    m.matched
                }
                _ => false,
            };
        }

        false
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
