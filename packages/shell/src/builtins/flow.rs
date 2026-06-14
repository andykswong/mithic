use std::time::Instant;
use crate::runtime::{InputHandle, OutputHandle, Runtime, SpawnOpts};
use crate::shell::Shell;
use crate::parser::Parser;
use crate::value::ShellValue;
use super::write_out;

pub(crate) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "break" => {
            if shell.in_loop_depth == 0 {
                shell.rt.write_stderr(&format!("{}: break: only meaningful in a loop\n", shell.shell_name));
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.break_depth = n;
            0
        }
        "continue" => {
            if shell.in_loop_depth == 0 {
                shell.rt.write_stderr(&format!("{}: continue: only meaningful in a loop\n", shell.shell_name));
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.continue_depth = n;
            0
        }
        "return" => {
            if shell.in_function_depth == 0 {
                shell.rt.write_stderr(&format!("{}: return: can only return from a function or sourced script\n", shell.shell_name));
                return 1;
            }
            let code: u8 = args.first().and_then(|s| s.parse().ok()).unwrap_or(shell.last_exit);
            shell.return_requested = true;
            code
        }
        "source" if shell.options.posix => {
            shell.rt.write_stderr(&format!("{}: source: not found (POSIX mode: use '.' instead)\n", shell.shell_name));
            127
        }
        "source" | "." => {
            let file = match args.first() {
                Some(f) => f.clone(),
                None => {
                    shell.rt.write_stderr(&format!("{}: source: filename argument required\n", shell.shell_name));
                    return 2;
                }
            };
            exec_source(shell, &file)
        }
        "eval" => {
            let input = args.join(" ");
            if input.is_empty() {
                return 0;
            }
            let mut parser = Parser::new_with_mode(&input, shell.options.posix);
            if let Some(list) = parser.parse() {
                shell.exec_list(list)
            } else {
                shell.rt.write_stderr(&format!("{}: eval: parse error\n", shell.shell_name));
                1
            }
        }
        "shift" => {
            let n: usize = args.first()
                .and_then(|s| s.parse().ok())
                .unwrap_or(1);
            shell.params.shift(n);
            0
        }
        "type" => {
            let mut exit = 0u8;
            for arg in args {
                if crate::builtins::lookup_builtin::<R>(arg).is_some() {
                    let msg = format!("{} is a shell builtin\n", arg);
                    write_out(shell, &stdout, &msg);
                } else if shell.functions.contains_key(arg) {
                    let msg = format!("{} is a function\n", arg);
                    write_out(shell, &stdout, &msg);
                } else if let Some(path) = resolve_command_path(shell, arg) {
                    let msg = format!("{} is {}\n", arg, path);
                    write_out(shell, &stdout, &msg);
                } else {
                    shell.rt.write_stderr(&format!("type: {}: not found\n", arg));
                    exit = 1;
                }
            }
            exit
        }
        "command" => {
            if args.is_empty() {
                return 0;
            }
            if args[0] == "-v" {
                let mut exit = 0u8;
                for arg in &args[1..] {
                    if crate::builtins::lookup_builtin::<R>(arg).is_some() || shell.functions.contains_key(arg) {
                        let msg = format!("{}\n", arg);
                        write_out(shell, &stdout, &msg);
                    } else if let Some(path) = resolve_command_path(shell, arg) {
                        let msg = format!("{}\n", path);
                        write_out(shell, &stdout, &msg);
                    } else {
                        exit = 1;
                    }
                }
                exit
            } else {
                let name = args[0].clone();
                if let Some(f) = crate::builtins::lookup_builtin::<R>(&name) {
                    f(shell, &name, &args[1..], stdin, stdout)
                } else {
                    let env = shell.env_list();
                    let opts = SpawnOpts { cwd: Some(shell.cwd.clone()),
                        env: Some(env),
                        stdin,
                        stdout,
                        stderr: None,
                    };
                    match shell.rt.spawn(&name, &args[1..], opts) {
                        Ok(proc) => shell.rt.wait(&proc),
                        Err(_) => {
                            shell.rt.write_stderr(&format!("{}: {}: command not found\n", shell.shell_name, name));
                            127
                        }
                    }
                }
            }
        }
        "exec" => exec_exec(shell, args, stdin, stdout),
        "hash" => exec_hash(shell, args, stdout),
        "history" => {
            if args.first().map(|s| s.as_str()) == Some("-c") {
                shell.history.clear();
                return 0;
            }
            let entries: Vec<String> = shell.history
                .iter()
                .enumerate()
                .map(|(i, cmd)| format!("  {}  {}\n", i + 1, cmd))
                .collect();
            for line in entries {
                write_out(shell, &stdout, &line);
            }
            0
        }
        "fc" => {
            if args.first().map(|s| s.as_str()) == Some("-l") {
                let entries: Vec<String> = shell.history
                    .iter()
                    .enumerate()
                    .map(|(i, cmd)| format!("  {}  {}\n", i + 1, cmd))
                    .collect();
                for line in entries {
                    write_out(shell, &stdout, &line);
                }
            }
            0
        }
        "coproc" => {
            shell.rt.write_stderr(&format!("{}: coproc: not yet supported in WASM environment\n", shell.shell_name));
            1
        }
        "time" => {
            let start = Instant::now();
            let exit = if args.is_empty() {
                0
            } else {
                let input = args.join(" ");
                let mut parser = Parser::new_with_mode(&input, shell.options.posix);
                if let Some(list) = parser.parse() {
                    shell.exec_list(list)
                } else {
                    0
                }
            };
            let elapsed = start.elapsed();
            let total_secs = elapsed.as_secs_f64();
            let mins = total_secs as u64 / 60;
            let secs = total_secs - (mins as f64 * 60.0);
            shell.rt.write_stderr(&format!("\nreal\t{}m{:.3}s\n", mins, secs));
            exit
        }
        "builtin" => {
            if args.is_empty() {
                return 0;
            }
            let builtin_name = &args[0];
            if let Some(f) = crate::builtins::lookup_builtin::<R>(builtin_name) {
                f(shell, builtin_name, &args[1..], stdin, stdout)
            } else {
                shell.rt.write_stderr(&format!("{}: builtin: {}: not a shell builtin\n", shell.shell_name, builtin_name));
                1
            }
        }
        "alias" => {
            if args.is_empty() {
                let mut entries: Vec<(String, String)> = shell.aliases.iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                entries.sort_by(|(a, _), (b, _)| a.cmp(b));
                for (name, value) in entries {
                    let msg = format!("alias {}='{}'\n", name, value);
                    write_out(shell, &stdout, &msg);
                }
                return 0;
            }
            let mut exit = 0u8;
            for arg in args {
                if let Some(eq_pos) = arg.find('=') {
                    let alias_name = &arg[..eq_pos];
                    let alias_value = &arg[eq_pos + 1..];
                    shell.aliases.insert(alias_name.to_string(), alias_value.to_string());
                } else {
                    if let Some(value) = shell.aliases.get(arg) {
                        let msg = format!("alias {}='{}'\n", arg, value);
                        write_out(shell, &stdout, &msg);
                    } else {
                        shell.rt.write_stderr(&format!("{}: alias: {}: not found\n", shell.shell_name, arg));
                        exit = 1;
                    }
                }
            }
            exit
        }
        "unalias" => {
            if args.is_empty() {
                shell.rt.write_stderr(&format!("{}: unalias: usage: unalias [-a] name [name ...]\n", shell.shell_name));
                return 2;
            }
            if args.len() == 1 && args[0] == "-a" {
                shell.aliases.clear();
                return 0;
            }
            let mut exit = 0u8;
            for arg in args {
                if arg == "-a" {
                    shell.aliases.clear();
                } else if shell.aliases.remove(arg).is_none() {
                    shell.rt.write_stderr(&format!("{}: unalias: {}: not found\n", shell.shell_name, arg));
                    exit = 1;
                }
            }
            exit
        }
        "pushd" => {
            if args.is_empty() {
                if shell.dir_stack.is_empty() {
                    shell.rt.write_stderr(&format!("{}: pushd: no other directory\n", shell.shell_name));
                    return 1;
                }
                let top = shell.dir_stack.last().unwrap().clone();
                let old_cwd = shell.cwd.clone();
                *shell.dir_stack.last_mut().unwrap() = old_cwd.clone();
                let resolved = shell.resolve_path(&top);
                let prev_cwd = shell.cwd.clone();
                shell.cwd = resolved;
                shell.env.insert("OLDPWD".to_string(), ShellValue::Scalar(prev_cwd));
                shell.env.insert("PWD".to_string(), ShellValue::Scalar(shell.cwd.clone()));
            } else {
                let dir = &args[0];
                let resolved = shell.resolve_path(dir);
                let old_cwd = shell.cwd.clone();
                shell.dir_stack.push(old_cwd.clone());
                let prev_cwd = shell.cwd.clone();
                shell.cwd = resolved;
                shell.env.insert("OLDPWD".to_string(), ShellValue::Scalar(prev_cwd));
                shell.env.insert("PWD".to_string(), ShellValue::Scalar(shell.cwd.clone()));
            }
            let mut stack_str = shell.cwd.clone();
            for entry in shell.dir_stack.iter().rev() {
                stack_str.push(' ');
                stack_str.push_str(entry);
            }
            stack_str.push('\n');
            write_out(shell, &stdout, &stack_str);
            0
        }
        "popd" => {
            if shell.dir_stack.is_empty() {
                shell.rt.write_stderr(&format!("{}: popd: directory stack empty\n", shell.shell_name));
                return 1;
            }
            let dir = shell.dir_stack.pop().unwrap();
            let prev_cwd = shell.cwd.clone();
            shell.cwd = dir;
            shell.env.insert("OLDPWD".to_string(), ShellValue::Scalar(prev_cwd));
            shell.env.insert("PWD".to_string(), ShellValue::Scalar(shell.cwd.clone()));
            let mut stack_str = shell.cwd.clone();
            for entry in shell.dir_stack.iter().rev() {
                stack_str.push(' ');
                stack_str.push_str(entry);
            }
            stack_str.push('\n');
            write_out(shell, &stdout, &stack_str);
            0
        }
        "dirs" => {
            if args.first().map(|s| s.as_str()) == Some("-c") {
                shell.dir_stack.clear();
                return 0;
            }
            let mut stack_str = shell.cwd.clone();
            for entry in shell.dir_stack.iter().rev() {
                stack_str.push(' ');
                stack_str.push_str(entry);
            }
            stack_str.push('\n');
            write_out(shell, &stdout, &stack_str);
            0
        }
        _ => {
            shell.rt.write_stderr(&format!("{}: {}: not handled in flow builtin\n", shell.shell_name, name));
            127
        }
    }
}

