use super::{write_stderr, create_dir, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let dirs: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
    if dirs.is_empty() {
        write_stderr("mkdir: missing operand\n");
        return 1;
    }
    let mut errors = 0u8;
    for &arg in &dirs {
        create_dir(arg);
        if matches!(file_kind(arg), FileKind::NotFound) {
            write_stderr(&format!("mkdir: cannot create directory '{}'\n", arg));
            errors = 1;
        }
    }
    errors
}
