use super::{write_stderr, write_file, file_kind, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();

    if file_args.is_empty() {
        write_stderr("touch: missing file operand\n");
        return 1;
    }

    let mut errors = 0u8;
    for &path in &file_args {
        match file_kind(path) {
            FileKind::NotFound => {
                if !write_file(path, &[]) {
                    write_stderr(&format!("touch: cannot touch '{}': No such file or directory\n", path));
                    errors = 1;
                }
            }
            // File exists — noop (we don't track timestamps in WASI VFS)
            _ => {}
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_file_args_skips_flags() {
        let args = &["-c", "file1.txt", "file2.txt"];
        let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
        assert_eq!(file_args, vec!["file1.txt", "file2.txt"]);
    }

    #[test]
    fn parse_no_args_is_empty() {
        let args: &[&str] = &[];
        let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
        assert!(file_args.is_empty());
    }
}
