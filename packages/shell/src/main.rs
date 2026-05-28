pub mod arith;
pub mod brace;
pub mod builtins;
pub mod executor;
pub mod jobs;
pub mod options;
pub mod params;
pub mod parser;
pub mod regex;
pub mod runtime;
pub mod shell;
pub mod value;

#[cfg(not(test))]
mod io;
#[cfg(not(test))]
pub mod runtime_wasi;
#[cfg(test)]
pub mod runtime_test;

#[cfg(not(test))]
mod bindings {
    wit_bindgen::generate!({
        world: "shell",
        path: "./wit",
        generate_all
    });
}

#[cfg(not(test))]
fn main() {
    use crate::bindings::wasi::cli::{environment, terminal_stdin};
    use crate::runtime_wasi::WasiRuntime;
    use crate::value::ShellValue;

    let env: std::collections::HashMap<String, ShellValue> = environment::get_environment()
        .into_iter()
        .map(|(k, v)| (k, ShellValue::Scalar(v)))
        .collect();

    let cwd = environment::initial_cwd()
        .unwrap_or_else(|| "/".to_string());

    let is_interactive = terminal_stdin::get_terminal_stdin().is_some();

    let rt = WasiRuntime::new();
    let mut shell = shell::Shell::new(rt, env, cwd, is_interactive);
    let code = shell.run();
    if code != 0 {
        std::process::exit(code as i32);
    }
}
