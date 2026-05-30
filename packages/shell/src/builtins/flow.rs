use crate::runtime::{InputHandle, OutputHandle, Runtime, SpawnOpts};
use crate::shell::Shell;
use crate::parser::Parser;
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
                    let opts = SpawnOpts {
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
    let opts = SpawnOpts {
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
        shell.in_function_depth += 1;
        let result = shell.exec_list(list);
        shell.in_function_depth -= 1;
        shell.return_requested = false;
        result
    } else {
        0
    }
}
