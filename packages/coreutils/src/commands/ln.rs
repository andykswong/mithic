use super::{write_stderr, read_file, write_file, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut symbolic = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-s" | "--symbolic" => symbolic = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    if c == 's' { symbolic = true; }
                }
            }
            _ => file_args.push(arg),
        }
    }

    if file_args.len() < 2 {
        write_stderr("ln: missing destination operand\n");
        return 1;
    }

    let target = file_args[file_args.len() - 2];
    let linkname_arg = file_args[file_args.len() - 1];
    let mut linkname = linkname_arg.to_string();

    // If linkname is a directory, place link inside it
    if matches!(file_kind(linkname_arg), FileKind::Directory) {
        let basename = std::path::Path::new(target)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        linkname = format!("{}/{}", linkname_arg.trim_end_matches('/'), basename);
    }

    if symbolic {
        #[allow(deprecated)]
        match std::fs::soft_link(target, &linkname) {
            Ok(_) => 0,
            Err(_) => {
                write_stderr(&format!("ln: failed to create symlink '{}'\n", linkname));
                1
            }
        }
    } else {
        match read_file(target) {
            Some(data) => {
                if write_file(&linkname, &data) {
                    0
                } else {
                    write_stderr(&format!("ln: failed to create link '{}'\n", linkname));
                    1
                }
            }
            None => {
                write_stderr(&format!("ln: failed to access '{}': No such file or directory\n", target));
                1
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_symbolic_flag() {
        let args = &["-s", "/target", "/link"];
        let mut symbolic = false;
        for &arg in args {
            match arg {
                "-s" | "--symbolic" => symbolic = true,
                _ => {}
            }
        }
        assert!(symbolic);
    }

    #[test]
    fn parse_no_symbolic_flag() {
        let args = &["/target", "/link"];
        let mut symbolic = false;
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-s" | "--symbolic" => symbolic = true,
                a if a.starts_with('-') => {}
                _ => file_args.push(arg),
            }
        }
        assert!(!symbolic);
        assert_eq!(file_args, vec!["/target", "/link"]);
    }
}
