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

#[cfg(test)]
mod tests {
    #[test]
    fn parse_parents_flag() {
        let args = &["-p", "/tmp/a/b/c"];
        let mut parents = false;
        let mut dir_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-p" | "--parents" => parents = true,
                a if a.starts_with('-') => {}
                _ => dir_args.push(arg),
            }
        }
        assert!(parents);
        assert_eq!(dir_args, vec!["/tmp/a/b/c"]);
    }

    #[test]
    fn parent_walk_up() {
        let dir = "/tmp/a/b/c";
        let mut path = dir.trim_end_matches('/').to_string();
        let mut parents_removed: Vec<String> = Vec::new();
        loop {
            match path.rfind('/') {
                Some(idx) if idx > 0 => {
                    path = path[..idx].to_string();
                    parents_removed.push(path.clone());
                }
                _ => break,
            }
        }
        assert_eq!(parents_removed, vec!["/tmp/a/b", "/tmp/a", "/tmp"]);
    }
}
