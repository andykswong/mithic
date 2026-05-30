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

    let script = expressions.join(";");
    let parsed = match parse_script(&script) {
        Some(cmds) => cmds,
        None => {
            write_stderr("sed: invalid expression\n");
            return 1;
        }
    };

    if file_args.is_empty() {
        let data = read_stdin_all();
        let text = String::from_utf8_lossy(&data);
        let result = apply_script(&text, &parsed, suppress);
        write_stdout(&result);
    } else {
        let mut errors = 0u8;
        for &path in &file_args {
            match read_file(path) {
                Some(data) => {
                    let text = String::from_utf8_lossy(&data);
                    let result = apply_script(&text, &parsed, suppress);
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
    HoldCopy,
    HoldAppend,
    GetCopy,
    GetAppend,
    Exchange,
    Label(String),
    Branch(Option<String>),
    BranchIfSub(Option<String>),
}

struct SedExpr {
    address: Option<Address>,
    cmd: SedCmd,
}

fn parse_script(script: &str) -> Option<Vec<SedExpr>> {
    let mut result = Vec::new();
    let commands = split_commands(script);
    for cmd_str in &commands {
        let trimmed = cmd_str.trim();
        if trimmed.is_empty() { continue; }
        result.push(parse_single_command(trimmed)?);
    }
    Some(result)
}

fn split_commands(script: &str) -> Vec<String> {
    let mut commands = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = script.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        if chars[i] == ';' || chars[i] == '\n' {
            commands.push(current.clone());
            current.clear();
        } else if chars[i] == 's' && current.trim().is_empty() || (chars[i] == 's' && !current.is_empty() && is_address_prefix(&current)) {
            // We might be at the start of a substitution command — need to handle delimiters
            // But actually the simpler approach: if current is empty or just an address,
            // check if this is an 's' command. For correctness, let's just handle the
            // substitution delimiter case by not splitting on ';' inside s commands.
            // Re-approach: scan forward to find end of substitution.
            let prefix = current.clone();
            current.push(chars[i]);
            i += 1;
            if i < chars.len() {
                let delim = chars[i];
                current.push(delim);
                i += 1;
                // Find closing: pattern/replacement/flags
                let mut field_count = 0;
                while i < chars.len() && field_count < 2 {
                    if chars[i] == '\\' && i + 1 < chars.len() {
                        current.push(chars[i]);
                        current.push(chars[i + 1]);
                        i += 2;
                        continue;
                    }
                    if chars[i] == delim {
                        field_count += 1;
                    }
                    current.push(chars[i]);
                    i += 1;
                }
                // Consume flags
                while i < chars.len() && chars[i] != ';' && chars[i] != '\n' {
                    current.push(chars[i]);
                    i += 1;
                }
                let _ = prefix; // prefix already in current from before the 's'
                commands.push(current.clone());
                current.clear();
            }
            continue;
        } else {
            current.push(chars[i]);
        }
        i += 1;
    }
    if !current.trim().is_empty() {
        commands.push(current);
    }
    commands
}

fn is_address_prefix(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() { return false; }
    // Ends with a digit (line address) or ends with '/' (pattern address end)
    let last = t.chars().last().unwrap();
    last.is_ascii_digit() || last == '/'
}

fn parse_single_command(expr: &str) -> Option<SedExpr> {
    if expr.is_empty() { return None; }

    // Label definition: :name
    if expr.starts_with(':') {
        let label = expr[1..].trim().to_string();
        if label.is_empty() { return None; }
        return Some(SedExpr { address: None, cmd: SedCmd::Label(label) });
    }

    // Branch commands: b [label], t [label]
    if expr.starts_with('b') && (expr.len() == 1 || expr.as_bytes().get(1).map_or(true, |&c| c == b' ' || c == b'\t')) {
        let label = expr[1..].trim();
        let target = if label.is_empty() { None } else { Some(label.to_string()) };
        return Some(SedExpr { address: None, cmd: SedCmd::Branch(target) });
    }
    if expr.starts_with('t') && (expr.len() == 1 || expr.as_bytes().get(1).map_or(true, |&c| c == b' ' || c == b'\t')) {
        let label = expr[1..].trim();
        let target = if label.is_empty() { None } else { Some(label.to_string()) };
        return Some(SedExpr { address: None, cmd: SedCmd::BranchIfSub(target) });
    }

    // Parse optional address
    let (address, rest) = parse_address(expr)?;

    // Parse command
    if rest.starts_with('s') {
        let sub = &rest[1..];
        if sub.is_empty() { return None; }
        let delim = sub.chars().next()?;
        let parts = split_substitution(&sub[1..], delim)?;
        let pattern = parts.0.to_string();
        let replacement = parts.1.to_string();
        let flags = parts.2;
        let global = flags.contains('g');
        Some(SedExpr { address, cmd: SedCmd::Substitute { pattern, replacement, global } })
    } else if rest.starts_with('d') {
        Some(SedExpr { address, cmd: SedCmd::Delete })
    } else if rest.starts_with('p') {
        Some(SedExpr { address, cmd: SedCmd::Print })
    } else if rest.starts_with('h') {
        Some(SedExpr { address, cmd: SedCmd::HoldCopy })
    } else if rest.starts_with('H') {
        Some(SedExpr { address, cmd: SedCmd::HoldAppend })
    } else if rest.starts_with('g') {
        Some(SedExpr { address, cmd: SedCmd::GetCopy })
    } else if rest.starts_with('G') {
        Some(SedExpr { address, cmd: SedCmd::GetAppend })
    } else if rest.starts_with('x') {
        Some(SedExpr { address, cmd: SedCmd::Exchange })
    } else if rest.starts_with('b') {
        let label = rest[1..].trim();
        let target = if label.is_empty() { None } else { Some(label.to_string()) };
        Some(SedExpr { address, cmd: SedCmd::Branch(target) })
    } else if rest.starts_with('t') {
        let label = rest[1..].trim();
        let target = if label.is_empty() { None } else { Some(label.to_string()) };
        Some(SedExpr { address, cmd: SedCmd::BranchIfSub(target) })
    } else {
        None
    }
}

fn split_substitution(s: &str, delim: char) -> Option<(String, String, String)> {
    let chars: Vec<char> = s.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut i = 0;

    while i < chars.len() && parts.len() < 2 {
        if chars[i] == '\\' && i + 1 < chars.len() {
            current.push(chars[i]);
            current.push(chars[i + 1]);
            i += 2;
            continue;
        }
        if chars[i] == delim {
            parts.push(current.clone());
            current.clear();
        } else {
            current.push(chars[i]);
        }
        i += 1;
    }
    if parts.len() < 2 { return None; }
    // Collect remaining characters as flags
    let flags: String = chars[i..].iter().collect();
    Some((parts[0].clone(), parts[1].clone(), flags))
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

fn find_label(exprs: &[SedExpr], label: &str) -> Option<usize> {
    for (i, expr) in exprs.iter().enumerate() {
        if let SedCmd::Label(ref l) = expr.cmd {
            if l == label { return Some(i); }
        }
    }
    None
}

fn apply_script(text: &str, exprs: &[SedExpr], suppress: bool) -> String {
    let raw_lines: Vec<&str> = text.split('\n').collect();
    let has_trailing_newline = text.ends_with('\n');
    let line_count = if has_trailing_newline && !raw_lines.is_empty() {
        raw_lines.len() - 1
    } else {
        raw_lines.len()
    };

    let mut result = String::new();
    let mut hold_space = String::new();

    for (idx, &line) in raw_lines.iter().enumerate() {
        let lineno = idx + 1;
        if has_trailing_newline && idx == raw_lines.len() - 1 && line.is_empty() {
            break;
        }

        let mut s = line.to_string();
        let mut deleted = false;
        let mut explicitly_printed = false;
        let mut sub_made = false;

        let mut ip = 0;
        while ip < exprs.len() {
            let expr = &exprs[ip];

            if let SedCmd::Label(_) = &expr.cmd {
                ip += 1;
                continue;
            }

            let active = match &expr.address {
                None => true,
                Some(addr) => address_matches(addr, lineno, &s),
            };
            if !active { ip += 1; continue; }

            match &expr.cmd {
                SedCmd::Delete => { deleted = true; break; }
                SedCmd::Print => {
                    result.push_str(&s);
                    result.push('\n');
                    explicitly_printed = true;
                }
                SedCmd::Substitute { pattern, replacement, global } => {
                    let new_s = apply_substitute(&s, pattern, replacement, *global);
                    if new_s != s {
                        sub_made = true;
                    }
                    s = new_s;
                }
                SedCmd::HoldCopy => {
                    hold_space = s.clone();
                }
                SedCmd::HoldAppend => {
                    hold_space.push('\n');
                    hold_space.push_str(&s);
                }
                SedCmd::GetCopy => {
                    s = hold_space.clone();
                }
                SedCmd::GetAppend => {
                    s.push('\n');
                    s.push_str(&hold_space);
                }
                SedCmd::Exchange => {
                    let tmp = s.clone();
                    s = hold_space.clone();
                    hold_space = tmp;
                }
                SedCmd::Branch(target) => {
                    match target {
                        Some(label) => {
                            match find_label(exprs, label) {
                                Some(pos) => { ip = pos; continue; }
                                None => break, // non-existent label: skip to end
                            }
                        }
                        None => break, // branch to end
                    }
                }
                SedCmd::BranchIfSub(target) => {
                    if sub_made {
                        sub_made = false;
                        match target {
                            Some(label) => {
                                match find_label(exprs, label) {
                                    Some(pos) => { ip = pos; continue; }
                                    None => break,
                                }
                            }
                            None => break,
                        }
                    } else {
                        sub_made = false;
                    }
                }
                SedCmd::Label(_) => {} // already handled above
            }
            ip += 1;
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

#[cfg(test)]
fn apply_expressions(text: &str, exprs: &[SedExpr], suppress: bool) -> String {
    apply_script(text, exprs, suppress)
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

    // --- parse_single_command / parse_address ---

    fn parse_expr(s: &str) -> Option<SedExpr> {
        parse_single_command(s)
    }

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

    // --- hold space commands ---

    #[test]
    fn hold_copy_and_get_copy() {
        // h on line 1 copies "one" to hold; g on line 2 replaces "two" with "one"
        let exprs = parse_script("1h;2g").unwrap();
        assert_eq!(apply_script("one\ntwo\nthree\n", &exprs, false), "one\none\nthree\n");
    }

    #[test]
    fn hold_append_and_get_append() {
        // H on lines 1,2 accumulates; G on line 3 appends hold to pattern
        let exprs = parse_script("1h;2H;3G").unwrap();
        // After line 1: hold="one"
        // After line 2: hold="one\ntwo"
        // Line 3: pattern="three\none\ntwo"
        assert_eq!(apply_script("one\ntwo\nthree\n", &exprs, false), "one\ntwo\nthree\none\ntwo\n");
    }

    #[test]
    fn exchange_pattern_and_hold() {
        // x on line 2 swaps pattern (="two") with hold (="" initially)
        let exprs = parse_script("2x").unwrap();
        // Line 1: "one" printed as-is
        // Line 2: x swaps "" (hold) and "two" (pattern), prints ""
        // Line 3: "three" printed as-is
        assert_eq!(apply_script("one\ntwo\nthree\n", &exprs, false), "one\n\nthree\n");
    }

    #[test]
    fn exchange_preserves_hold() {
        // Line 1: h copies "one" to hold
        // Line 2: x swaps: pattern becomes "one", hold becomes "two"
        let exprs = parse_script("1h;2x").unwrap();
        assert_eq!(apply_script("one\ntwo\nthree\n", &exprs, false), "one\none\nthree\n");
    }

    #[test]
    fn hold_append_uses_newline_separator() {
        // Start: hold=""
        // Line 1: H appends => hold="\none"
        let exprs = parse_script("1H;2g").unwrap();
        // Line 2: g copies hold to pattern => pattern="\none"
        assert_eq!(apply_script("one\ntwo\n", &exprs, false), "one\n\none\n");
    }

    // --- branch/label commands ---

    #[test]
    fn branch_to_end_skips_remaining() {
        // b skips the delete, so line is printed
        let exprs = parse_script("b;d").unwrap();
        assert_eq!(apply_script("hello\n", &exprs, false), "hello\n");
    }

    #[test]
    fn branch_to_label() {
        // :skip is after the delete, so d is skipped
        let exprs = parse_script("b skip;d;:skip").unwrap();
        assert_eq!(apply_script("hello\n", &exprs, false), "hello\n");
    }

    #[test]
    fn branch_nonexistent_label_skips_to_end() {
        let exprs = parse_script("b nowhere;d").unwrap();
        assert_eq!(apply_script("hello\n", &exprs, false), "hello\n");
    }

    #[test]
    fn branch_if_sub_taken() {
        // s/a/X/ matches on "abc", so t skip jumps over d
        let exprs = parse_script("s/a/X/;t skip;d;:skip").unwrap();
        assert_eq!(apply_script("abc\n", &exprs, false), "Xbc\n");
    }

    #[test]
    fn branch_if_sub_not_taken() {
        // s/z/X/ does NOT match "abc", so t skip is not taken, d executes
        let exprs = parse_script("s/z/X/;t skip;d;:skip").unwrap();
        assert_eq!(apply_script("abc\n", &exprs, false), "");
    }

    #[test]
    fn branch_if_sub_resets_flag() {
        // First t consumes the substitution flag; second t should not branch
        let exprs = parse_script("s/a/X/;t next;:next;t done;d;:done").unwrap();
        // s/a/X/ matches => sub_made=true
        // t next => branches to :next, resets sub_made
        // t done => sub_made is false, does NOT branch
        // d => deletes line
        assert_eq!(apply_script("abc\n", &exprs, false), "");
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
