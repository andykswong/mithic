use super::{write_stdout, write_stderr, read_stdin_all, read_file, write_file};
use super::regex::{regex_find_at, RegexOpts};

pub fn run(args: &[&str]) -> u8 {
    let mut expressions: Vec<String> = Vec::new();
    let mut in_place = false;
    let mut suppress = false;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-i" | "--in-place" => in_place = true,
            "-n" | "--quiet" | "--silent" => suppress = true,
            "-e" | "--expression" => {
                i += 1;
                if i < args.len() {
                    expressions.push(args[i].to_string());
                }
            }
            a if a.starts_with('-') && a.len() > 1 => {
                let rest = &a[1..];
                for c in rest.chars() {
                    match c {
                        'i' => in_place = true,
                        'n' => suppress = true,
                        'e' => {}
                        _ => {}
                    }
                }
            }
            _ => {
                if expressions.is_empty() && file_args.is_empty() {
                    expressions.push(args[i].to_string());
                } else {
                    file_args.push(args[i]);
                }
            }
        }
        i += 1;
    }

    if expressions.is_empty() {
        write_stderr("sed: no script command\n");
        return 1;
    }

    let parsed: Vec<SedExpr> = expressions.iter().filter_map(|e| parse_expr(e)).collect();
    if parsed.len() != expressions.len() {
        write_stderr("sed: invalid expression\n");
        return 1;
    }

    if file_args.is_empty() {
        let data = read_stdin_all();
        let text = String::from_utf8_lossy(&data);
        let result = apply_expressions(&text, &parsed, suppress);
        write_stdout(&result);
    } else {
        let mut errors = 0u8;
        for &path in &file_args {
            match read_file(path) {
                Some(data) => {
                    let text = String::from_utf8_lossy(&data);
                    let result = apply_expressions(&text, &parsed, suppress);
                    if in_place {
                        if !write_file(path, result.as_bytes()) {
                            write_stderr(&format!("sed: cannot write '{}'\n", path));
                            errors = 1;
                        }
                    } else {
                        write_stdout(&result);
                    }
                }
                None => {
                    write_stderr(&format!("sed: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        }
        return errors;
    }
    0
}

enum Address {
    Line(usize),
    Range(usize, usize),
    Pattern(String),
}

enum SedCmd {
    Substitute { pattern: String, replacement: String, global: bool },
    Delete,
    Print,
}

struct SedExpr {
    address: Option<Address>,
    cmd: SedCmd,
}

fn parse_expr(expr: &str) -> Option<SedExpr> {
    let expr = expr.trim();
    if expr.is_empty() { return None; }

    // Parse optional address
    let (address, rest) = parse_address(expr)?;

    // Parse command
    if rest.starts_with('s') {
        let sub = &rest[1..];
        if sub.is_empty() { return None; }
        let delim = sub.chars().next()?;
        let parts: Vec<&str> = sub[1..].splitn(3, delim).collect();
        if parts.len() < 2 { return None; }
        let pattern = parts[0].to_string();
        let (replacement, flags) = if parts.len() == 3 {
            (parts[1].to_string(), parts[2].to_string())
        } else {
            (parts[1].to_string(), String::new())
        };
        let global = flags.contains('g');
        Some(SedExpr { address, cmd: SedCmd::Substitute { pattern, replacement, global } })
    } else if rest.starts_with('d') {
        Some(SedExpr { address, cmd: SedCmd::Delete })
    } else if rest.starts_with('p') {
        Some(SedExpr { address, cmd: SedCmd::Print })
    } else {
        None
    }
}

fn parse_address(expr: &str) -> Option<(Option<Address>, &str)> {
    let chars: Vec<char> = expr.chars().collect();
    if chars.is_empty() { return None; }

    if chars[0].is_ascii_digit() {
        let end = chars.iter().position(|c| !c.is_ascii_digit()).unwrap_or(chars.len());
        let n: usize = expr[..end].parse().ok()?;
        let rest = &expr[end..];
        if rest.starts_with(',') {
            let rest2 = &rest[1..];
            let chars2: Vec<char> = rest2.chars().collect();
            let end2 = chars2.iter().position(|c| !c.is_ascii_digit()).unwrap_or(chars2.len());
            if end2 > 0 {
                let m: usize = rest2[..end2].parse().ok()?;
                return Some((Some(Address::Range(n, m)), &rest2[end2..]));
            }
        }
        return Some((Some(Address::Line(n)), rest));
    }

    if chars[0] == '/' {
        let delim = '/';
        let mut end = None;
        let mut k = 1;
        while k < chars.len() {
            if chars[k] == '\\' { k += 2; continue; }
            if chars[k] == delim { end = Some(k); break; }
            k += 1;
        }
        let end = end?;
        let pat: String = chars[1..end].iter().collect();
        let rest = &expr[end + 1..];
        return Some((Some(Address::Pattern(pat)), rest));
    }

    Some((None, expr))
}

fn sed_opts() -> RegexOpts {
    RegexOpts { dot_matches_newline: false }
}

fn address_matches(addr: &Address, lineno: usize, line: &str) -> bool {
    match addr {
        Address::Line(n) => lineno == *n,
        Address::Range(a, b) => lineno >= *a && lineno <= *b,
        Address::Pattern(pat) => {
            let chars: Vec<char> = line.chars().collect();
            regex_find_at(&chars, 0, pat, &sed_opts()).is_some()
        }
    }
}

fn apply_expressions(text: &str, exprs: &[SedExpr], suppress: bool) -> String {
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let has_trailing_newline = text.ends_with('\n');
    let line_count = if has_trailing_newline && !raw_lines.is_empty() {
        raw_lines.len() - 1
    } else {
        raw_lines.len()
    };

    let mut result = String::new();
    for (idx, &line) in raw_lines.iter().enumerate() {
        let lineno = idx + 1;
        if has_trailing_newline && idx == raw_lines.len() - 1 && line.is_empty() {
            break;
        }

        let mut s = line.to_string();
        let mut deleted = false;
        let mut explicitly_printed = false;

        for expr in exprs {
            let active = match &expr.address {
                None => true,
                Some(addr) => address_matches(addr, lineno, &s),
            };
            if !active { continue; }

            match &expr.cmd {
                SedCmd::Delete => { deleted = true; break; }
                SedCmd::Print => {
                    result.push_str(&s);
                    result.push('\n');
                    explicitly_printed = true;
                }
                SedCmd::Substitute { pattern, replacement, global } => {
                    s = apply_substitute(&s, pattern, replacement, *global);
                }
            }
        }

        if !deleted && (!suppress || explicitly_printed) && !explicitly_printed {
            result.push_str(&s);
            if lineno < line_count || has_trailing_newline {
                result.push('\n');
            }
        } else if !deleted && suppress && !explicitly_printed {
            // suppressed, don't print
        }
    }
    result
}

fn apply_substitute(line: &str, pattern: &str, replacement: &str, global: bool) -> String {
    if pattern.is_empty() {
        return line.to_string();
    }
    let opts = sed_opts();
    if global {
        let mut result = String::new();
        let mut pos = 0;
        let chars: Vec<char> = line.chars().collect();
        while pos <= chars.len() {
            match regex_find_at(&chars, pos, pattern, &opts) {
                Some((start, end)) => {
                    result.push_str(&chars[pos..start].iter().collect::<String>());
                    let matched: String = chars[start..end].iter().collect();
                    result.push_str(&build_replacement(replacement, &matched));
                    if end == start {
                        if pos < chars.len() {
                            result.push(chars[pos]);
                        }
                        pos += 1;
                    } else {
                        pos = end;
                    }
                }
                None => {
                    result.push_str(&chars[pos..].iter().collect::<String>());
                    break;
                }
            }
        }
        result
    } else {
        let chars: Vec<char> = line.chars().collect();
        match regex_find_at(&chars, 0, pattern, &opts) {
            Some((start, end)) => {
                let matched: String = chars[start..end].iter().collect();
                let mut result: String = chars[..start].iter().collect();
                result.push_str(&build_replacement(replacement, &matched));
                result.push_str(&chars[end..].iter().collect::<String>());
                result
            }
            None => line.to_string(),
        }
    }
}

fn build_replacement(replacement: &str, matched: &str) -> String {
    let mut result = String::new();
    let chars: Vec<char> = replacement.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            result.push_str(matched);
        } else if chars[i] == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                'n' => { result.push('\n'); i += 2; continue; }
                't' => { result.push('\t'); i += 2; continue; }
                c => { result.push(c); i += 2; continue; }
            }
        } else {
            result.push(chars[i]);
        }
        i += 1;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- apply_substitute ---

    #[test]
    fn substitute_simple() {
        assert_eq!(apply_substitute("hello world", "world", "Rust", false), "hello Rust");
    }

    #[test]
    fn substitute_no_match() {
        assert_eq!(apply_substitute("hello", "xyz", "ABC", false), "hello");
    }

    #[test]
    fn substitute_global_replaces_all() {
        assert_eq!(apply_substitute("aaa", "a", "b", true), "bbb");
    }

    #[test]
    fn substitute_global_non_overlapping() {
        assert_eq!(apply_substitute("abab", "ab", "X", true), "XX");
    }

    #[test]
    fn substitute_ampersand_inserts_match() {
        assert_eq!(apply_substitute("hello", "ell", "[&]", false), "h[ell]o");
    }

    #[test]
    fn substitute_backslash_n_in_replacement() {
        assert_eq!(apply_substitute("ab", "b", r"\n", false), "a\n");
    }

    #[test]
    fn substitute_dot_star_non_global() {
        let result = apply_substitute("foo", ".*", "X", false);
        assert_eq!(result, "X");
    }

    #[test]
    fn substitute_char_class() {
        assert_eq!(apply_substitute("a1b", "[0-9]", "N", false), "aNb");
    }

    // --- build_replacement ---

    #[test]
    fn build_replacement_literal() {
        assert_eq!(build_replacement("hello", "ignored"), "hello");
    }

    #[test]
    fn build_replacement_ampersand() {
        assert_eq!(build_replacement("&", "match"), "match");
    }

    #[test]
    fn build_replacement_escaped_ampersand() {
        assert_eq!(build_replacement(r"\&", "match"), "&");
    }

    #[test]
    fn build_replacement_newline_escape() {
        assert_eq!(build_replacement(r"\n", "x"), "\n");
    }

    #[test]
    fn build_replacement_tab_escape() {
        assert_eq!(build_replacement(r"\t", "x"), "\t");
    }

    // --- parse_expr / parse_address ---

    #[test]
    fn parse_expr_simple_substitute() {
        let expr = parse_expr("s/hello/world/").unwrap();
        match expr.cmd {
            SedCmd::Substitute { pattern, replacement, global } => {
                assert_eq!(pattern, "hello");
                assert_eq!(replacement, "world");
                assert!(!global);
            }
            _ => panic!("expected Substitute"),
        }
        assert!(expr.address.is_none());
    }

    #[test]
    fn parse_expr_global_flag() {
        let expr = parse_expr("s/a/b/g").unwrap();
        match expr.cmd {
            SedCmd::Substitute { global, .. } => assert!(global),
            _ => panic!("expected Substitute"),
        }
    }

    #[test]
    fn parse_expr_line_address() {
        let expr = parse_expr("2s/a/b/").unwrap();
        match expr.address {
            Some(Address::Line(n)) => assert_eq!(n, 2),
            _ => panic!("expected Line address"),
        }
    }

    #[test]
    fn parse_expr_range_address() {
        let expr = parse_expr("1,3s/a/b/").unwrap();
        match expr.address {
            Some(Address::Range(a, b)) => { assert_eq!(a, 1); assert_eq!(b, 3); }
            _ => panic!("expected Range address"),
        }
    }

    #[test]
    fn parse_expr_pattern_address() {
        let expr = parse_expr("/foo/s/foo/bar/").unwrap();
        match expr.address {
            Some(Address::Pattern(p)) => assert_eq!(p, "foo"),
            _ => panic!("expected Pattern address"),
        }
    }

    #[test]
    fn parse_expr_delete_cmd() {
        let expr = parse_expr("d").unwrap();
        assert!(matches!(expr.cmd, SedCmd::Delete));
    }

    #[test]
    fn parse_expr_invalid_returns_none() {
        assert!(parse_expr("").is_none());
        assert!(parse_expr("z/a/b/").is_none());
    }

    // --- apply_expressions / address_matches ---

    #[test]
    fn apply_substitute_on_all_lines() {
        // Non-global: only first occurrence per line is replaced
        let exprs = vec![parse_expr("s/x/y/").unwrap()];
        assert_eq!(apply_expressions("xax\nxbx\n", &exprs, false), "yax\nybx\n");
    }

    #[test]
    fn apply_substitute_global_on_all_lines() {
        let exprs = vec![parse_expr("s/x/y/g").unwrap()];
        assert_eq!(apply_expressions("xax\nxbx\n", &exprs, false), "yay\nyby\n");
    }

    #[test]
    fn apply_line_address_only_affects_matching_line() {
        let exprs = vec![parse_expr("2s/a/X/").unwrap()];
        assert_eq!(apply_expressions("a\na\na\n", &exprs, false), "a\nX\na\n");
    }

    #[test]
    fn apply_delete_removes_line() {
        let exprs = vec![parse_expr("2d").unwrap()];
        assert_eq!(apply_expressions("one\ntwo\nthree\n", &exprs, false), "one\nthree\n");
    }

    #[test]
    fn apply_pattern_address_delete() {
        let exprs = vec![parse_expr("/two/d").unwrap()];
        assert_eq!(apply_expressions("one\ntwo\nthree\n", &exprs, false), "one\nthree\n");
    }

    // --- regex_find (via shared engine with sed opts) ---

    #[test]
    fn regex_find_simple() {
        let opts = super::sed_opts();
        let chars: Vec<char> = "hello".chars().collect();
        assert!(super::regex_find_at(&chars, 0, "ell", &opts).is_some());
        let chars2: Vec<char> = "hello".chars().collect();
        assert!(super::regex_find_at(&chars2, 0, "xyz", &opts).is_none());
    }

    #[test]
    fn regex_find_anchor_start() {
        let opts = super::sed_opts();
        let chars: Vec<char> = "hello".chars().collect();
        assert!(super::regex_find_at(&chars, 0, "^hell", &opts).is_some());
        let chars2: Vec<char> = "say hello".chars().collect();
        assert!(super::regex_find_at(&chars2, 0, "^hell", &opts).is_none());
    }

    #[test]
    fn regex_find_returns_span() {
        let opts = super::sed_opts();
        let chars: Vec<char> = "abcde".chars().collect();
        let (start, end) = super::regex_find_at(&chars, 0, "bc", &opts).unwrap();
        assert_eq!(start, 1);
        assert_eq!(end, 3);
    }
}
