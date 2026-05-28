#[cfg(not(test))]
use crate::shell::Shell;
#[cfg(not(test))]
use crate::bindings::mithic::process::types::{InputStream, OutputStream};
#[cfg(not(test))]
use crate::io;
#[cfg(not(test))]
use crate::value::ShellValue;
#[cfg(not(test))]
use super::write_out;

#[cfg(not(test))]
pub(super) fn exec_builtin(
    shell: &mut Shell,
    name: &str,
    args: &[String],
    _stdin: Option<InputStream>,
    stdout: Option<OutputStream>,
) -> u8 {
    match name {
        "exit" => {
            let code: u8 = args.first()
                .and_then(|s| s.parse().ok())
                .unwrap_or(shell.last_exit);
            shell.exit_requested = true;
            code
        }
        "echo" => {
            let output = args.join(" ");
            write_out(&stdout, &output);
            write_out(&stdout, "\n");
            0
        }
        "pwd" => {
            write_out(&stdout, &shell.cwd);
            write_out(&stdout, "\n");
            0
        }
        "cd" => {
            let target = args.first().cloned()
                .unwrap_or_else(|| shell.env.get("HOME").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "/".to_string()));
            let resolved = shell.resolve_path(&target);
            shell.cwd = resolved;
            shell.env.insert("PWD".to_string(), ShellValue::Scalar(shell.cwd.clone()));
            0
        }
        "env" => {
            for (key, value) in &shell.env {
                write_out(&stdout, &format!("{}={}\n", key, value.as_scalar()));
            }
            0
        }
        "true" => 0,
        "false" => 1,
        _ => {
            io::write_stderr(&format!("msh: {}: not handled in core builtin\n", name));
            127
        }
    }
}
