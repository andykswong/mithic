use super::{write_stdout, write_stderr, file_kind, read_dir, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut show_hidden = false;
    let mut long_format = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-a" => show_hidden = true,
            "-l" => long_format = true,
            "-al" | "-la" => { show_hidden = true; long_format = true; }
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'a' => show_hidden = true,
                        'l' => long_format = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let targets: Vec<&str> = if file_args.is_empty() {
        vec!["."]
    } else {
        file_args
    };

    let mut errors = 0u8;
    for &target in &targets {
        match file_kind(target) {
            FileKind::Regular | FileKind::Other => {
                let name = std::path::Path::new(target)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| target.to_string());
                if long_format {
                    print_long(target, &name);
                } else {
                    write_stdout(&name);
                    write_stdout("\n");
                }
            }
            FileKind::Directory => {
                let mut entries = read_dir(target);
                entries.sort();
                for entry in &entries {
                    if !show_hidden && entry.starts_with('.') {
                        continue;
                    }
                    if long_format {
                        let full = format!("{}/{}", target.trim_end_matches('/'), entry);
                        print_long(&full, entry);
                    } else {
                        write_stdout(entry);
                        write_stdout("\n");
                    }
                }
            }
            FileKind::NotFound => {
                write_stderr(&format!("ls: cannot access '{}': No such file or directory\n", target));
                errors = 1;
            }
        }
    }
    errors
}

fn print_long(path: &str, name: &str) {
    let (type_char, size) = match std::fs::metadata(path) {
        Ok(m) => {
            let t = if m.is_dir() { 'd' } else { '-' };
            (t, m.len())
        }
        Err(_) => ('-', 0),
    };
    write_stdout(&format!("{}{} {:>8} {}\n", type_char, "rwxr-xr-x", size, name));
}
