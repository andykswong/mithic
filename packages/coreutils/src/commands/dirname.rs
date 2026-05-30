use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    if args.is_empty() {
        write_stderr("dirname: missing operand\n");
        return 1;
    }
    let path = args[0];
    let dir = compute_dirname(path);
    write_stdout(&dir);
    write_stdout("\n");
    0
}

fn compute_dirname(path: &str) -> String {
    std::path::Path::new(path)
        .parent()
        .map(|p| {
            let s = p.to_string_lossy();
            if s.is_empty() { ".".to_string() } else { s.into_owned() }
        })
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirname_simple_path() {
        assert_eq!(compute_dirname("/usr/bin/grep"), "/usr/bin");
    }

    #[test]
    fn dirname_root() {
        assert_eq!(compute_dirname("/usr"), "/");
    }

    #[test]
    fn dirname_no_directory_gives_dot() {
        assert_eq!(compute_dirname("file.txt"), ".");
    }

    #[test]
    fn dirname_relative_path() {
        assert_eq!(compute_dirname("src/main.rs"), "src");
    }

    #[test]
    fn run_missing_args_returns_error() {
        assert_eq!(run(&[]), 1);
    }
}
