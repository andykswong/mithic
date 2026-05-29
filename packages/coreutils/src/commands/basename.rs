use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    if args.is_empty() {
        write_stderr("basename: missing operand\n");
        return 1;
    }
    let path = args[0];
    let suffix = args.get(1).copied().unwrap_or("");

    let base = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let result = if !suffix.is_empty() && base.ends_with(suffix) {
        base[..base.len() - suffix.len()].to_string()
    } else {
        base
    };

    write_stdout(&result);
    write_stdout("\n");
    0
}
