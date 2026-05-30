use crate::runtime::{OutputHandle, Runtime};
use crate::shell::Shell;
use crate::parser::{Command, List, ListItem, ListOp};
use crate::parser::{ArrayAssign, Redirect};
use crate::value::ShellValue;
use crate::executor::expansion::glob_match;

impl<R: Runtime> Shell<R> {
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

    /// Execute a list, applying the given redirects. If redirects include a stdout redirect,
    /// the body is executed with `exec_list_with_stdout`. Otherwise falls back to `exec_list`.
    pub(crate) fn exec_list_redirected(
        &mut self,
        list: List,
        redirects: &[Redirect],
    ) -> u8 {
        if redirects.is_empty() {
            return self.exec_list(list);
        }
        let mut stdin_opt = None;
        let mut stdout_opt = None;
        let mut stderr_opt = None;
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
            Command::CFor(cf) => self.exec_cfor(cf),
            Command::Case(cc) => self.exec_case(cc),
            Command::Select(sc) => self.exec_select(sc),
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
        if self.options.posix {
            self.rt.write_stderr(&format!("{}: arrays not supported in POSIX mode\n", self.shell_name));
            return 2;
        }
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
        redirects: &[Redirect],
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

    fn exec_cfor(&mut self, cf: crate::parser::CForCommand) -> u8 {
        // Open redirect streams once before the loop.
        let loop_stdout = if !cf.redirects.is_empty() {
            let mut stdin_opt = None;
            let mut stdout_opt = None;
            let mut stderr_opt = None;
            if !self.apply_redirects(&cf.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                return 1;
            }
            stdout_opt
        } else {
            None
        };

        // Execute init expression
        if !cf.init.is_empty() {
            self.eval_arithmetic(&cf.init);
        }

        self.in_loop_depth += 1;
        let mut exit = 0u8;

        loop {
            // Evaluate condition (empty = infinite loop)
            if !cf.cond.is_empty() {
                let result: i64 = self.eval_arithmetic(&cf.cond).parse().unwrap_or(0);
                if result == 0 {
                    break;
                }
            }

            // Execute body
            exit = match &loop_stdout {
                Some(out) => {
                    let duped = self.rt.dup_output(out);
                    self.exec_list_with_stdout(cf.body.clone(), duped)
                }
                None => self.exec_list(cf.body.clone()),
            };
            self.last_exit = exit;

            if self.exit_requested || self.return_requested {
                break;
            }
            if self.break_depth > 0 {
                self.break_depth -= 1;
                break;
            }
            if self.continue_depth > 0 {
                self.continue_depth -= 1;
                // fall through to step
            }

            // Execute step expression
            if !cf.step.is_empty() {
                self.eval_arithmetic(&cf.step);
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

    fn exec_select(&mut self, cmd: crate::parser::SelectCommand) -> u8 {
        let items: Vec<String> = cmd.words.iter()
            .flat_map(|w| self.expand_word_to_args(w))
            .collect();

        if items.is_empty() {
            return 0;
        }

        // Display the menu
        let menu: String = items.iter()
            .enumerate()
            .map(|(i, item)| format!("{}) {}", i + 1, item))
            .collect::<Vec<_>>()
            .join("\n");

        self.in_loop_depth += 1;
        let mut exit = 0u8;

        let ps3 = self.env.get("PS3")
            .map(|v| v.as_scalar().to_string())
            .unwrap_or_else(|| "#? ".to_string());

        loop {
            // Print menu to stderr (like bash does)
            self.rt.write_stderr(&format!("{}\n", menu));
            // Print PS3 prompt
            self.rt.write_stderr(&ps3);

            // Read user input
            let input = match self.rt.read_line() {
                Some(line) => line.trim().to_string(),
                None => break, // EOF
            };

            // Set REPLY to the raw input
            self.env.insert("REPLY".to_string(), ShellValue::Scalar(input.clone()));

            // Determine the selected value
            let selected = if let Ok(n) = input.parse::<usize>() {
                if n >= 1 && n <= items.len() {
                    items[n - 1].clone()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            self.env.insert(cmd.var.clone(), ShellValue::Scalar(selected));

            // Execute body
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

    pub(crate) fn exec_function_call(&mut self, args: &[String], body: Command) -> u8 {
        let funcnest: usize = self.env.get("FUNCNEST")
            .and_then(|v| v.as_scalar().parse().ok())
            .unwrap_or(1000);
        if funcnest > 0 && self.in_function_depth >= funcnest {
            self.rt.write_stderr(&format!(
                "{}: maximum function nesting level exceeded ({})\n",
                self.shell_name, funcnest
            ));
            return 1;
        }
        self.params.push_frame(args.to_vec());
        self.in_function_depth += 1;
        self.local_scopes.push(std::collections::HashMap::new());
        let exit = self.exec_compound(body);
        if let Some(scope) = self.local_scopes.pop() {
            for (name, prev_value) in scope {
                match prev_value {
                    Some(val) => { self.env.insert(name, val); }
                    None => { self.env.remove(&name); }
                }
            }
        }
        self.in_function_depth -= 1;
        self.return_requested = false;
        self.params.pop_frame();
        exit
    }
}
