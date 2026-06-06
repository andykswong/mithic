use super::{write_stderr, read_file, write_file, file_kind, read_dir, FileKind, resolve_path};

pub fn run(args: &[&str]) -> u8 {
    let mut recursive = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-r" | "-R" | "--recursive" => recursive = true,
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    if c == 'r' || c == 'R' { recursive = true; }
                }
            }
            _ => file_args.push(arg),
        }
    }

    if file_args.len() < 2 {
        write_stderr("cp: missing destination\n");
        return 1;
    }

    let dst_arg = file_args[file_args.len() - 1];
    let srcs = &file_args[..file_args.len() - 1];
    let dst_is_dir = matches!(file_kind(dst_arg), FileKind::Directory);

    if srcs.len() > 1 && !dst_is_dir {
        write_stderr("cp: target must be a directory when copying multiple files\n");
        return 1;
    }

    let mut errors = 0u8;
    for &src in srcs {
        let dst = if dst_is_dir {
            let basename = std::path::Path::new(src)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{}/{}", dst_arg.trim_end_matches('/'), basename)
        } else {
            dst_arg.to_string()
        };

        match file_kind(src) {
            FileKind::Directory => {
                if recursive {
                    if copy_dir_recursive(src, &dst) != 0 {
                        errors = 1;
                    }
                } else {
                    write_stderr(&format!("cp: -r not specified; omitting directory '{}'\n", src));
                    errors = 1;
                }
            }
            FileKind::NotFound => {
                write_stderr(&format!("cp: cannot stat '{}': No such file or directory\n", src));
                errors = 1;
            }
            _ => {
                match read_file(src) {
                    Some(data) => { write_file(&dst, &data); }
                    None => {
                        write_stderr(&format!("cp: cannot stat '{}': No such file or directory\n", src));
                        errors = 1;
                    }
                }
            }
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_recursive_flag_lowercase() {
        let args = &["-r", "src", "dst"];
        let mut recursive = false;
        for &arg in args {
            match arg {
                "-r" | "-R" | "--recursive" => recursive = true,
                _ => {}
            }
        }
        assert!(recursive);
    }

    #[test]
    fn parse_recursive_flag_uppercase() {
        let args = &["-R", "src", "dst"];
        let mut recursive = false;
        for &arg in args {
            match arg {
                "-r" | "-R" | "--recursive" => recursive = true,
                _ => {}
            }
        }
        assert!(recursive);
    }

    #[test]
    fn parse_no_flags() {
        let args = &["src.txt", "dst.txt"];
        let mut recursive = false;
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-r" | "-R" | "--recursive" => recursive = true,
                a if a.starts_with('-') && a.len() > 1 => {}
                _ => file_args.push(arg),
            }
        }
        assert!(!recursive);
        assert_eq!(file_args, vec!["src.txt", "dst.txt"]);
    }
}

fn copy_dir_recursive(src: &str, dst: &str) -> u8 {
    if std::fs::create_dir_all(resolve_path(dst)).is_err() {
        write_stderr(&format!("cp: cannot create directory '{}'\n", dst));
        return 1;
    }
    let mut errors = 0u8;
    let entries = read_dir(src);
    for entry in entries {
        let src_child = format!("{}/{}", src.trim_end_matches('/'), entry);
        let dst_child = format!("{}/{}", dst.trim_end_matches('/'), entry);
        match file_kind(&src_child) {
            FileKind::Directory => {
                if copy_dir_recursive(&src_child, &dst_child) != 0 {
                    errors = 1;
                }
            }
            _ => {
                match read_file(&src_child) {
                    Some(data) => { write_file(&dst_child, &data); }
                    None => { errors = 1; }
                }
            }
        }
    }
    errors
}
