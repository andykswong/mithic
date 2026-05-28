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
            if shell.eval_test(test_args) { 0 } else { 1 }
        }
        "[[" => {
            if shell.eval_extended_test(args) { 0 } else { 1 }
        }
        _ => {
            io::write_stderr(&format!("msh: {}: not handled in test builtin\n", name));
            127
        }
    }
}
