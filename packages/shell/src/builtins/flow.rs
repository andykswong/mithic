use crate::runtime::{InputHandle, OutputHandle, Runtime, SpawnOpts};
use crate::shell::Shell;
use crate::parser::Parser;
use super::write_out;

pub(super) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "break" => {
            if shell.in_loop_depth == 0 {
                shell.rt.write_stderr("msh: break: only meaningful in a loop\n");
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.break_depth = n;
            0
        }
        "continue" => {
            if shell.in_loop_depth == 0 {
                shell.rt.write_stderr("msh: continue: only meaningful in a loop\n");
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.continue_depth = n;
            0
        }
        "return" => {
            if shell.in_function_depth == 0 {
                shell.rt.write_stderr("msh: return: can only return from a function or sourced script\n");
                return 1;
            }
            let code: u8 = args.first().and_then(|s| s.parse().ok()).unwrap_or(shell.last_exit);
            shell.return_requested = true;
            code
        }
        "source" | "." => {
            let file = match args.first() {
                Some(f) => f.clone(),
                None => {
                    shell.rt.write_stderr("msh: source: filename argument required\n");
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
            let mut parser = Parser::new(&input);
            if let Some(list) = parser.parse() {
                shell.exec_list(list)
            } else {
                shell.rt.write_stderr("msh: eval: parse error\n");
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
                if Shell::<R>::is_builtin(arg) {
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
                    if Shell::<R>::is_builtin(arg) || shell.functions.contains_key(arg) {
                        let msg = format!("{}\n", arg);
                        write_out(shell, &stdout, &msg);
                    } else {
                        exit = 1;
                    }
                }
                exit
            } else {
                let name = args[0].clone();
                if Shell::<R>::is_builtin(&name) {
                    shell.exec_builtin(&name, &args[1..], stdin, stdout)
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
                            shell.rt.write_stderr(&format!("msh: {}: command not found\n", name));
                            127
                        }
                    }
                }
            }
        }
        "exec" => exec_exec(shell, args, stdin, stdout),
        "hash" => 0,
        _ => {
            shell.rt.write_stderr(&format!("msh: {}: not handled in flow builtin\n", name));
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
            shell.rt.write_stderr(&format!("msh: exec: {}: command not found\n", cmd));
            127
        }
    }
}

fn exec_source<R: Runtime>(shell: &mut Shell<R>, file: &str) -> u8 {
    let path = shell.resolve_path(file);
    let contents = shell.rt.read_file(&path);
    if contents.is_empty() {
        shell.rt.write_stderr(&format!("msh: source: {}: No such file or directory\n", file));
        return 1;
    }

    let script = String::from_utf8_lossy(&contents);
    let mut parser = Parser::new(&script);
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
