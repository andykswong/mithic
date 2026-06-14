pub mod regex;
mod cat;
mod head;
mod tail;
mod wc;
mod grep;
mod seq;
mod sort;
mod uniq;
mod tr;
mod cut;
mod tee;
mod xargs;
mod sleep;
mod basename;
mod dirname;
mod mkdir;
mod rm;
mod cp;
mod mv;
mod ls;
mod rmdir;
mod touch;
mod ln;
mod sed;
mod find;
mod date;
mod diff;
mod chmod;
mod readlink;
mod yes;
mod rev;
mod paste;
mod base64;
mod base32;
mod awk;
mod mktemp;

pub fn dispatch(name: &str, args: &[&str]) -> u8 {
    match name {
        "cat" => cat::run(args),
        "head" => head::run(args),
        "tail" => tail::run(args),
        "wc" => wc::run(args),
        "grep" => grep::run(args),
        "seq" => seq::run(args),
        "sort" => sort::run(args),
        "uniq" => uniq::run(args),
        "tr" => tr::run(args),
        "cut" => cut::run(args),
        "tee" => tee::run(args),
        "xargs" => xargs::run(args),
        "sleep" => sleep::run(args),
        "basename" => basename::run(args),
        "dirname" => dirname::run(args),
        "mkdir" => mkdir::run(args),
        "rm" => rm::run(args),
        "cp" => cp::run(args),
        "mv" => mv::run(args),
        "ls" => ls::run(args),
        "rmdir" => rmdir::run(args),
        "touch" => touch::run(args),
        "ln" => ln::run(args),
        "sed" => sed::run(args),
        "find" => find::run(args),
        "date" => date::run(args),
        "diff" => diff::run(args),
        "chmod" => chmod::run(args),
        "readlink" => readlink::run(args),
        "yes" => yes::run(args),
        "rev" => rev::run(args),
        "paste" => paste::run(args),
        "base64" => base64::run(args),
        "base32" => base32::run(args),
        "awk" => awk::run(args),
        "mktemp" => mktemp::run(args),
        _ => {
            write_stderr(&format!("{}: command not found\n", name));
            127
        }
    }
}

pub fn write_stdout(s: &str) {
    use std::io::Write;
    let mut out = std::io::stdout();
    if out.write_all(s.as_bytes()).is_err() { std::process::exit(141); }
    if out.flush().is_err() { std::process::exit(141); }
}

pub fn write_stdout_bytes(data: &[u8]) {
    use std::io::Write;
    let mut out = std::io::stdout();
    if out.write_all(data).is_err() { std::process::exit(141); }
    if out.flush().is_err() { std::process::exit(141); }
}

pub fn write_stderr(s: &str) {
    use std::io::Write;
    let mut err = std::io::stderr();
    err.write_all(s.as_bytes()).ok();
    err.flush().ok();
}

pub fn read_stdin_all() -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::io::stdin().read_to_end(&mut buf).ok();
    buf
}

pub fn read_file(path: &str) -> Option<Vec<u8>> {
    std::fs::read(resolve_path(path)).ok()
}

pub fn write_file(path: &str, data: &[u8]) -> bool {
    std::fs::write(resolve_path(path), data).is_ok()
}

pub fn append_file(path: &str, data: &[u8]) -> bool {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(resolve_path(path))
        .and_then(|mut f| f.write_all(data))
        .is_ok()
}

pub fn remove_file(path: &str) -> bool {
    std::fs::remove_file(resolve_path(path)).is_ok()
}

pub fn remove_dir(path: &str) -> bool {
    std::fs::remove_dir(resolve_path(path)).is_ok()
}

pub fn create_dir(path: &str) -> bool {
    std::fs::create_dir(resolve_path(path)).is_ok()
}

pub enum FileKind {
    Regular,
    Directory,
    Other,
    NotFound,
}

pub fn resolve_path(path: &str) -> String {
    if path.starts_with('/') {
        return path.to_string();
    }
    let cwd = std::env::var("PWD").unwrap_or_else(|_| "/".to_string());
    if path == "." {
        return cwd;
    }
    if path == ".." {
        return cwd.rsplit_once('/').map(|(p, _)| if p.is_empty() { "/" } else { p }).unwrap_or("/").to_string();
    }
    format!("{}/{}", cwd.trim_end_matches('/'), path)
}

pub fn file_kind(path: &str) -> FileKind {
    let resolved = resolve_path(path);
    match std::fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => FileKind::Directory,
        Ok(m) if m.is_file() => FileKind::Regular,
        Ok(_) => FileKind::Other,
        Err(_) => FileKind::NotFound,
    }
}

