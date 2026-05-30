use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    let mut canonicalize = false;
    let mut path_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-f" | "--canonicalize" => canonicalize = true,
            "-e" | "--canonicalize-existing" => canonicalize = true,
            "-m" | "--canonicalize-missing" => canonicalize = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'f' | 'e' | 'm' => canonicalize = true,
                        _ => {}
                    }
                }
            }
            _ => path_args.push(arg),
        }
    }

    if path_args.is_empty() {
        write_stderr("readlink: missing operand\n");
        return 1;
    }

    let mut errors = 0u8;
    for &path in &path_args {
        if !canonicalize {
            match std::fs::read_link(path) {
                Ok(target) => {
                    write_stdout(&target.to_string_lossy());
                    write_stdout("\n");
                }
                Err(_) => {
                    write_stderr(&format!("readlink: {}: Invalid argument\n", path));
                    errors = 1;
                }
            }
        } else {
            let normalized = normalize_path(path);
            write_stdout(&normalized);
            write_stdout("\n");
        }
    }
    errors
}

fn normalize_path(path: &str) -> String {
    let is_absolute = path.starts_with('/');
    let mut components: Vec<&str> = Vec::new();

    for component in path.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            c => components.push(c),
        }
    }

    let mut result = if is_absolute { "/".to_string() } else { String::new() };
    result.push_str(&components.join("/"));
    if result.is_empty() {
        result.push('.');
    }
    result
}
