use super::{write_stdout, file_kind, read_dir, dispatch, FileKind, resolve_path};
use regex::Regex;

#[derive(Debug, Clone, Copy, PartialEq)]
enum MtimeOp {
    MoreThan,
    LessThan,
    Exactly,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MtimeFilter {
    days: u64,
    op: MtimeOp,
}

impl MtimeFilter {
    fn parse(s: &str) -> Option<MtimeFilter> {
        if s.starts_with('+') {
            s[1..].parse::<u64>().ok().map(|days| MtimeFilter { days, op: MtimeOp::MoreThan })
        } else if s.starts_with('-') {
            s[1..].parse::<u64>().ok().map(|days| MtimeFilter { days, op: MtimeOp::LessThan })
        } else {
            s.parse::<u64>().ok().map(|days| MtimeFilter { days, op: MtimeOp::Exactly })
        }
    }

    fn matches(&self, age_days: u64) -> bool {
        match self.op {
            MtimeOp::MoreThan => age_days > self.days,
            MtimeOp::LessThan => age_days < self.days,
            MtimeOp::Exactly => age_days == self.days,
        }
    }
}

pub fn run(args: &[&str]) -> u8 {
    let mut start_path = ".";
    let mut name_pattern: Option<&str> = None;
    let mut path_pattern: Option<&str> = None;
    let mut type_filter: Option<char> = None;
    let mut exec_cmd: Option<Vec<&str>> = None;
    let mut max_depth: Option<usize> = None;
    let mut mtime: Option<MtimeFilter> = None;

    let mut i = 0;
    if i < args.len() && !args[i].starts_with('-') {
        start_path = args[i];
        i += 1;
    }

    while i < args.len() {
        match args[i] {
            "-name" => {
                i += 1;
                if i < args.len() {
                    name_pattern = Some(args[i]);
                }
            }
            "-path" => {
                i += 1;
                if i < args.len() {
                    path_pattern = Some(args[i]);
                }
            }
            "-type" => {
                i += 1;
                if i < args.len() {
                    type_filter = args[i].chars().next();
                }
            }
            "-maxdepth" => {
                i += 1;
                if i < args.len() {
                    max_depth = args[i].parse::<usize>().ok();
                }
            }
            "-mtime" => {
                i += 1;
                if i < args.len() {
                    mtime = MtimeFilter::parse(args[i]);
                }
            }
            "-exec" => {
                i += 1;
                let mut cmd_parts: Vec<&str> = Vec::new();
                while i < args.len() && args[i] != "\\;" && args[i] != ";" {
                    cmd_parts.push(args[i]);
                    i += 1;
                }
                exec_cmd = Some(cmd_parts);
            }
            _ => {}
        }
        i += 1;
    }

    find_recursive(start_path, start_path, name_pattern, path_pattern, type_filter, exec_cmd.as_deref(), max_depth, mtime, 0);
    0
}

fn glob_to_regex(pattern: &str) -> String {
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => regex.push_str(".*"),
            '?' => regex.push('.'),
            '[' => {
                regex.push('[');
                i += 1;
                while i < chars.len() && chars[i] != ']' {
                    regex.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    regex.push(']');
                }
            }
            c @ ('.' | '+' | '(' | ')' | '{' | '}' | '^' | '$' | '|' | '\\') => {
                regex.push('\\');
                regex.push(c);
            }
            c => regex.push(c),
        }
        i += 1;
    }
    regex.push('$');
    regex
}

