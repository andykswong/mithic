mod bindings {
    wit_bindgen::generate!({
        world: "rust-cli",
        path: "../wit",
        generate_all
    });
}

use bindings::exports::wasi::cli::run::Guest;
use bindings::wasi::clocks::wall_clock::now;
use bindings::wasi::cli::stdin::get_stdin;
use bindings::wasi::cli::stdout::get_stdout;
use bindings::wasi::config::runtime::get;
use bindings::wasi::logging::logging::{log, Level};

struct Component;

impl Guest for Component {
    fn run() -> Result<(), ()> {
        let stdin = get_stdin();
        let stdout = get_stdout();
        log(Level::Info, "log", format!("Hello! The time now is: {}", now().seconds).as_str());
        log(Level::Warn, "log", "This is a warning");
        let cfg = get("test").ok().flatten().unwrap_or("<null>".into());
        log(Level::Info, "config", format!("Config.runtime.test = \"{}\"", cfg.as_str()).as_str());
        let _ = stdout.blocking_write_and_flush(format!("Please enter your name: ").as_bytes());
        if let Ok(data) = stdin.blocking_read(256) {
            if let Ok(input) = std::str::from_utf8(&data) {
                let _ = stdout.write(format!("Hello world, {}!\n", input.trim()).as_bytes());
            }
        }
        log(Level::Info, "log", format!("Goodbye! The time now is: {}", now().seconds).as_str());
        Ok(())
    }
}

bindings::export!(Component with_types_in bindings);
