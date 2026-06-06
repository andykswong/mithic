use super::{write_stdout, write_stderr, file_kind, read_dir, FileKind, resolve_path};

pub fn run(args: &[&str]) -> u8 {
    let mut show_hidden = false;
    let mut long_format = false;
    let mut recursive = false;
    let mut time_sort = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-a" => show_hidden = true,
            "-l" => long_format = true,
            "-R" => recursive = true,
            "-t" => time_sort = true,
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'a' => show_hidden = true,
                        'l' => long_format = true,
                        'R' => recursive = true,
                        't' => time_sort = true,
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

    let multiple_targets = targets.len() > 1 || recursive;
    let mut errors = 0u8;
    for (idx, &target) in targets.iter().enumerate() {
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
                if multiple_targets {
                    if idx > 0 {
                        write_stdout("\n");
                    }
                    write_stdout(&format!("{}:\n", target));
                }
                list_directory(target, show_hidden, long_format, recursive, time_sort, 0);
            }
            FileKind::NotFound => {
                write_stderr(&format!("ls: cannot access '{}': No such file or directory\n", target));
                errors = 1;
            }
        }
    }
    errors
}

fn list_directory(path: &str, show_hidden: bool, long_format: bool, recursive: bool, time_sort: bool, depth: usize) {
    let mut entries = read_dir(path);

    if time_sort {
        sort_by_time(&mut entries, path);
    } else {
        entries.sort();
    }

    let mut subdirs: Vec<String> = Vec::new();

    for entry in &entries {
        if !show_hidden && entry.starts_with('.') {
            continue;
        }
        if long_format {
            let full = format!("{}/{}", path.trim_end_matches('/'), entry);
            print_long(&full, entry);
        } else {
            write_stdout(entry);
            write_stdout("\n");
        }
        if recursive {
            let full = format!("{}/{}", path.trim_end_matches('/'), entry);
            if let FileKind::Directory = file_kind(&full) {
                subdirs.push(full);
            }
        }
    }

    if recursive {
        for subdir in &subdirs {
            let name = subdir.as_str();
            write_stdout(&format!("\n{}:\n", name));
            list_directory(name, show_hidden, long_format, recursive, time_sort, depth + 1);
        }
    }
}

fn sort_by_time(entries: &mut Vec<String>, parent: &str) {
    entries.sort_by(|a, b| {
        let path_a = format!("{}/{}", parent.trim_end_matches('/'), a);
        let path_b = format!("{}/{}", parent.trim_end_matches('/'), b);
        let mtime_a = get_mtime(&path_a);
        let mtime_b = get_mtime(&path_b);
        match (mtime_a, mtime_b) {
            (Some(ta), Some(tb)) => tb.cmp(&ta), // newest first
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.cmp(b),
        }
    });
}

fn get_mtime(path: &str) -> Option<u64> {
    std::fs::metadata(resolve_path(path))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

fn format_mode_bits(mode: u32) -> String {
    let mut s = String::with_capacity(10);
    s.push(if mode & 0o40000 != 0 { 'd' } else { '-' });

    // Owner permissions
    s.push(if mode & 0o400 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o200 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o4000 != 0, mode & 0o100 != 0) {
        (true, true) => 's',
        (true, false) => 'S',
        (false, true) => 'x',
        (false, false) => '-',
    });

    // Group permissions
    s.push(if mode & 0o040 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o020 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o2000 != 0, mode & 0o010 != 0) {
        (true, true) => 's',
        (true, false) => 'S',
        (false, true) => 'x',
        (false, false) => '-',
    });

    // Other permissions
    s.push(if mode & 0o004 != 0 { 'r' } else { '-' });
    s.push(if mode & 0o002 != 0 { 'w' } else { '-' });
    s.push(match (mode & 0o1000 != 0, mode & 0o001 != 0) {
        (true, true) => 't',
        (true, false) => 'T',
        (false, true) => 'x',
        (false, false) => '-',
    });

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

fn format_mtime(metadata: &std::fs::Metadata) -> String {
    match metadata.modified() {
        Ok(mtime) => {
            let secs = mtime.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let days = secs / 86400;
            let time_of_day = secs % 86400;
            let hour = time_of_day / 3600;
            let minute = (time_of_day % 3600) / 60;

            let (year, month, day) = days_to_ymd(days as u32);
            let months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            let mon_str = if month >= 1 && month <= 12 {
                months[(month - 1) as usize]
            } else {
                "???"
            };
            format!("{} {:2} {:02}:{:02} {}", mon_str, day, hour, minute, year)
        }
        Err(_) => String::from("            "),
    }
}

fn days_to_ymd(days: u32) -> (u32, u8, u8) {
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y } as u32;
    (year, m as u8, d as u8)
}

fn print_long(path: &str, name: &str) {
    match std::fs::metadata(resolve_path(path)) {
        Ok(m) => {
            let mode = get_mode(&m);
            let mode_str = format_mode_bits(mode);
            let size = m.len();
            let mtime_str = format_mtime(&m);
            write_stdout(&format!("{} {:>3} {:<8} {:<8} {:>8} {} {}\n", mode_str, 1, "root", "root", size, mtime_str, name));
        }
        Err(_) => {
            write_stdout(&format!("?????????? {:>3} {:<8} {:<8} {:>8} {} {}\n", 1, "root", "root", 0, "            ", name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::format_mode_bits;

    #[test]
    fn test_regular_file_755() {
        assert_eq!(format_mode_bits(0o100755), "-rwxr-xr-x");
    }

    #[test]
    fn test_directory_755() {
        assert_eq!(format_mode_bits(0o40755), "drwxr-xr-x");
    }

    #[test]
    fn test_regular_file_644() {
        assert_eq!(format_mode_bits(0o100644), "-rw-r--r--");
    }

    #[test]
    fn test_setuid() {
        assert_eq!(format_mode_bits(0o104755), "-rwsr-xr-x");
    }

    #[test]
    fn test_setuid_no_exec() {
        assert_eq!(format_mode_bits(0o104644), "-rwSr--r--");
    }

    #[test]
    fn test_setgid() {
        assert_eq!(format_mode_bits(0o102755), "-rwxr-sr-x");
    }

    #[test]
    fn test_setgid_no_exec() {
        assert_eq!(format_mode_bits(0o102745), "-rwxr-Sr-x");
    }

    #[test]
    fn test_sticky() {
        assert_eq!(format_mode_bits(0o41755), "drwxr-xr-t");
    }

    #[test]
    fn test_sticky_no_exec() {
        assert_eq!(format_mode_bits(0o41754), "drwxr-xr-T");
    }

    #[test]
    fn test_all_special_bits() {
        assert_eq!(format_mode_bits(0o107777), "-rwsrwsrwt");
    }

    #[test]
    fn test_no_permissions() {
        assert_eq!(format_mode_bits(0o100000), "----------");
    }
}
