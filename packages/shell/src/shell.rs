use std::collections::HashMap;

use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{InputStream, OutputStream, SpawnOptions};
use crate::bindings::wasi::cli::{environment, terminal_stdin};
use crate::brace::expand_braces;
use crate::executor::expansion::{
    expand_tilde, has_glob, glob_match, glob_replace_first, glob_replace_all,
    remove_shortest_prefix, remove_longest_prefix, remove_shortest_suffix, remove_longest_suffix,
    shell_substring, split_var_and_op, literal_text, normalize_path, parse_array_subscript,
};
use crate::io::{self, LineReader};
use crate::parser::{ArrayAssign, Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};
use crate::value::ShellValue;
use crate::jobs::JobTable;
use crate::options::ShellOptions;
use crate::params::PositionalParams;

pub struct Shell {
    pub(crate) env: HashMap<String, ShellValue>,
    pub(crate) params: PositionalParams,
    pub(crate) cwd: String,
    pub(crate) last_exit: u8,
    pub(crate) is_interactive: bool,
    pub(crate) exit_requested: bool,
    pub(crate) reader: LineReader,
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
            params: PositionalParams::new(),
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
            options: ShellOptions::default(),
            in_condition: 0,
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
                            let result = parser.parse();
                            for err in parser.errors() {
                                io::write_stderr(&format!(
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
                io::write_stderr(&format!(
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

        // If nounset triggered during expansion, bail out with error
        if self.exit_requested && self.options.nounset {
            return self.last_exit;
        }

        let mut stderr_opt: Option<OutputStream> = None;
        if !self.apply_redirects(&cmd.redirects, &mut stdin, &mut stdout, &mut stderr_opt) {
            return 1;
        }

        if args.is_empty() {
            return 0;
        }

        if self.options.xtrace {
            io::write_stderr(&format!("+ {}\n", args.join(" ")));
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

    pub(crate) fn is_builtin(name: &str) -> bool {
        matches!(name,
            "exit" | "echo" | "pwd" | "cd" | "export" | "unset" |
            "env" | "true" | "false" | "break" | "continue" |
            "return" | "source" | "." | "read" | "test" | "[" | "[[" |
            "declare" | "local" | "set" |
            "jobs" | "fg" | "bg" | "wait" | "disown" | "kill" | "trap"
        )
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

    pub(crate) fn expand_word(&mut self, word: &Word) -> String {
        let parts: Vec<_> = word.parts().to_vec();
        parts.iter().map(|p| self.expand_part(p)).collect()
    }

    pub(crate) fn expand_word_to_args(&mut self, w: &Word) -> Vec<String> {
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

    /// If the word is a standalone `${arr[@]}`, `${arr[*]}`, `$@`, or `$*`, return elements.
    /// `$@` / `${arr[@]}` → each element as a separate word.
    /// `$*` / `${arr[*]}` → all elements joined by IFS[0] (default space) as one word.
    fn try_expand_array_all(&self, w: &Word) -> Option<Vec<String>> {
        let parts = w.parts();
        if parts.len() != 1 {
            return None;
        }

        let ifs_sep = self.env.get("IFS")
            .map(|v| v.as_scalar().chars().next().unwrap_or(' '))
            .unwrap_or(' ');

        match &parts[0] {
            WordPart::BraceVar(raw) => {
                let (name, subscript) = parse_array_subscript(raw)?;
                if subscript != "@" && subscript != "*" {
                    return None;
                }
                let elements = match self.env.get(name) {
                    Some(ShellValue::Array(elements)) => elements.clone(),
                    Some(ShellValue::Scalar(s)) => vec![s.clone()],
                    None => return Some(Vec::new()),
                };
                if subscript == "*" {
                    let joined: String = elements.join(&ifs_sep.to_string());
                    Some(vec![joined])
                } else {
                    Some(elements)
                }
            }
            WordPart::Var(name) if name == "@" || name == "*" => {
                let all = self.params.all();
                if all.is_empty() {
                    Some(Vec::new())
                } else if name == "*" {
                    let joined = all.join(&ifs_sep.to_string());
                    Some(vec![joined])
                } else {
                    Some(all.to_vec())
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
            WordPart::Var(name) => self.expand_var(name, true),
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

    fn expand_var(&mut self, name: &str, check_nounset: bool) -> String {
        match name {
            "?" => self.last_exit.to_string(),
            "#" => self.params.count().to_string(),
            "@" => self.params.all().join(" "),
            "*" => {
                let ifs_sep = self.env.get("IFS")
                    .map(|v| v.as_scalar().chars().next().unwrap_or(' '))
                    .unwrap_or(' ');
                self.params.all().join(&ifs_sep.to_string())
            }
            "!" => self.env.get("!").map(|v| v.as_scalar().to_string()).unwrap_or_default(),
            _ => {
                if let Ok(n) = name.parse::<usize>() {
                    return self.params.get(n).unwrap_or("").to_string();
                }
                if check_nounset && self.options.nounset && !self.env.contains_key(name) {
                    io::write_stderr(&format!("msh: {}: unbound variable\n", name));
                    self.last_exit = 1;
                    self.exit_requested = true;
                    return String::new();
                }
                self.env.get(name).map(|v| v.as_scalar().to_string()).unwrap_or_default()
            }
        }
    }

    fn expand_brace_var(&mut self, raw: &str) -> String {
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
            return self.expand_var(inner, true).len().to_string();
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
            let val = self.expand_var(var_name, true);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_all(&val, pat, rep);
        }

        // ${VAR/pat/rep} — replace first occurrence (glob-based)
        if let Some(pat_rep) = op_and_rest.strip_prefix('/') {
            let val = self.expand_var(var_name, true);
            let (pat, rep) = pat_rep.split_once('/').unwrap_or((pat_rep, ""));
            return glob_replace_first(&val, pat, rep);
        }

        // ${VAR##pat} — remove longest matching prefix (check before single #)
        if let Some(pat) = op_and_rest.strip_prefix("##") {
            let val = self.expand_var(var_name, true);
            return remove_longest_prefix(&val, pat);
        }

        // ${VAR#pat} — remove shortest matching prefix
        if let Some(pat) = op_and_rest.strip_prefix('#') {
            let val = self.expand_var(var_name, true);
            return remove_shortest_prefix(&val, pat);
        }

        // ${VAR%%pat} — remove longest matching suffix (check before single %)
        if let Some(pat) = op_and_rest.strip_prefix("%%") {
            let val = self.expand_var(var_name, true);
            return remove_longest_suffix(&val, pat);
        }

        // ${VAR%pat} — remove shortest matching suffix
        if let Some(pat) = op_and_rest.strip_prefix('%') {
            let val = self.expand_var(var_name, true);
            return remove_shortest_suffix(&val, pat);
        }

        // ${VAR:...} — substring or default/alternate
        if let Some(colon_rest) = op_and_rest.strip_prefix(':') {
            // ${VAR:-default} — default if empty (nounset should NOT fire here)
            if let Some(default) = colon_rest.strip_prefix('-') {
                let val = self.expand_var(var_name, false);
                return if val.is_empty() { default.to_string() } else { val };
            }
            // ${VAR:+alt} — alternate if not empty (nounset should NOT fire here)
            if let Some(alt) = colon_rest.strip_prefix('+') {
                let val = self.expand_var(var_name, false);
                return if val.is_empty() { String::new() } else { alt.to_string() };
            }
            // ${VAR:offset} or ${VAR:offset:length} — substring (digit or minus sign)
            if colon_rest.starts_with(|c: char| c.is_ascii_digit() || c == '-') {
                let val = self.expand_var(var_name, true);
                return shell_substring(&val, colon_rest);
            }
        }

        // Plain ${VAR} — but use raw if var_name is empty (shouldn't happen) or op is empty
        if op_and_rest.is_empty() {
            self.expand_var(var_name, true)
        } else {
            self.expand_var(raw, true)
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

    /// Execute a list, applying the given redirects. On the non-test path, if redirects include
    /// a stdout redirect, the body is executed with `exec_list_with_stdout`. Otherwise falls back
    /// to `exec_list`. On the test path, redirects are ignored.
    #[cfg(not(test))]
    pub(crate) fn exec_list_redirected(
        &mut self,
        list: List,
        redirects: &[crate::parser::Redirect],
    ) -> u8 {
        if redirects.is_empty() {
            return self.exec_list(list);
        }
        let mut stdin_opt: Option<crate::bindings::mithic::process::types::InputStream> = None;
        let mut stdout_opt: Option<crate::bindings::mithic::process::types::OutputStream> = None;
        let mut stderr_opt: Option<crate::bindings::mithic::process::types::OutputStream> = None;
        if !self.apply_redirects(redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
            return 1;
        }
        match stdout_opt {
            Some(out) => self.exec_list_with_stdout(list, out),
            None => self.exec_list(list),
        }
    }

    #[cfg(test)]
    pub(crate) fn exec_list_redirected(
        &mut self,
        list: List,
        _redirects: &[crate::parser::Redirect],
    ) -> u8 {
        self.exec_list(list)
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
    #[cfg(not(test))]
    fn exec_while_inner(&mut self, cmd: crate::parser::WhileCommand, invert: bool) -> u8 {
        use crate::bindings::mithic::process::manager as proc_manager;

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
                    let duped = proc_manager::dup_output_stream(out);
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

    #[cfg(test)]
    fn exec_while_inner(&mut self, cmd: crate::parser::WhileCommand, invert: bool) -> u8 {
        self.in_loop_depth += 1;
        let mut exit = 0u8;
        loop {
            self.in_condition += 1;
            let cond = self.exec_list(cmd.condition.clone());
            self.in_condition -= 1;
            let keep_looping = if invert { cond != 0 } else { cond == 0 };
            if !keep_looping { break; }
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
            None => self.params.all().to_vec(),
        };

        self.exec_for_inner(cmd.var, items, cmd.body, &cmd.redirects)
    }

    #[cfg(not(test))]
    fn exec_for_inner(
        &mut self,
        var: String,
        items: Vec<String>,
        body: List,
        redirects: &[crate::parser::Redirect],
    ) -> u8 {
        use crate::bindings::mithic::process::manager as proc_manager;

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
                    let duped = proc_manager::dup_output_stream(out);
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

    #[cfg(test)]
    fn exec_for_inner(
        &mut self,
        var: String,
        items: Vec<String>,
        body: List,
        _redirects: &[crate::parser::Redirect],
    ) -> u8 {
        self.in_loop_depth += 1;
        let mut exit = 0u8;
        for item in items {
            self.env.insert(var.clone(), ShellValue::Scalar(item));
            exit = self.exec_list(body.clone());
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

    #[cfg(not(test))]
    pub(crate) fn test_file(&self, op: &str, path: &str) -> bool {
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
    pub(crate) fn test_file(&self, _op: &str, _path: &str) -> bool { false }

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

}


#[cfg(not(test))]
pub(crate) fn get_root_descriptor() -> Option<crate::bindings::wasi::filesystem::types::Descriptor> {
    use crate::bindings::wasi::filesystem::preopens;
    preopens::get_directories().into_iter().find(|(_, p)| p == "/").map(|(d, _)| d)
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