fn matches_glob(name: &str, pattern: &str) -> bool {
    let regex_str = glob_to_regex(pattern);
    match Regex::new(&regex_str) {
        Ok(re) => re.is_match(name),
        Err(_) => name == pattern,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_star_matches_everything() {
        assert!(matches_glob("anything", "*"));
        assert!(matches_glob("", "*"));
    }

    #[test]
    fn glob_exact_match_without_wildcard() {
        assert!(matches_glob("foo.rs", "foo.rs"));
        assert!(!matches_glob("bar.rs", "foo.rs"));
    }

    #[test]
    fn glob_star_suffix() {
        assert!(matches_glob("main.rs", "*.rs"));
        assert!(!matches_glob("main.go", "*.rs"));
    }

    #[test]
    fn glob_star_prefix() {
        assert!(matches_glob("libfoo.a", "lib*"));
        assert!(!matches_glob("foo.a", "lib*"));
    }

    #[test]
    fn glob_star_middle() {
        assert!(matches_glob("foo_bar_baz", "foo*baz"));
        assert!(!matches_glob("foo_bar_qux", "foo*baz"));
    }

    #[test]
    fn glob_multiple_stars() {
        assert!(matches_glob("a_b_c", "*_*_*"));
        assert!(!matches_glob("abc", "*_*_*"));
    }

    #[test]
    fn glob_double_star_extension() {
        assert!(matches_glob("test.rs", "test.*"));
        assert!(!matches_glob("other.rs", "test.*"));
    }

    #[test]
    fn glob_question_mark() {
        assert!(matches_glob("a.rs", "?.rs"));
        assert!(!matches_glob("ab.rs", "?.rs"));
        assert!(matches_glob("foo", "f?o"));
        assert!(!matches_glob("fo", "f?o"));
    }

    #[test]
    fn glob_char_class() {
        assert!(matches_glob("cat", "[abc]at"));
        assert!(matches_glob("bat", "[abc]at"));
        assert!(!matches_glob("dat", "[abc]at"));
    }

    #[test]
    fn glob_combined() {
        assert!(matches_glob("file1.txt", "file[0-9].*"));
        assert!(!matches_glob("fileA.txt", "file[0-9].*"));
        assert!(matches_glob("a_b.rs", "?_?.*"));
    }

    #[test]
    fn glob_escapes_regex_metachar() {
        assert!(matches_glob("foo.bar", "foo.bar"));
        assert!(!matches_glob("fooxbar", "foo.bar"));
    }

    #[test]
    fn mtime_parse_more_than() {
        let f = MtimeFilter::parse("+5").unwrap();
        assert_eq!(f.days, 5);
        assert_eq!(f.op, MtimeOp::MoreThan);
    }

    #[test]
    fn mtime_parse_less_than() {
        let f = MtimeFilter::parse("-3").unwrap();
        assert_eq!(f.days, 3);
        assert_eq!(f.op, MtimeOp::LessThan);
    }

    #[test]
    fn mtime_parse_exactly() {
        let f = MtimeFilter::parse("7").unwrap();
        assert_eq!(f.days, 7);
        assert_eq!(f.op, MtimeOp::Exactly);
    }

    #[test]
    fn mtime_parse_invalid() {
        assert_eq!(MtimeFilter::parse("abc"), None);
        assert_eq!(MtimeFilter::parse("+abc"), None);
        assert_eq!(MtimeFilter::parse("-xyz"), None);
    }

    #[test]
    fn mtime_matches_more_than() {
        let f = MtimeFilter { days: 5, op: MtimeOp::MoreThan };
        assert!(!f.matches(4));
        assert!(!f.matches(5));
        assert!(f.matches(6));
        assert!(f.matches(100));
    }

    #[test]
    fn mtime_matches_less_than() {
        let f = MtimeFilter { days: 5, op: MtimeOp::LessThan };
        assert!(f.matches(0));
        assert!(f.matches(4));
        assert!(!f.matches(5));
        assert!(!f.matches(6));
    }

    #[test]
    fn mtime_matches_exactly() {
        let f = MtimeFilter { days: 5, op: MtimeOp::Exactly };
        assert!(!f.matches(4));
        assert!(f.matches(5));
        assert!(!f.matches(6));
    }

    #[test]
    fn mtime_parse_zero() {
        let f = MtimeFilter::parse("0").unwrap();
        assert_eq!(f.days, 0);
        assert_eq!(f.op, MtimeOp::Exactly);
        assert!(f.matches(0));
        assert!(!f.matches(1));
    }
}

fn find_recursive(base: &str, path: &str, name_pattern: Option<&str>, path_pattern: Option<&str>, type_filter: Option<char>, exec_cmd: Option<&[&str]>, max_depth: Option<usize>, mtime: Option<MtimeFilter>, current_depth: usize) {
    if let Some(max) = max_depth {
        if current_depth > max {
            return;
        }
    }

    let kind = file_kind(path);
    let display = path.to_string();

    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let type_ok = match type_filter {
        Some('f') => matches!(kind, FileKind::Regular),
        Some('d') => matches!(kind, FileKind::Directory),
        _ => true,
    };

    let effective_name = if path == base && path == "." { "." } else { &name };
    let name_ok = match name_pattern {
        Some(pat) => matches_glob(effective_name, pat),
        None => true,
    };

    let path_ok = match path_pattern {
        Some(pat) => matches_glob(&display, pat),
        None => true,
    };

    let mtime_ok = match mtime {
        Some(filter) => {
            match std::fs::metadata(resolve_path(path)).and_then(|m| m.modified()) {
                Ok(modified) => {
                    let age_secs = std::time::SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default()
                        .as_secs();
                    let age_days = age_secs / 86400;
                    filter.matches(age_days)
                }
                Err(_) => true,
            }
        }
        None => true,
    };

    if type_ok && name_ok && path_ok && mtime_ok {
        if let Some(cmd_parts) = exec_cmd {
            if !cmd_parts.is_empty() {
                let cmd = cmd_parts[0];
                let substituted: Vec<String> = cmd_parts[1..].iter()
                    .map(|&a| if a == "{}" { display.clone() } else { a.to_string() })
                    .collect();
                let refs: Vec<&str> = substituted.iter().map(|s| s.as_str()).collect();
                if cmd == "echo" {
                    write_stdout(&refs.join(" "));
                    write_stdout("\n");
                } else {
                    dispatch(cmd, &refs);
                }
            }
        } else {
            write_stdout(&display);
            write_stdout("\n");
        }
    }

    if matches!(kind, FileKind::Directory) {
        let mut entries = read_dir(path);
        entries.sort();
        for entry in entries {
            let child = format!("{}/{}", path.trim_end_matches('/'), entry);
            find_recursive(base, &child, name_pattern, path_pattern, type_filter, exec_cmd, max_depth, mtime, current_depth + 1);
        }
    }
}
