const MAX_LINES: usize = 10000;

pub fn run(args: &[&str]) -> u8 {
    let text = if args.is_empty() { "y" } else { args[0] };
    let line = format!("{}\n", text);

    for _ in 0..MAX_LINES {
        // Stop if write fails (broken pipe)
        if !try_write(&line) {
            break;
        }
    }
    0
}

fn try_write(s: &str) -> bool {
    use crate::bindings::wasi::cli::stdout::get_stdout;
    let out = get_stdout();
    out.blocking_write_and_flush(s.as_bytes()).is_ok()
}