fn exec_exec<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    // `exec` with no args and redirects: redirects are applied by the caller already via
    // apply_redirects. With no command, we just honour the side-effects (stdout replacement).
    if args.is_empty() {
        // Redirects were applied before dispatch; nothing more to do.
        return 0;
    }

    // `exec cmd [args...]` — replace the shell with cmd.
    // In WASM there is no true exec(2), so we spawn and wait, then exit.
    let cmd = &args[0];
    let cmd_args = &args[1..];
    let env = shell.env_list();
    let opts = SpawnOpts { cwd: Some(shell.cwd.clone()),
        env: Some(env),
        stdin,
        stdout,
        stderr: None,
    };
    match shell.rt.spawn(cmd, cmd_args, opts) {
        Ok(proc) => {
            let exit = shell.rt.wait(&proc);
            shell.exit_requested = true;
            exit
        }
        Err(_) => {
            shell.rt.write_stderr(&format!("{}: exec: {}: command not found\n", shell.shell_name, cmd));
            127
        }
    }
}

fn exec_hash<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdout: Option<OutputHandle>,
) -> u8 {
    if args.is_empty() {
        let mut entries: Vec<(String, String)> = shell.hash_table.iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        for (name, path) in entries {
            let msg = format!("{}={}\n", name, path);
            write_out(shell, &stdout, &msg);
        }
        return 0;
    }

    if args.len() == 1 && args[0] == "-r" {
        shell.hash_table.clear();
        return 0;
    }

    let path_var = shell.env.get("PATH")
        .map(|v| v.as_scalar().to_string())
        .unwrap_or_default();
    let dirs: Vec<&str> = path_var.split(':').collect();

    let mut exit = 0u8;
    for name in args {
        if name == "-r" {
            continue;
        }
        let mut found = false;
        for dir in &dirs {
            let candidate = if dir.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", dir, name)
            };
            if shell.rt.file_exists(&candidate) {
                shell.hash_table.insert(name.clone(), candidate);
                found = true;
                break;
            }
        }
        if !found {
            shell.rt.write_stderr(&format!("{}: hash: {}: not found\n", shell.shell_name, name));
            exit = 1;
        }
    }
    exit
}

