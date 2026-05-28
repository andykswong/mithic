use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use crate::parser::Parser;

pub(super) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    _stdin: Option<InputHandle>,
    _stdout: Option<OutputHandle>,
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
        _ => {
            shell.rt.write_stderr(&format!("msh: {}: not handled in flow builtin\n", name));
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
