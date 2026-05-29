use super::{write_stderr, remove_file, remove_dir, file_kind, read_dir, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut recursive = false;
    let mut force = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-r" | "-R" | "--recursive" => recursive = true,
            "-f" | "--force" => force = true,
            "-rf" | "-fr" => { recursive = true; force = true; }
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'r' | 'R' => recursive = true,
                        'f' => force = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let mut errors = 0u8;
    for &arg in &file_args {
        match file_kind(arg) {
            FileKind::Regular | FileKind::Other => {
                remove_file(arg);
            }
            FileKind::Directory => {
                if recursive {
                    remove_dir_recursive(arg);
                } else {
                    write_stderr(&format!("rm: cannot remove '{}': Is a directory\n", arg));
                    errors = 1;
                }
            }
            FileKind::NotFound => {
                if !force {
                    write_stderr(&format!("rm: cannot remove '{}': No such file or directory\n", arg));
                    errors = 1;
                }
            }
        }
    }
    errors
}

fn remove_dir_recursive(path: &str) {
    let entries = read_dir(path);
    for entry in entries {
        let child = format!("{}/{}", path.trim_end_matches('/'), entry);
        match file_kind(&child) {
            FileKind::Directory => remove_dir_recursive(&child),
            _ => { remove_file(&child); }
        }
    }
    remove_dir(path);
}
