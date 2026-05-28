#[cfg(not(test))]
use crate::shell::Shell;
#[cfg(not(test))]
use crate::bindings::mithic::process::types::{InputStream, OutputStream};
#[cfg(not(test))]
use crate::io;

#[cfg(not(test))]
pub(super) fn exec_builtin(
    shell: &mut Shell,
    name: &str,
    args: &[String],
    _stdin: Option<InputStream>,
    _stdout: Option<OutputStream>,
) -> u8 {
    match name {
        "break" => {
            if shell.in_loop_depth == 0 {
                io::write_stderr("msh: break: only meaningful in a loop\n");
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.break_depth = n;
            0
        }
        "continue" => {
            if shell.in_loop_depth == 0 {
                io::write_stderr("msh: continue: only meaningful in a loop\n");
                return 1;
            }
            let n: usize = args.first().and_then(|s| s.parse().ok()).unwrap_or(1);
            shell.continue_depth = n;
            0
        }
        "return" => {
            if shell.in_function_depth == 0 {
                io::write_stderr("msh: return: can only return from a function or sourced script\n");
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
                    io::write_stderr("msh: source: filename argument required\n");
                    return 2;
                }
            };
            exec_source(shell, &file)
        }
        _ => {
            io::write_stderr(&format!("msh: {}: not handled in flow builtin\n", name));
            127
        }
    }
}

#[cfg(not(test))]
fn exec_source(shell: &mut Shell, file: &str) -> u8 {
    use crate::bindings::wasi::filesystem::types::{DescriptorFlags, OpenFlags, PathFlags};
    use crate::shell::get_root_descriptor;
    use crate::parser::Parser;

    let path = shell.resolve_path(file);
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
        shell.in_function_depth += 1;
        let result = shell.exec_list(list);
        shell.in_function_depth -= 1;
        shell.return_requested = false;
        result
    } else {
        0
    }
}
