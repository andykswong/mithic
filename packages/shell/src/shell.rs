use std::collections::HashMap;

use crate::bindings::mithic::process::manager as proc_manager;
use crate::bindings::mithic::process::types::{InputStream, OutputStream, SpawnOptions};
use crate::bindings::wasi::cli::{environment, terminal_stdin};
use crate::io::{self, LineReader};
use crate::parser::{ArrayAssign, Command, List, ListItem, ListOp, Parser, Pipeline, SimpleCommand, Word, WordPart};
use crate::value::ShellValue;

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

        if args.is_empty() {
            return 0;
        }

        // Detect scalar/indexed-array assignment from expanded first arg.
        // This covers `VAR=value` or `arr[0]=value` as the sole word.
        if args.len() == 1 {
            if let Some(exit) = self.try_assignment(&args[0]) {
                return exit;
            }
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
                Ok(proc) => proc.wait() as u8,
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
            "return" | "source" | "." | "read" | "test" | "[" | "[["
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
                for arg in args { self.env.remove(arg.as_str()); }
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
            _ => 127,
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
                .flat_map(|w| {
                    let expanded = self.expand_word(w);
                    if has_glob(&expanded) { self.expand_glob(&expanded) } else { vec![expanded] }
                })
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

    fn env_list(&self) -> Vec<(String, String)> {
        self.env.iter().map(|(k, v)| (k.clone(), v.as_scalar().to_string())).collect()
    }

    fn resolve_path(&self, path: &str) -> String {
        let home = self.env.get("HOME").map(|v| v.as_scalar()).unwrap_or("/");
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
                let home = self.env.get("HOME").map(|v| v.as_scalar()).unwrap_or("/");
                expand_tilde(s, home)
            }
            WordPart::Var(name) => self.expand_var(name),
            WordPart::BraceVar(raw) => self.expand_brace_var(raw),
            WordPart::CmdSub(raw) => self.exec_capturing(raw),
            WordPart::ArithSub(expr) => self.eval_arithmetic(expr),
        }
    }

    fn eval_arithmetic(&mut self, expr: &str) -> String {
        let env_snapshot: std::collections::HashMap<String, i64> = self.env.iter()
            .map(|(k, v)| (k.clone(), v.as_scalar().parse::<i64>().unwrap_or(0)))
            .collect();
        let lookup = |name: &str| -> i64 { *env_snapshot.get(name).unwrap_or(&0) };
        let mut assignments: Vec<(String, i64)> = Vec::new();
        let mut assign = |name: &str, val: i64| { assignments.push((name.to_string(), val)); };
        let result = crate::arith::eval(expr, &lookup, &mut assign);
        for (name, val) in assignments {
            self.env.insert(name, ShellValue::Scalar(val.to_string()));
        }
        result.to_string()
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
                // ${#arr[n]} — length of element at index
                if let Ok(idx) = subscript.parse::<usize>() {
                    return match self.env.get(arr_name) {
                        Some(v) => v.index(idx).len().to_string(),
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
                    } else if let Ok(idx) = subscript.parse::<usize>() {
                        v.index(idx).to_string()
                    } else {
                        String::new()
                    }
                }
                None => String::new(),
            };
        }

        if let Some((name, rest)) = raw.split_once(":-") {
            let val = self.expand_var(name);
            if val.is_empty() { rest.to_string() } else { val }
        } else if let Some((name, alt)) = raw.split_once(":+") {
            let val = self.expand_var(name);
            if val.is_empty() { String::new() } else { alt.to_string() }
        } else {
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
        }
    }

    fn exec_array_assign(&mut self, aa: ArrayAssign) -> u8 {
        let elements: Vec<String> = aa.elements.iter()
            .flat_map(|w| {
                let expanded = self.expand_word(w);
                if has_glob(&expanded) {
                    self.expand_glob(&expanded)
                } else {
                    vec![expanded]
                }
            })
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
                .flat_map(|w| {
                    let expanded = self.expand_word(w);
                    if has_glob(&expanded) {
                        self.expand_glob(&expanded)
                    } else {
                        vec![expanded]
                    }
                })
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
        use crate::parser::Redirect;

        let root = match get_root_descriptor() {
            Some(d) => d,
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

/// Return the literal string of a Word if it consists solely of `Literal` parts.
fn literal_text(word: &Word) -> Option<String> {
    let mut s = String::new();
    for part in word.parts() {
        match part {
            WordPart::Literal(l) => s.push_str(l),
            _ => return None,
        }
    }
    Some(s)
}

/// Parse `name[subscript]` from a string; returns `(name, subscript)` or `None`.
fn parse_array_subscript(s: &str) -> Option<(&str, &str)> {
    let open = s.find('[')?;
    let close = s.rfind(']')?;
    if close <= open { return None; }
    let name = &s[..open];
    let subscript = &s[open + 1..close];
    if name.is_empty() { return None; }
    Some((name, subscript))
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

#[cfg(not(test))]
fn get_root_descriptor() -> Option<crate::bindings::wasi::filesystem::types::Descriptor> {
    use crate::bindings::wasi::filesystem::preopens;
    preopens::get_directories().into_iter().find(|(_, p)| p == "/").map(|(d, _)| d)
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
