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
    use std::io::Write;
    let mut out = std::io::stdout();
    out.write_all(s.as_bytes()).is_ok() && out.flush().is_ok()
}
