use crate::runtime::{InputHandle, OutputHandle, ProcessHandle, Runtime, SpawnOpts};
use crate::parser::{Command, Pipeline};
use crate::shell::{Shell, signal_name_from_num};
use crate::value::ShellValue;

/// Creates N-1 internal pipes for a pipeline of `n` stages.
///
/// Returns `(pipe_read_ends, pipe_write_ends)` where:
/// - `pipe_read_ends[i]` is the stdin for stage `i` (None for stage 0)
/// - `pipe_write_ends[i]` is the stdout for stage `i` (None for the last stage)
fn create_pipeline_pipes<R: Runtime>(shell: &mut Shell<R>, n: usize) -> (Vec<Option<InputHandle>>, Vec<Option<OutputHandle>>) {
    let mut pipe_read_ends: Vec<Option<InputHandle>> = Vec::with_capacity(n);
    let mut pipe_write_ends: Vec<Option<OutputHandle>> = Vec::with_capacity(n);

    pipe_read_ends.push(None); // stage 0: no upstream stdin
    for _ in 0..n - 1 {
        let (inp, out) = shell.rt.create_pipe();
        pipe_read_ends.push(Some(inp));  // stdin for stage i+1
        pipe_write_ends.push(Some(out)); // stdout for stage i
    }
    pipe_write_ends.push(None); // last stage: write to shell stdout

    (pipe_read_ends, pipe_write_ends)
}

impl<R: Runtime> Shell<R> {
    pub(crate) fn exec_pipeline_background(&mut self, pipeline: Pipeline) {
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

                    let mut stdin_opt: Option<InputHandle> = None;
                    let mut stdout_opt: Option<OutputHandle> = None;
                    let mut stderr_opt: Option<OutputHandle> = None;
                    if !self.apply_redirects(&sc.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                        return;
                    }

                    let env_list = self.env_list();
                    let opts = SpawnOpts {
                        env: Some(env_list),
                        stdin: stdin_opt,
                        stdout: stdout_opt,
                        stderr: stderr_opt,
                    };
                    match self.rt.spawn(&name, &args[1..], opts) {
                        Ok(proc) => {
                            let pid = self.rt.pid(&proc);
                            let job_id = self.jobs.add(vec![proc], vec![pid], display);
                            self.rt.write_stderr(&format!("[{}] {}\n", job_id, pid));
                            self.env.insert("!".to_string(), ShellValue::Scalar(pid.to_string()));
                        }
                        Err(_) => {
                            self.rt.write_stderr(&format!("msh: {}: command not found\n", name));
                        }
                    }
                }
                other => { self.exec_compound(other); }
            }
        } else {
            let (mut pipe_read_ends, mut pipe_write_ends) = create_pipeline_pipes(self, n);

            let env_list = self.env_list();
            let mut processes: Vec<ProcessHandle> = Vec::new();
            let mut pids: Vec<u32> = Vec::new();
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
                let mut stderr_opt: Option<OutputHandle> = None;
                if !self.apply_redirects(&cmd.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                    continue;
                }
                let opts = SpawnOpts {
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: stderr_opt,
                };
                match self.rt.spawn(&name, &args[1..], opts) {
                    Ok(proc) => {
                        let pid = self.rt.pid(&proc);
                        pids.push(pid);
                        processes.push(proc);
                    }
                    Err(_) => {
                        self.rt.write_stderr(&format!("msh: {}: command not found\n", name));
                    }
                }
            }

            if !processes.is_empty() {
                let last_pid = pids.last().copied().unwrap_or(0);
                let display = display_parts.join(" | ");
                let job_id = self.jobs.add(processes, pids, display);
                self.rt.write_stderr(&format!("[{}] {}\n", job_id, last_pid));
                self.env.insert("!".to_string(), ShellValue::Scalar(last_pid.to_string()));
            }
        }
    }

    pub(crate) fn exec_pipeline(&mut self, pipeline: Pipeline) -> u8 {
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
        let (mut pipe_read_ends, mut pipe_write_ends) = create_pipeline_pipes(self, n);

        let env_list = self.env_list();

        let mut processes: Vec<ProcessHandle> = Vec::new();
        let mut last_builtin_exit: Option<u8> = None;
        // Track builtin/function exits for pipefail
        let mut builtin_exits: Vec<u8> = Vec::new();

        for (i, command) in cmds.into_iter().enumerate() {
            let cmd = match command {
                Command::Simple(sc) => sc,
                other => {
                    let exit = self.exec_compound(other);
                    builtin_exits.push(exit);
                    if i == n - 1 { last_builtin_exit = Some(exit); }
                    continue;
                }
            };
            let mut stdin_opt = pipe_read_ends[i].take();
            let mut stdout_opt = pipe_write_ends[i].take();

            let args: Vec<String> = cmd.words.iter()
                .flat_map(|w| self.expand_word_to_args(w))
                .collect();
            let mut stderr_opt: Option<OutputHandle> = None;
            if !self.apply_redirects(&cmd.redirects, &mut stdin_opt, &mut stdout_opt, &mut stderr_opt) {
                for p in processes {
                    let _ = self.rt.wait(&p);
                }
                return if pipeline.negate { 0 } else { 1 };
            }

            if args.is_empty() {
                continue;
            }

            let name = args[0].clone();
            if let Some(body) = self.functions.get(&name).cloned() {
                let exit = self.exec_function_call(&args[1..], body);
                builtin_exits.push(exit);
                if i == n - 1 {
                    last_builtin_exit = Some(exit);
                }
            } else if Self::is_builtin(&name) {
                let exit = self.exec_builtin(&name, &args[1..], stdin_opt, stdout_opt);
                builtin_exits.push(exit);
                if self.exit_requested {
                    for p in processes {
                        let _ = self.rt.wait(&p);
                    }
                    return exit;
                }
                if i == n - 1 {
                    last_builtin_exit = Some(exit);
                }
            } else {
                let opts = SpawnOpts {
                    env: Some(env_list.clone()),
                    stdin: stdin_opt,
                    stdout: stdout_opt,
                    stderr: stderr_opt,
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

        self.foreground_pids = processes.iter().map(|p| self.rt.pid(p)).collect();

        let last_proc = processes.pop();
        // Collect intermediate process exits (for pipefail)
        let intermediate_exits: Vec<u8> = processes.into_iter().map(|p| self.rt.wait(&p)).collect();

        let last_exit = if let Some(p) = last_proc {
            self.rt.wait(&p)
        } else {
            last_builtin_exit.unwrap_or(self.last_exit)
        };

        let exit = if self.options.pipefail {
            // Combine all exits: builtin/function exits + intermediate process exits + last exit
            let mut all_exits = builtin_exits;
            all_exits.extend(intermediate_exits);
            all_exits.push(last_exit);
            // Return last (rightmost) non-zero exit code, or 0 if all succeeded
            all_exits.iter().rev().find(|&&e| e != 0).copied().unwrap_or(0)
        } else {
            last_exit
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
}
