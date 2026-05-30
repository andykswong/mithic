pub mod commands;

#[cfg(not(test))]
mod bindings {
    wit_bindgen::generate!({
        world: "coreutils",
        path: "./wit",
        generate_all
    });
}

#[cfg(not(test))]
fn main() {
    use bindings::wasi::cli::environment;

    let args = environment::get_arguments();
    let argv0 = args.first().map(|s| s.as_str()).unwrap_or("");
    let name = argv0.rsplit('/').next().unwrap_or(argv0);
    let cmd_args: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();

    let code = commands::dispatch(name, &cmd_args);
    if code != 0 {
        std::process::exit(code as i32);
    }
}
