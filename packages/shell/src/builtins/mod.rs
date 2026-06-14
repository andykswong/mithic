pub mod core;
pub mod vars;
pub mod flow;
pub mod test;
pub mod jobs;

use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;

pub(crate) type BuiltinFn<R> = fn(&mut Shell<R>, &str, &[String], Option<InputHandle>, Option<OutputHandle>) -> u8;

pub(crate) fn write_out<R: Runtime>(shell: &mut Shell<R>, stdout: &Option<OutputHandle>, s: &str) {
    if let Some(out) = stdout {
        shell.rt.pipe_write(out, s.as_bytes());
    } else {
        shell.rt.write_stdout(s);
    }
}

pub(crate) fn lookup_builtin<R: Runtime>(name: &str) -> Option<BuiltinFn<R>> {
    match name {
        "exit" | "echo" | "printf" | "pwd" | "cd" | "env" | "true" | "false" => Some(core::exec_builtin),
        "export" | "unset" | "declare" | "local" | "read" | "set" | "shopt" |
        "readonly" | "let" | "getopts" | "mapfile" | "readarray" => Some(vars::exec_builtin),
        "break" | "continue" | "return" | "source" | "." | "eval" | "shift" | "type" | "command" |
        "exec" | "hash" | "history" | "fc" | "coproc" | "time" | "builtin" | "alias" | "unalias" |
        "pushd" | "popd" | "dirs" => Some(flow::exec_builtin),
        "test" | "[" | "[[" => Some(test::exec_builtin),
        "jobs" | "fg" | "bg" | "wait" | "disown" | "kill" | "trap" => Some(jobs::exec_builtin),
        _ => None,
    }
}
