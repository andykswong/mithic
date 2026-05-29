use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    if args.is_empty() {
        write_stderr("dirname: missing operand\n");
        return 1;
    }
    let path = args[0];
    let dir = std::path::Path::new(path)
        .parent()
        .map(|p| {
            let s = p.to_string_lossy();
            if s.is_empty() { ".".to_string() } else { s.into_owned() }
        })
        .unwrap_or_else(|| ".".to_string());

    write_stdout(&dir);
    write_stdout("\n");
    0
}
