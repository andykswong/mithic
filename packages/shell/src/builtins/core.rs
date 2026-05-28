use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use crate::value::ShellValue;
use super::write_out;

pub(super) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    _stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
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
            write_out(shell, &stdout, &output);
            write_out(shell, &stdout, "\n");
            0
        }
        "pwd" => {
            write_out(shell, &stdout, &shell.cwd.clone());
            write_out(shell, &stdout, "\n");
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
            let pairs: Vec<(String, String)> = shell.env.iter()
                .map(|(k, v)| (k.clone(), v.as_scalar().to_string()))
                .collect();
            for (key, value) in &pairs {
                write_out(shell, &stdout, &format!("{}={}\n", key, value));
            }
            0
        }
        "true" => 0,
        "false" => 1,
        _ => {
            shell.rt.write_stderr(&format!("msh: {}: not handled in core builtin\n", name));
            127
        }
    }
}
