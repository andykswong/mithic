use std::collections::{HashMap, HashSet};

use crate::executor::expansion::{
    expand_tilde, literal_text, normalize_path, parse_array_subscript,
};
use crate::parser::{Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};
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
    pub(crate) procsub_out_pending: Vec<(String, String)>,
    pub(crate) jobs: JobTable,
    pub(crate) traps: HashMap<String, String>,
    pub(crate) foreground_pids: Vec<u32>,
    pub(crate) options: ShellOptions,
    pub(crate) in_condition: usize,
    pub(crate) local_scopes: Vec<HashMap<String, Option<ShellValue>>>,
    pub(crate) readonly_vars: HashSet<String>,
    pub(crate) random_state: u64,
    pub(crate) current_line: u32,
    /// Persistent stdout redirect set by `exec > file`. None means use default stdout.
    pub(crate) exec_stdout_path: Option<String>,
    pub(crate) shell_name: String,
    pub(crate) history: Vec<String>,
    pub(crate) hash_table: HashMap<String, String>,
    pub(crate) expansion_error: bool,
}

impl<R: Runtime> Shell<R> {
    pub fn new(rt: R, mut env: HashMap<String, ShellValue>, cwd: String, is_interactive: bool) -> Self {
        env.entry("PS1".to_string()).or_insert(ShellValue::Scalar("\\w\\$ ".to_string()));
        env.entry("PS2".to_string()).or_insert(ShellValue::Scalar("> ".to_string()));
        let random_state = {
            let mut buf = [0u8; 8];
            if getrandom::fill(&mut buf).is_ok() {
                u64::from_le_bytes(buf)
            } else {
                12345678901234567u64
            }
        };
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
            procsub_out_pending: Vec::new(),
            jobs: JobTable::new(),
            traps: HashMap::new(),
            foreground_pids: Vec::new(),
            options: ShellOptions::default(),
            in_condition: 0,
            local_scopes: Vec::new(),
            readonly_vars: HashSet::new(),
            random_state,
            current_line: 0,
            exec_stdout_path: None,
            shell_name: "sh".to_string(),
            history: Vec::new(),
            hash_table: HashMap::new(),
            expansion_error: false,
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
                    let ps1 = self.env.get("PS1").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "$ ".to_string());
                    self.expand_prompt(&ps1)
                } else {
                    let ps2 = self.env.get("PS2").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "> ".to_string());
                    self.expand_prompt(&ps2)
                };
                self.rt.write_stdout(&prompt);
            }

            // TMOUT: if set to a positive integer, the shell exits on read timeout/EOF.
            // Since WASM read_line() may not support real timeouts, we check after EOF.
            let tmout: u64 = self.env.get("TMOUT")
                .and_then(|v| v.as_scalar().parse().ok())
                .unwrap_or(0);

            let line = match self.rt.read_line() {
                Some(l) => l,
                None => {
                    // EOF or timeout: if TMOUT is set, exit immediately
                    if tmout > 0 {
                        break;
                    }
                    // EOF: try to parse whatever is buffered
                    if !input_buf.is_empty() {
                        let trimmed = input_buf.trim().to_string();
                        if !trimmed.is_empty() {
                            if self.options.verbose {
                                self.rt.write_stderr(&format!("{}\n", trimmed));
                            }
                            let mut parser = Parser::new_with_mode(&trimmed, self.options.posix);
                            let result = parser.parse();
                            for err in parser.errors() {
                                self.rt.write_stderr(&format!(
                                    "{}: syntax error at line {}, col {}: {}\n",
                                    self.shell_name, err.span.line, err.span.col, err.message
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

            // Ensure the line ends with a newline so that accumulated lines are
            // separated correctly (WasiRuntime includes '\n'; TestRuntime does not).
            if !line.ends_with('\n') {
                input_buf.push_str(&line);
                input_buf.push('\n');
            } else {
                input_buf.push_str(&line);
            }

            // Check for unclosed quotes before trimming — the newline must be
            // preserved as part of the quoted string content.
            if input_needs_continuation(&input_buf) {
                continue;
            }

            let mut trimmed = input_buf.trim().to_string();
            if trimmed.is_empty() {
                input_buf.clear();
                continue;
            }

            // Check for line continuation (trailing backslash outside quotes)
            if trimmed.ends_with('\\') {
                let without_backslash = trimmed.trim_end_matches('\\').to_string();
                input_buf = without_backslash;
                input_buf.push(' ');
                continue;
            }

            // History expansion (bash mode only)
            if let Some(expanded) = self.expand_history(&trimmed) {
                trimmed = expanded;
            }

            // Record in history
            {
                let histsize: usize = self.env.get("HISTSIZE")
                    .and_then(|v| v.as_scalar().parse().ok())
                    .unwrap_or(500);
                if self.history.len() >= histsize {
                    self.history.remove(0);
                }
                self.history.push(trimmed.clone());
            }

            if self.options.verbose {
                self.rt.write_stderr(&format!("{}\n", trimmed));
            }

            let mut parser = Parser::new_with_mode(&trimmed, self.options.posix);
            let result = parser.parse();

            if parser.is_incomplete() {
                // Incomplete compound command — keep reading
                continue;
            }

            for err in parser.errors() {
                self.rt.write_stderr(&format!(
                    "{}: syntax error at line {}, col {}: {}\n",
                    self.shell_name, err.span.line, err.span.col, err.message
                ));
            }

            if let Some(list) = result {
                self.current_line += 1;
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

    pub fn run_string(&mut self, input: &str) -> u8 {
        if input.trim().is_empty() {
            return 0;
        }
        if self.options.verbose {
            self.rt.write_stderr(&format!("{}\n", input.trim()));
        }
        let mut parser = Parser::new_with_mode(input, self.options.posix);
        let result = parser.parse();
        let has_errors = !parser.errors().is_empty();
        for err in parser.errors() {
            self.rt.write_stderr(&format!(
                "{}: syntax error: {}\n",
                self.shell_name, err.message
            ));
        }
        if has_errors {
            self.last_exit = 2;
        } else if let Some(list) = result {
            self.last_exit = self.exec_list(list);
        }
        self.run_trap("EXIT");
        self.cleanup_procsub_files();
        self.last_exit
    }

    pub fn run_file(&mut self, path: &str) -> u8 {
        let resolved = self.resolve_path(path);
        let bytes = self.rt.read_file(&resolved);
        if bytes.is_empty() {
            self.rt.write_stderr(&format!(
                "{}: {}: No such file or directory\n",
                self.shell_name, path
            ));
            return 127;
        }
        let content = String::from_utf8_lossy(&bytes).to_string();
        self.run_string(&content)
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
                    if !self.procsub_out_pending.is_empty() {
                        self.flush_procsub_out();
                    }
                }
                if self.exit_requested || self.return_requested || self.break_depth > 0 || self.continue_depth > 0 {
                    break;
                }
                // ERR trap: run after any command fails, but not in condition contexts
                if exit != 0 && self.in_condition == 0 {
                    self.run_trap("ERR");
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
        // We handle two cases:
        //   1. Fully literal word (e.g. `VAR=hello`) — use literal_text fast path.
        //   2. Word with a leading Literal part containing `=` followed by dynamic parts
        //      (e.g. `VAR=$(cmd)`, `VAR=$((expr))`, `VAR=${x:-default}`) — expand RHS parts
        //      without glob/brace expansion and assign directly.
        if cmd.words.len() == 1 {
            if let Some(raw) = literal_text(&cmd.words[0]) {
                if let Some(exit) = self.try_assignment(&raw) {
                    return exit;
                }
            } else if let Some(exit) = self.try_assignment_word(&cmd.words[0]) {
                return exit;
            }
        }

        // Prefix assignments: leading `VAR=val` words followed by a command name.
        // E.g. `MY_VAR=hello cmd arg` — temporarily set vars for the duration of the call.
        if cmd.words.len() > 1 {
            let mut prefix_assignments: Vec<(String, String)> = Vec::new();
            let mut cmd_start = 0usize;
            for (i, word) in cmd.words.iter().enumerate() {
                if let Some(raw) = literal_text(word) {
                    if let Some(eq_pos) = raw.find('=') {
                        let lhs = &raw[..eq_pos];
                        if !lhs.is_empty() && lhs.chars().all(|c| c.is_alphanumeric() || c == '_') {
                            prefix_assignments.push((lhs.to_string(), raw[eq_pos + 1..].to_string()));
                            cmd_start = i + 1;
                            continue;
                        }
                    }
                }
                break;
            }
            if !prefix_assignments.is_empty() && cmd_start < cmd.words.len() {
                let saved: Vec<(String, Option<ShellValue>)> = prefix_assignments.iter()
                    .map(|(k, _)| (k.clone(), self.env.get(k).cloned()))
                    .collect();
                for (k, v) in &prefix_assignments {
                    self.env.insert(k.clone(), ShellValue::Scalar(v.clone()));
                }
                let remaining = SimpleCommand {
                    words: cmd.words[cmd_start..].to_vec(),
                    redirects: cmd.redirects,
                };
                let exit = self.dispatch_simple(remaining, stdin, stdout, env_list);
                for (k, prev) in saved {
                    match prev {
                        Some(v) => { self.env.insert(k, v); }
                        None => { self.env.remove(&k); }
                    }
                }
                return exit;
            }
        }

        // Special handling for `exec > file` (redirect only, no command): persist the redirect.
        // We must do this before apply_redirects opens the file handle.
        if cmd.words.len() == 1 {
            if let Some(raw) = literal_text(&cmd.words[0]) {
                if raw == "exec" && !cmd.redirects.is_empty() {
                    // Check if this is a pure redirect exec (no additional args)
                    // Extract stdout redirect target to persist in exec_stdout_path
                    use crate::parser::Redirect;
                    let mut new_path: Option<String> = None;
                    let mut clear_path = false;
                    for redirect in &cmd.redirects {
                        match redirect {
                            Redirect::Out(w) | Redirect::OutClobber(w) => {
                                let expanded = self.expand_word(w);
                                let path = self.resolve_path(&expanded);
                                if path == "/dev/stdout" {
                                    clear_path = true;
                                } else {
                                    new_path = Some(path);
                                }
                            }
                            _ => {}
                        }
                    }
                    if clear_path {
                        self.exec_stdout_path = None;
                    } else if let Some(path) = new_path {
                        self.exec_stdout_path = Some(path);
                    }
                    return 0;
                }
            }
        }

        let args = match self.try_expand_words_to_args(&cmd.words) {
            Ok(a) => a,
            Err(code) => return code,
        };

        if self.exit_requested && self.options.nounset {
            return self.last_exit;
        }

        let mut stderr_opt: Option<OutputHandle> = None;
        if !self.apply_redirects(&cmd.redirects, &mut stdin, &mut stdout, &mut stderr_opt) {
            return 1;
        }

        // Apply persistent exec stdout redirect when no explicit stdout was provided.
        if stdout.is_none() {
            if let Some(ref path) = self.exec_stdout_path.clone() {
                stdout = self.rt.open_file_write(path, true);
            }
        }

        if args.is_empty() {
            // $(< file) optimization: if stdin was redirected with no command, copy stdin to stdout
            if let Some(inp) = stdin {
                let data = self.rt.pipe_read_all(inp);
                if !data.is_empty() {
                    if let Some(out) = stdout {
                        self.rt.pipe_write(&out, &data);
                    } else {
                        self.rt.write_stdout(&String::from_utf8_lossy(&data));
                    }
                }
            }
            return 0;
        }

        if self.options.xtrace {
            self.rt.write_stderr(&format!("+ {}\n", args.join(" ")));
        }

        let name = args[0].clone();
        if let Some(body) = self.functions.get(&name).cloned() {
            self.exec_function_call(&args[1..], body)
        } else if let Some(builtin_fn) = crate::builtins::lookup_builtin::<R>(&name) {
            builtin_fn(self, &name, &args[1..], stdin, stdout)
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
            let resolved_name = self.hash_table.get(&name).cloned().unwrap_or(name.clone());
            match self.rt.spawn(&resolved_name, &args[1..], opts) {
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
                    self.rt.write_stderr(&format!("{}: {}: command not found\n", self.shell_name, name));
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
                    if self.readonly_vars.contains(arr_name) {
                        self.rt.write_stderr(&format!("{}: {}: readonly variable\n", self.shell_name, arr_name));
                        self.last_exit = 1;
                        return Some(1);
                    }
                    let val = rhs.to_string();
                    let arr_name_str = arr_name.to_string();
                    // Check if this is an associative array
                    if matches!(self.env.get(arr_name), Some(ShellValue::AssocArray(_))) {
                        let entry = self.env.get_mut(&arr_name_str).unwrap();
                        entry.assoc_set(subscript.to_string(), val);
                        return Some(0);
                    }
                    // Numeric index for regular arrays
                    if let Ok(idx) = subscript.parse::<usize>() {
                        let entry = self.env.entry(arr_name_str).or_insert_with(|| ShellValue::Array(Vec::new()));
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
                            ShellValue::AssocArray(_) => unreachable!(),
                        }
                        return Some(0);
                    }
                    return None;
                }
            }
            // `VAR=value` — plain scalar assignment
            if lhs.chars().all(|c| c.is_alphanumeric() || c == '_') && !lhs.is_empty() {
                if self.readonly_vars.contains(lhs) {
                    self.rt.write_stderr(&format!("{}: {}: readonly variable\n", self.shell_name, lhs));
                    self.last_exit = 1;
                    return Some(1);
                }
                self.env.insert(lhs.to_string(), ShellValue::Scalar(rhs.to_string()));
                return Some(0);
            }
        }
        None
    }

    /// Detect and execute a mixed assignment word like `VAR=$(cmd)` or `VAR=$((expr))`.
    /// Called when `literal_text` returns None (word contains non-literal parts).
    /// Returns `Some(exit_code)` if handled, `None` otherwise.
    fn try_assignment_word(&mut self, word: &Word) -> Option<u8> {
        let parts = word.parts();
        if parts.is_empty() {
            return None;
        }
        // The first part must be a Literal containing '='.
        let first_literal = match &parts[0] {
            WordPart::Literal(s) => s,
            _ => return None,
        };
        let eq_pos = first_literal.find('=')?;
        let lhs = &first_literal[..eq_pos];
        let rhs_prefix = &first_literal[eq_pos + 1..];

        // Validate: LHS must be a valid variable name or `arr[idx]`.
        let is_valid_lhs = if let Some((arr_name, subscript)) = parse_array_subscript(lhs) {
            arr_name.chars().all(|c| c.is_alphanumeric() || c == '_')
                && (subscript.parse::<usize>().is_ok() || matches!(self.env.get(arr_name), Some(ShellValue::AssocArray(_))))
        } else {
            !lhs.is_empty() && lhs.chars().all(|c| c.is_alphanumeric() || c == '_')
        };
        if !is_valid_lhs {
            return None;
        }

        // Expand the RHS: rhs_prefix (literal tail of first part) + remaining parts.
        self.expansion_error = false;
        let mut rhs = rhs_prefix.to_string();
        for part in &parts[1..] {
            rhs.push_str(&self.expand_part(part));
        }
        if self.expansion_error {
            return Some(self.last_exit);
        }

        // Perform the assignment.
        if let Some((arr_name, subscript)) = parse_array_subscript(lhs) {
            // Associative array assignment
            if matches!(self.env.get(arr_name), Some(ShellValue::AssocArray(_))) {
                let arr_name = arr_name.to_string();
                let entry = self.env.get_mut(&arr_name).unwrap();
                entry.assoc_set(subscript.to_string(), rhs);
                return Some(0);
            }
            if let Ok(idx) = subscript.parse::<usize>() {
                let arr_name = arr_name.to_string();
                let entry = self.env.entry(arr_name).or_insert_with(|| ShellValue::Array(Vec::new()));
                match entry {
                    ShellValue::Array(v) => {
                        if idx >= v.len() {
                            v.resize(idx + 1, String::new());
                        }
                        v[idx] = rhs;
                    }
                    ShellValue::Scalar(_) => {
                        *entry = ShellValue::Array({
                            let mut v = vec![String::new(); idx + 1];
                            v[idx] = rhs;
                            v
                        });
                    }
                    ShellValue::AssocArray(_) => unreachable!(),
                }
                return Some(0);
            }
        }
        // Plain scalar assignment.
        if self.readonly_vars.contains(lhs) {
            self.rt.write_stderr(&format!("{}: {}: readonly variable\n", self.shell_name, lhs));
            self.last_exit = 1;
            return Some(1);
        }
        let lhs = lhs.to_string();
        self.env.insert(lhs, ShellValue::Scalar(rhs));
        Some(0)
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

                    let exit = self.exec_list_with_stdout(list, stdout);

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
            let args = match self.try_expand_words_to_args(&cmd.words) {
                Ok(a) => a,
                Err(code) => {
                    if i == n - 1 { last_builtin_exit = Some(code); }
                    continue;
                }
            };
            if args.is_empty() { continue; }
            let name = args[0].clone();
            if let Some(body) = self.functions.get(&name).cloned() {
                let exit = self.exec_function_call(&args[1..], body);
                if i == n - 1 { last_builtin_exit = Some(exit); }
            } else if let Some(builtin_fn) = crate::builtins::lookup_builtin::<R>(&name) {
                let exit = builtin_fn(self, &name, &args[1..], stdin_opt, stdout_opt);
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
                let resolved_name = self.hash_table.get(&name).cloned().unwrap_or(name.clone());
                match self.rt.spawn(&resolved_name, &args[1..], opts) {
                    Ok(proc) => processes.push(proc),
                    Err(_) => {
                        self.rt.write_stderr(&format!("{}: {}: command not found\n", self.shell_name, name));
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

    fn expand_history(&self, input: &str) -> Option<String> {
        if self.options.posix || self.history.is_empty() {
            return None;
        }
        let trimmed = input.trim();
        if trimmed == "!!" {
            return self.history.last().cloned();
        }
        if trimmed.starts_with("!-") {
            if let Ok(n) = trimmed[2..].parse::<usize>() {
                if n > 0 && n <= self.history.len() {
                    return Some(self.history[self.history.len() - n].clone());
                }
            }
        }
        if trimmed.starts_with('!') && trimmed.len() > 1 && !trimmed.starts_with("!=") {
            let rest = &trimmed[1..];
            if let Ok(n) = rest.parse::<usize>() {
                if n > 0 && n <= self.history.len() {
                    return Some(self.history[n - 1].clone());
                }
            }
            for cmd in self.history.iter().rev() {
                if cmd.starts_with(rest) {
                    return Some(cmd.clone());
                }
            }
        }
        None
    }

    fn expand_prompt(&self, ps: &str) -> String {
        if self.options.posix {
            return ps.to_string();
        }
        let mut result = String::new();
        let mut chars = ps.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('w') => {
                        let home = self.env.get("HOME").map(|v| v.as_scalar().to_string()).unwrap_or_default();
                        if !home.is_empty() && self.cwd.starts_with(home.as_str()) {
                            result.push('~');
                            result.push_str(&self.cwd[home.len()..]);
                        } else {
                            result.push_str(&self.cwd);
                        }
                    }
                    Some('W') => {
                        let base = self.cwd.rsplit('/').next().unwrap_or(&self.cwd);
                        result.push_str(if base.is_empty() { "/" } else { base });
                    }
                    Some('u') => {
                        let user = self.env.get("USER").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "user".to_string());
                        result.push_str(&user);
                    }
                    Some('h') => {
                        let host = self.env.get("HOSTNAME").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "localhost".to_string());
                        let short = host.split('.').next().unwrap_or(&host).to_string();
                        result.push_str(&short);
                    }
                    Some('H') => {
                        let host = self.env.get("HOSTNAME").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "localhost".to_string());
                        result.push_str(&host);
                    }
                    Some('$') => {
                        let user = self.env.get("USER").map(|v| v.as_scalar()).unwrap_or("");
                        result.push(if user == "root" { '#' } else { '$' });
                    }
                    Some('n') => result.push('\n'),
                    Some('\\') => result.push('\\'),
                    Some('e') => result.push('\x1b'),
                    Some('[') | Some(']') => {}
                    Some('t') => {
                        use std::time::SystemTime;
                        let secs = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs();
                        let h = (secs % 86400) / 3600;
                        let m = (secs % 3600) / 60;
                        let s = secs % 60;
                        result.push_str(&format!("{:02}:{:02}:{:02}", h, m, s));
                    }
                    Some(other) => { result.push('\\'); result.push(other); }
                    None => result.push('\\'),
                }
            } else {
                result.push(c);
            }
        }
        result
    }

    pub(crate) fn run_trap(&mut self, signal: &str) {
        if let Some(handler) = self.traps.get(signal).cloned() {
            if !handler.is_empty() {
                let mut parser = Parser::new_with_mode(&handler, self.options.posix);
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
        0 => "EXIT",
        2 => "INT",
        9 => "KILL",
        15 => "TERM",
        18 => "CONT",
        20 => "TSTP",
        _ => "",
    }
}

/// Returns true when `input` has an unclosed single or double quote, unclosed `$(`,
/// or a pending heredoc (`<<DELIM`) that has not been terminated.
/// A trailing backslash (line continuation outside quotes) is NOT checked here
/// because that is handled separately in the REPL loop after trimming.
pub(crate) fn input_needs_continuation(input: &str) -> bool {
    let chars: Vec<char> = input.chars().collect();
    let n = chars.len();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    // Track depth of $( ... ) — each `$(` increments, each `)` decrements (outside quotes)
    let mut dollar_paren_depth: i32 = 0;

    while i < n {
        let c = chars[i];

        if escaped {
            escaped = false;
            i += 1;
            continue;
        }

        match c {
            '\\' if !in_single => { escaped = true; i += 1; }
            '\'' if !in_double => { in_single = !in_single; i += 1; }
            '"' if !in_single => { in_double = !in_double; i += 1; }
            '$' if !in_single && !in_double && i + 1 < n && chars[i + 1] == '(' => {
                dollar_paren_depth += 1;
                i += 2; // skip $(
            }
            ')' if !in_single && !in_double && dollar_paren_depth > 0 => {
                dollar_paren_depth -= 1;
                i += 1;
            }
            '<' if !in_single && !in_double && i + 1 < n && chars[i + 1] == '<' => {
                // Check it's << not <<<
                if i + 2 < n && chars[i + 2] == '<' {
                    i += 3; // skip <<<
                    continue;
                }
                // We found <<; skip past it
                i += 2;
                // Skip optional - for <<-
                if i < n && chars[i] == '-' { i += 1; }
                // Skip whitespace before delimiter
                while i < n && (chars[i] == ' ' || chars[i] == '\t') { i += 1; }
                // Read the delimiter (may be quoted)
                let mut delim = String::new();
                if i < n && chars[i] == '\'' {
                    i += 1; // skip opening '
                    while i < n && chars[i] != '\'' { delim.push(chars[i]); i += 1; }
                    if i < n { i += 1; } // skip closing '
                } else if i < n && chars[i] == '"' {
                    i += 1; // skip opening "
                    while i < n && chars[i] != '"' { delim.push(chars[i]); i += 1; }
                    if i < n { i += 1; } // skip closing "
                } else {
                    while i < n && !matches!(chars[i], '\n' | ' ' | '\t' | ';') {
                        delim.push(chars[i]); i += 1;
                    }
                }
                if delim.is_empty() { continue; }
                // Skip rest of current line (until newline)
                while i < n && chars[i] != '\n' { i += 1; }
                if i < n && chars[i] == '\n' { i += 1; }
                // Now scan subsequent lines for a line that is exactly `delim`
                let mut found = false;
                while i < n {
                    let line_start = i;
                    while i < n && chars[i] != '\n' { i += 1; }
                    let line: String = chars[line_start..i].iter().collect();
                    if i < n && chars[i] == '\n' { i += 1; }
                    if line == delim {
                        found = true;
                        break;
                    }
                }
                if !found {
                    return true; // heredoc not terminated — needs more input
                }
            }
            _ => { i += 1; }
        }
    }

    in_single || in_double || dollar_paren_depth > 0
}