fn resolve_command_path<R: Runtime>(shell: &Shell<R>, name: &str) -> Option<String> {
    if let Some(path) = shell.hash_table.get(name) {
        return Some(path.clone());
    }
    let path_var = shell.env.get("PATH")
        .map(|v| v.as_scalar().to_string())
        .unwrap_or_default();
    for dir in path_var.split(':') {
        let candidate = if dir.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", dir, name)
        };
        if shell.rt.file_exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn exec_source<R: Runtime>(shell: &mut Shell<R>, file: &str) -> u8 {
    let path = shell.resolve_path(file);
    let contents = shell.rt.read_file(&path);
    if contents.is_empty() {
        shell.rt.write_stderr(&format!("{}: source: {}: No such file or directory\n", shell.shell_name, file));
        return 1;
    }

    let script = String::from_utf8_lossy(&contents);
    let mut parser = Parser::new_with_mode(&script, shell.options.posix);
    if let Some(list) = parser.parse() {
        shell.call_stack.push(crate::shell::CallFrame {
            function_name: "source".to_string(),
            source_file: path.clone(),
            call_line: shell.current_line,
        });
        let prev_source_file = std::mem::replace(&mut shell.current_source_file, path);
        shell.in_function_depth += 1;
        let result = shell.exec_list(list);
        shell.in_function_depth -= 1;
        shell.return_requested = false;
        shell.current_source_file = prev_source_file;
        shell.call_stack.pop();
        result
    } else {
        0
    }
}
