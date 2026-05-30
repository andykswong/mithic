use super::{write_stderr, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut parents = false;
    let mut dirs: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-p" => parents = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    if c == 'p' { parents = true; }
                }
            }
            _ => dirs.push(arg),
        }
    }

    if dirs.is_empty() {
        write_stderr("mkdir: missing operand\n");
        return 1;
    }

    let mut errors = 0u8;
    for &arg in &dirs {
        if parents {
            if std::fs::create_dir_all(arg).is_err() {
                write_stderr(&format!("mkdir: cannot create directory '{}'\n", arg));
                errors = 1;
            }
        } else {
            if std::fs::create_dir(arg).is_err() {
                write_stderr(&format!("mkdir: cannot create directory '{}'\n", arg));
                errors = 1;
            }
        }
        if !parents && matches!(file_kind(arg), FileKind::NotFound) {
            errors = 1;
        }
    }
    errors
}