pub fn read_dir(path: &str) -> Vec<String> {
    let resolved = resolve_path(path);
    std::fs::read_dir(&resolved)
        .map(|iter| {
            iter.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Read input: from file args if provided, otherwise from stdin.
/// Returns (data, error_count).
pub fn read_input(args: &[&str]) -> (Vec<u8>, u8) {
    if args.is_empty() {
        (read_stdin_all(), 0)
    } else {
        let mut out = Vec::new();
        let mut errors = 0u8;
        for &arg in args {
            match read_file(arg) {
                Some(data) => out.extend_from_slice(&data),
                None => {
                    write_stderr(&format!("{}: No such file or directory\n", arg));
                    errors = 1;
                }
            }
        }
        (out, errors)
    }
}

pub fn lines_of(data: &[u8]) -> Vec<&str> {
    let s = std::str::from_utf8(data).unwrap_or("");
    let mut lines: Vec<&str> = s.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- lines_of ---

    #[test]
    fn lines_of_trailing_newline_stripped() {
        let data = b"a\nb\nc\n";
        assert_eq!(lines_of(data), vec!["a", "b", "c"]);
    }

    #[test]
    fn lines_of_no_trailing_newline() {
        let data = b"a\nb\nc";
        assert_eq!(lines_of(data), vec!["a", "b", "c"]);
    }

    #[test]
    fn lines_of_empty_input() {
        assert_eq!(lines_of(b""), Vec::<&str>::new());
    }

    #[test]
    fn lines_of_single_line() {
        assert_eq!(lines_of(b"hello\n"), vec!["hello"]);
    }

    // --- expand_char_set ---

    #[test]
    fn expand_literal_chars() {
        assert_eq!(expand_char_set("abc"), vec!['a', 'b', 'c']);
    }

    #[test]
    fn expand_range() {
        let r = expand_char_set("a-e");
        assert_eq!(r, vec!['a', 'b', 'c', 'd', 'e']);
    }

    #[test]
    fn expand_digit_range() {
        let r = expand_char_set("0-9");
        assert_eq!(r.len(), 10);
        assert!(r.contains(&'0'));
        assert!(r.contains(&'9'));
    }

    #[test]
    fn expand_posix_class_upper() {
        let r = expand_char_set("[:upper:]");
        assert_eq!(r.len(), 26);
        assert!(r.contains(&'A'));
        assert!(r.contains(&'Z'));
    }

    #[test]
    fn expand_posix_class_lower() {
        let r = expand_char_set("[:lower:]");
        assert_eq!(r.len(), 26);
        assert!(r.contains(&'a'));
        assert!(r.contains(&'z'));
    }

    #[test]
    fn expand_posix_class_digit() {
        let r = expand_char_set("[:digit:]");
        assert_eq!(r.len(), 10);
        assert!(r.contains(&'5'));
    }

    #[test]
    fn expand_posix_class_alpha() {
        let r = expand_char_set("[:alpha:]");
        assert_eq!(r.len(), 52);
    }

    #[test]
    fn expand_posix_class_space() {
        let r = expand_char_set("[:space:]");
        assert!(r.contains(&' '));
        assert!(r.contains(&'\t'));
        assert!(r.contains(&'\n'));
    }
}

pub fn expand_char_set(set: &str) -> Vec<char> {
    let mut result = Vec::new();
    let mut s = set;
    while !s.is_empty() {
        if s.starts_with("[:") {
            if let Some(end) = s.find(":]") {
                let class = &s[2..end];
                match class {
                    "upper" => result.extend('A'..='Z'),
                    "lower" => result.extend('a'..='z'),
                    "digit" => result.extend('0'..='9'),
                    "alpha" => { result.extend('A'..='Z'); result.extend('a'..='z'); }
                    "alnum" => { result.extend('A'..='Z'); result.extend('a'..='z'); result.extend('0'..='9'); }
                    "space" => result.extend([' ', '\t', '\n', '\r', '\x0c', '\x0b']),
                    "blank" => result.extend([' ', '\t']),
                    "punct" => {
                        result.extend((33u8..=47u8).map(|b| b as char));
                        result.extend((58u8..=64u8).map(|b| b as char));
                        result.extend((91u8..=96u8).map(|b| b as char));
                        result.extend((123u8..=126u8).map(|b| b as char));
                    }
                    _ => {}
                }
                s = &s[end + 2..];
                continue;
            }
        }
        let chars: Vec<char> = s.chars().collect();
        if chars.len() >= 3 && chars[1] == '-' {
            let start = chars[0] as u32;
            let end = chars[2] as u32;
            if start <= end {
                for c in start..=end {
                    if let Some(ch) = char::from_u32(c) {
                        result.push(ch);
                    }
                }
                let skip: usize = chars[0].len_utf8() + 1 + chars[2].len_utf8();
                s = &s[skip..];
                continue;
            }
        }
        let c = chars[0];
        result.push(c);
        s = &s[c.len_utf8()..];
    }
    result
}
