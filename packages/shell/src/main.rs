pub mod arith;
pub mod parser;
pub mod value;

#[cfg(not(test))]
mod io;
#[cfg(not(test))]
mod shell;

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
