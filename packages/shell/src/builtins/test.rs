use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;

pub(crate) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    _stdin: Option<InputHandle>,
    _stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "test" | "[" => {
            let test_args: &[String] = if name == "[" {
                if args.last().map(|s| s.as_str()) == Some("]") {
                    &args[..args.len() - 1]
                } else {
                    shell.rt.write_stderr("msh: [: missing `]'\n");
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
            shell.rt.write_stderr(&format!("msh: {}: not handled in test builtin\n", name));
            127
        }
    }
}
