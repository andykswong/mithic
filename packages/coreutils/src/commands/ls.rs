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

fn format_mode_bits(mode: u32) -> String {
    let mut s = String::with_capacity(10);
    s.push(if mode & 0o40000 != 0 { 'd' } else { '-' });
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o100 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o010 != 0 { 'x' } else { '-' });
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(if mode & 0o001 != 0 { 'x' } else { '-' });
    s
}

#[cfg(target_family = "wasm")]
fn get_mode(metadata: &std::fs::Metadata) -> u32 {
    let dir_bit = if metadata.is_dir() { 0o40000 } else { 0 };
    let perm_bits = if metadata.permissions().readonly() {
        0o555
    } else {
        0o755
    };
    dir_bit | perm_bits
}

#[cfg(not(target_family = "wasm"))]
fn get_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode()
}

fn print_long(path: &str, name: &str) {
    let (mode_str, size) = match std::fs::metadata(path) {
        Ok(m) => {
            let mode = get_mode(&m);
            (format_mode_bits(mode), m.len())
        }
        Err(_) => (String::from("-rwxr-xr-x"), 0),
    };
    write_stdout(&format!("{} {:>8} {}\n", mode_str, size, name));
}
