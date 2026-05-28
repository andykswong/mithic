pub mod core;
pub mod vars;
pub mod flow;
pub mod test;
pub mod jobs;

#[cfg(not(test))]
use crate::bindings::mithic::process::types::OutputStream;
#[cfg(not(test))]
use crate::io;

#[cfg(not(test))]
pub(crate) fn write_out(stdout: &Option<OutputStream>, s: &str) {
    if let Some(out) = stdout {
        let _ = out.blocking_write_and_flush(s.as_bytes());
    } else {
        io::write_stdout(s);
    }
}

#[cfg(not(test))]
use crate::shell::Shell;
#[cfg(not(test))]
use crate::bindings::mithic::process::types::InputStream;

#[cfg(not(test))]
impl Shell {
    pub(crate) fn exec_builtin(
        &mut self,
        name: &str,
        args: &[String],
        stdin: Option<InputStream>,
        stdout: Option<OutputStream>,
    ) -> u8 {
        match name {
            "exit" | "echo" | "pwd" | "cd" | "env" | "true" | "false" => {
                core::exec_builtin(self, name, args, stdin, stdout)
            }
            "export" | "unset" | "declare" | "local" | "read" => {
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
