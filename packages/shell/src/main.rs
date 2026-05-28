pub mod arith;
pub mod brace;
pub mod builtins;
pub mod executor;
pub mod options;
pub mod params;
pub mod parser;
pub mod regex;
pub mod runtime;
pub mod value;

#[cfg(not(test))]
mod io;
#[cfg(not(test))]
mod shell;
#[cfg(not(test))]
mod jobs;

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
    let mut shell = shell::Shell::new();
    let code = shell.run();
    if code != 0 {
        std::process::exit(code as i32);
    }
}
