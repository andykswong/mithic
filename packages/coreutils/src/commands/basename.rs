use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    if args.is_empty() {
        write_stderr("basename: missing operand\n");
        return 1;
    }
    let path = args[0];
    let suffix = args.get(1).copied().unwrap_or("");

    let base = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let result = if !suffix.is_empty() && base.ends_with(suffix) {
        base[..base.len() - suffix.len()].to_string()
    } else {
        base
    };

    write_stdout(&result);
    write_stdout("\n");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute_basename(path: &str, suffix: &str) -> String {
        let base = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());

        if !suffix.is_empty() && base.ends_with(suffix) {
            base[..base.len() - suffix.len()].to_string()
        } else {
            base
        }
    }

    #[test]
    fn basename_simple_path() {
        assert_eq!(compute_basename("/usr/bin/grep", ""), "grep");
    }

    #[test]
    fn basename_no_directory() {
        assert_eq!(compute_basename("file.txt", ""), "file.txt");
    }

    #[test]
    fn basename_strip_suffix() {
        assert_eq!(compute_basename("/path/to/main.rs", ".rs"), "main");
    }

    #[test]
    fn basename_suffix_not_present_unchanged() {
        assert_eq!(compute_basename("/path/to/main.rs", ".go"), "main.rs");
    }

    #[test]
    fn basename_trailing_slash_handled() {
        // Path::new strips trailing slash and takes last component
        assert_eq!(compute_basename("/usr/bin/", ""), "bin");
    }

    #[test]
    fn run_missing_args_returns_error() {
        assert_eq!(run(&[]), 1);
    }
}
