pub mod core;
pub mod vars;
pub mod flow;
pub mod test;
pub mod jobs;

use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;

pub(crate) fn write_out<R: Runtime>(shell: &mut Shell<R>, stdout: &Option<OutputHandle>, s: &str) {
    if let Some(out) = stdout {
        shell.rt.pipe_write(out, s.as_bytes());
    } else {
        shell.rt.write_stdout(s);
    }
}

impl<R: Runtime> Shell<R> {
    pub(crate) fn exec_builtin(
        &mut self,
        name: &str,
        args: &[String],
        stdin: Option<InputHandle>,
        stdout: Option<OutputHandle>,
    ) -> u8 {
        match name {
            "exit" | "echo" | "pwd" | "cd" | "env" | "true" | "false" => {
                core::exec_builtin(self, name, args, stdin, stdout)
            }
            "export" | "unset" | "declare" | "local" | "read" | "set" => {
                vars::exec_builtin(self, name, args, stdin, stdout)
            }
            "break" | "continue" | "return" | "source" | "." => {
                flow::exec_builtin(self, name, args, stdin, stdout)
            }
            "test" | "[" | "[[" => {
                test::exec_builtin(self, name, args, stdin, stdout)
            }
            "jobs" | "fg" | "bg" | "wait" | "disown" | "kill" | "trap" => {
                jobs::exec_builtin(self, name, args, stdin, stdout)
            }
            _ => 127,
        }
    }
}
