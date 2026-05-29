use super::{write_stderr, remove_dir, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut parents = false;
    let mut dir_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-p" | "--parents" => parents = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    if c == 'p' { parents = true; }
                }
            }
            _ => dir_args.push(arg),
        }
    }

    if dir_args.is_empty() {
        write_stderr("rmdir: missing operand\n");
        return 1;
    }

    let mut errors = 0u8;
    for &dir in &dir_args {
        if !remove_single(dir) {
            write_stderr(&format!("rmdir: failed to remove '{}': Directory not empty or not found\n", dir));
            errors = 1;
            continue;
        }
        if parents {
            // Walk up and remove parent components
            let mut path = dir.trim_end_matches('/').to_string();
            loop {
                match path.rfind('/') {
                    Some(idx) if idx > 0 => {
                        path = path[..idx].to_string();
                        if !remove_single(&path) {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }
    }
    errors
}

fn remove_single(path: &str) -> bool {
    match file_kind(path) {
        FileKind::Directory => remove_dir(path),
        FileKind::NotFound => {
            write_stderr(&format!("rmdir: failed to remove '{}': No such file or directory\n", path));
            false
        }
        _ => {
            write_stderr(&format!("rmdir: failed to remove '{}': Not a directory\n", path));
            false
        }
    }
}
