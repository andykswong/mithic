use crate::parser::{Word, WordPart};

/// Return the literal string of a Word if it consists solely of `Literal` or `Quoted` parts.
pub(crate) fn literal_text(word: &Word) -> Option<String> {
    let mut s = String::new();
    for part in word.parts() {
        match part {
            WordPart::Literal(l) | WordPart::Quoted(l) => s.push_str(l),
            _ => return None,
        }
    }
    Some(s)
}

/// Parse `name[subscript]` from a string; returns `(name, op)` or the full string.
pub(crate) fn split_var_and_op(raw: &str) -> (&str, &str) {
    let end = raw.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(raw.len());
    (&raw[..end], &raw[end..])
}

pub(crate) fn remove_shortest_prefix(val: &str, pattern: &str, extglob: bool) -> String {
    for i in 0..=val.len() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match_ext(pattern, &val[..i], extglob) {
            return val[i..].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_longest_prefix(val: &str, pattern: &str, extglob: bool) -> String {
    for i in (0..=val.len()).rev() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match_ext(pattern, &val[..i], extglob) {
            return val[i..].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_shortest_suffix(val: &str, pattern: &str, extglob: bool) -> String {
    for i in (0..=val.len()).rev() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match_ext(pattern, &val[i..], extglob) {
            return val[..i].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_longest_suffix(val: &str, pattern: &str, extglob: bool) -> String {
    for i in 0..=val.len() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match_ext(pattern, &val[i..], extglob) {
            return val[..i].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn shell_substring(val: &str, spec: &str) -> String {
    let chars: Vec<char> = val.chars().collect();
    let len = chars.len() as i64;

    let (offset_str, length_str) = match spec.split_once(':') {
        Some((o, l)) => (o, Some(l)),
        None => (spec, None),
    };

    let offset: i64 = offset_str.parse().unwrap_or(0);
    let start = if offset < 0 {
        (len + offset).max(0) as usize
    } else {
        (offset as usize).min(chars.len())
    };

    let end = if let Some(l) = length_str {
        let length: i64 = l.parse().unwrap_or(0);
        if length < 0 {
            let end_pos = len + length;
            (end_pos.max(0) as usize).min(chars.len())
        } else {
            (start + length as usize).min(chars.len())
        }
    } else {
        chars.len()
    };

    chars[start.min(end)..end].iter().collect()
}

pub(crate) fn parse_array_subscript(s: &str) -> Option<(&str, &str)> {
    let open = s.find('[')?;
    let close = s.rfind(']')?;
    if close <= open { return None; }
    let name = &s[..open];
    let subscript = &s[open + 1..close];
    if name.is_empty() { return None; }
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') { return None; }
    Some((name, subscript))
}

pub(crate) fn expand_tilde(s: &str, home: &str) -> String {
    if s == "~" {
        home.to_string()
    } else if let Some(rest) = s.strip_prefix("~/") {
        format!("{}/{}", home.trim_end_matches('/'), rest)
    } else {
        s.to_string()
    }
}

pub(crate) fn has_glob(s: &str) -> bool {
    s.contains('*') || s.contains('?') || s.contains('[')
}

pub(crate) fn has_glob_ext(s: &str, extglob: bool) -> bool {
    if has_glob(s) { return true; }
    if extglob { has_extglob_pattern(s) } else { false }
}

fn has_extglob_pattern(s: &str) -> bool {
    let chars: Vec<char> = s.chars().collect();
    for i in 0..chars.len().saturating_sub(1) {
        if matches!(chars[i], '?' | '*' | '+' | '@' | '!') && chars[i + 1] == '(' {
            return true;
        }
    }
    false
}

pub(crate) fn glob_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let nam: Vec<char> = name.chars().collect();
    glob_match_inner(&pat, &nam)
}

pub(crate) fn glob_match_ext(pattern: &str, name: &str, extglob: bool) -> bool {
    if !extglob {
        return glob_match(pattern, name);
    }
    let pat: Vec<char> = pattern.chars().collect();
    let nam: Vec<char> = name.chars().collect();
    glob_match_ext_inner(&pat, &nam)
}

fn find_closing_paren(pat: &[char], start: usize) -> Option<usize> {
    let mut depth = 1;
    let mut i = start;
    while i < pat.len() {
        if pat[i] == '(' {
            depth += 1;
        } else if pat[i] == ')' {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn split_alternatives(pat: &[char]) -> Vec<&[char]> {
    let mut alts = Vec::new();
    let mut start = 0;
    let mut depth = 0;
    for i in 0..pat.len() {
        if pat[i] == '(' {
            depth += 1;
        } else if pat[i] == ')' {
            depth -= 1;
        } else if pat[i] == '|' && depth == 0 {
            alts.push(&pat[start..i]);
            start = i + 1;
        }
    }
    alts.push(&pat[start..]);
    alts
}

fn glob_match_ext_inner(pat: &[char], name: &[char]) -> bool {
    if pat.is_empty() && name.is_empty() { return true; }
    if pat.is_empty() { return false; }

    // Check for extglob operator: ?(, *(, +(, @(, !(
    if pat.len() >= 2 && pat[1] == '(' && matches!(pat[0], '?' | '*' | '+' | '@' | '!') {
        let op = pat[0];
        if let Some(close) = find_closing_paren(pat, 2) {
            let alternatives = split_alternatives(&pat[2..close]);
            let rest = &pat[close + 1..];

            match op {
                '@' => {
                    // Exactly one of the alternatives
                    for alt in &alternatives {
                        // Try matching alt + rest against name
                        if match_concat_ext(alt, rest, name) {
                            return true;
                        }
                    }
                    return false;
                }
                '?' => {
                    // Zero or one occurrence
                    // Try zero: match rest against name
                    if glob_match_ext_inner(rest, name) {
                        return true;
                    }
                    // Try one of the alternatives
                    for alt in &alternatives {
                        if match_concat_ext(alt, rest, name) {
                            return true;
                        }
                    }
                    return false;
                }
                '*' => {
                    // Zero or more occurrences
                    // Try zero: match rest against name
                    if glob_match_ext_inner(rest, name) {
                        return true;
                    }
                    // Try one alternative then recurse with *(...)rest
                    for alt in &alternatives {
                        for consumed in 1..=name.len() {
                            if glob_match_ext_inner(alt, &name[..consumed]) {
                                // After consuming, try *(...)rest on remainder
                                let mut new_pat = Vec::with_capacity(pat.len());
                                new_pat.extend_from_slice(&pat[..close + 1]);
                                new_pat.extend_from_slice(rest);
                                if glob_match_ext_inner(&new_pat, &name[consumed..]) {
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }
                '+' => {
                    // One or more occurrences — same as @(...) followed by *(...)
                    for alt in &alternatives {
                        for consumed in 1..=name.len() {
                            if glob_match_ext_inner(alt, &name[..consumed]) {
                                // Build *(...)rest pattern for remainder
                                let mut star_pat = vec!['*', '('];
                                star_pat.extend_from_slice(&pat[2..close]);
                                star_pat.push(')');
                                star_pat.extend_from_slice(rest);
                                if glob_match_ext_inner(&star_pat, &name[consumed..]) {
                                    return true;
                                }
                            }
                        }
                    }
                    return false;
                }
                '!' => {
                    // Anything except the patterns
                    // !(pat)rest matches if the entire string matches rest when we can
                    // consume a prefix that doesn't match any of the alternatives.
                    // Bash semantics: try every possible split point; at each point,
                    // the prefix must NOT match any alternative, and the suffix must match rest.
                    // Also: the whole string might match rest directly (zero-char prefix consumed).
                    // First try matching the whole name against rest (consuming zero chars for !)
                    if glob_match_ext_inner(rest, name) {
                        // But only if the empty string doesn't match any alternative
                        let empty_matches_alt = alternatives.iter().any(|alt| {
                            glob_match_ext_inner(alt, &[])
                        });
                        if !empty_matches_alt {
                            return true;
                        }
                    }
                    // Try consuming 1..=name.len() chars as "not matching any alt"
                    for consumed in 1..=name.len() {
                        let prefix = &name[..consumed];
                        let any_alt_matches = alternatives.iter().any(|alt| {
                            glob_match_ext_inner(alt, prefix)
                        });
                        if !any_alt_matches {
                            if glob_match_ext_inner(rest, &name[consumed..]) {
                                return true;
                            }
                        }
                    }
                    return false;
                }
                _ => unreachable!(),
            }
        }
    }

    // Not an extglob operator — fall through to regular matching with ext support
    match (pat.first(), name.first()) {
        (None, None) => true,
        (None, _) => false,
        (Some(&'*'), _) => {
            for skip in 0..=name.len() {
                if glob_match_ext_inner(&pat[1..], &name[skip..]) {
                    return true;
                }
            }
            false
        }
        (Some(&'?'), Some(_)) => glob_match_ext_inner(&pat[1..], &name[1..]),
        (Some(&'?'), None) => false,
        (Some(&'['), _) => {
            let close = find_bracket_close(&pat[1..]);
            if let Some(rel) = close {
                let class = &pat[1..1 + rel];
                let rest = &pat[2 + rel..];
                if let Some(&nc) = name.first() {
                    if char_class_matches(class, nc) {
                        return glob_match_ext_inner(rest, &name[1..]);
                    }
                }
                false
            } else {
                if name.first() == Some(&'[') {
                    glob_match_ext_inner(&pat[1..], &name[1..])
                } else {
                    false
                }
            }
        }
        (Some(pc), Some(nc)) => {
            if pc == nc {
                glob_match_ext_inner(&pat[1..], &name[1..])
            } else {
                false
            }
        }
        (Some(_), None) => false,
    }
}

fn match_concat_ext(first: &[char], second: &[char], name: &[char]) -> bool {
    // Try all split points: first matches name[..i], second matches name[i..]
    for i in 0..=name.len() {
        if glob_match_ext_inner(first, &name[..i]) && glob_match_ext_inner(second, &name[i..]) {
            return true;
        }
    }
    false
}

fn matches_posix_class(name: &str, c: char) -> bool {
    match name {
        "digit" => c.is_ascii_digit(),
        "alpha" => c.is_ascii_alphabetic(),
        "alnum" => c.is_ascii_alphanumeric(),
        "upper" => c.is_ascii_uppercase(),
        "lower" => c.is_ascii_lowercase(),
        "space" => c.is_ascii_whitespace(),
        "blank" => c == ' ' || c == '\t',
        "punct" => c.is_ascii_punctuation(),
        "print" => c >= ' ' && c <= '~',
        "graph" => c > ' ' && c <= '~',
        "cntrl" => c.is_ascii_control(),
        "xdigit" => c.is_ascii_hexdigit(),
        _ => false,
    }
}

fn char_class_matches(class: &[char], c: char) -> bool {
    let (negate, class) = if class.first() == Some(&'!') || class.first() == Some(&'^') {
        (true, &class[1..])
    } else {
        (false, class)
    };

    let mut matched = false;
    let mut i = 0;
    while i < class.len() {
        // Check for POSIX character class [:name:]
        if i + 3 < class.len() && class[i] == '[' && class[i + 1] == ':' {
            // Find the closing :]
            let start = i + 2;
            let mut end = None;
            let mut j = start;
            while j + 1 < class.len() {
                if class[j] == ':' && class[j + 1] == ']' {
                    end = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(end_pos) = end {
                let name: String = class[start..end_pos].iter().collect();
                if matches_posix_class(&name, c) {
                    matched = true;
                    break;
                }
                i = end_pos + 2; // skip past :]
                continue;
            }
        }

        if i + 2 < class.len() && class[i + 1] == '-' {
            let start = class[i];
            let end = class[i + 2];
            if c >= start && c <= end {
                matched = true;
                break;
            }
            i += 3;
        } else {
            if class[i] == c {
                matched = true;
                break;
            }
            i += 1;
        }
    }

    if negate { !matched } else { matched }
}

/// Find the closing `]` of a bracket expression, skipping over POSIX class sequences `[:...:]`.
fn find_bracket_close(chars: &[char]) -> Option<usize> {
    let mut i = 0;
    // Allow ] as first char in bracket (or after ^ / !)
    if i < chars.len() && (chars[i] == '!' || chars[i] == '^') {
        i += 1;
    }
    if i < chars.len() && chars[i] == ']' {
        i += 1;
    }
    while i < chars.len() {
        if chars[i] == '[' && i + 1 < chars.len() && chars[i + 1] == ':' {
            // Skip over [:...:] POSIX class
            let mut j = i + 2;
            while j + 1 < chars.len() {
                if chars[j] == ':' && chars[j + 1] == ']' {
                    j += 2;
                    break;
                }
                j += 1;
            }
            i = j;
        } else if chars[i] == ']' {
            return Some(i);
        } else {
            i += 1;
        }
    }
    None
}

fn glob_match_inner(pat: &[char], name: &[char]) -> bool {
    match (pat.first(), name.first()) {
        (None, None) => true,
        (None, _) => false,
        (Some(&'*'), _) => {
            for skip in 0..=name.len() {
                if glob_match_inner(&pat[1..], &name[skip..]) {
                    return true;
                }
            }
            false
        }
        (Some(&'?'), Some(_)) => glob_match_inner(&pat[1..], &name[1..]),
        (Some(&'?'), None) => false,
        (Some(&'['), _) => {
            let close = find_bracket_close(&pat[1..]);
            if let Some(rel) = close {
                let class = &pat[1..1 + rel];
                let rest = &pat[2 + rel..];
                if let Some(&nc) = name.first() {
                    if char_class_matches(class, nc) {
                        return glob_match_inner(rest, &name[1..]);
                    }
                }
                false
            } else {
                if name.first() == Some(&'[') {
                    glob_match_inner(&pat[1..], &name[1..])
                } else {
                    false
                }
            }
        }
        (Some(pc), Some(nc)) => {
            if pc == nc {
                glob_match_inner(&pat[1..], &name[1..])
            } else {
                false
            }
        }
        (Some(_), None) => false,
    }
}

pub(crate) fn glob_replace_first(val: &str, pattern: &str, replacement: &str, extglob: bool) -> String {
    if pattern.is_empty() { return val.to_string(); }
    let chars: Vec<char> = val.chars().collect();
    for start in 0..chars.len() {
        for end in (start + 1..=chars.len()).rev() {
            let substr: String = chars[start..end].iter().collect();
            if glob_match_ext(pattern, &substr, extglob) {
                let prefix: String = chars[..start].iter().collect();
                let suffix: String = chars[end..].iter().collect();
                return format!("{}{}{}", prefix, replacement, suffix);
            }
        }
    }
    val.to_string()
}

pub(crate) fn glob_replace_all(val: &str, pattern: &str, replacement: &str, extglob: bool) -> String {
    if pattern.is_empty() { return val.to_string(); }
    let chars: Vec<char> = val.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        let mut matched = false;
        for end in (i + 1..=chars.len()).rev() {
            let substr: String = chars[i..end].iter().collect();
            if glob_match_ext(pattern, &substr, extglob) {
                result.push_str(replacement);
                i = end;
                matched = true;
                break;
            }
        }
        if !matched {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

pub(crate) fn normalize_path(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => { parts.pop(); }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::{expand_tilde, glob_match, glob_match_ext, glob_replace_all, glob_replace_first, has_glob, has_glob_ext, normalize_path};

    #[test]
    fn test_tilde_expansion_in_word() {
        assert_eq!(expand_tilde("~/foo", "/home"), "/home/foo");
        assert_eq!(expand_tilde("~", "/home"), "/home");
        assert_eq!(expand_tilde("/abs/path", "/home"), "/abs/path");
        assert_eq!(expand_tilde("relative", "/home"), "relative");
    }

    #[test]
    fn test_normalize_simple() {
        assert_eq!(normalize_path("/home/user"), "/home/user");
    }

    #[test]
    fn test_normalize_dotdot() {
        assert_eq!(normalize_path("/home/user/../other"), "/home/other");
    }

    #[test]
    fn test_normalize_dot() {
        assert_eq!(normalize_path("/home/./user"), "/home/user");
    }

    #[test]
    fn test_normalize_trailing_slash() {
        assert_eq!(normalize_path("/home/user/"), "/home/user");
    }

    #[test]
    fn test_normalize_double_slash() {
        assert_eq!(normalize_path("/home//user"), "/home/user");
    }

    #[test]
    fn test_normalize_to_root() {
        assert_eq!(normalize_path("/home/.."), "/");
    }

    #[test]
    fn test_normalize_above_root() {
        assert_eq!(normalize_path("/../.."), "/");
    }

    #[test]
    fn test_glob_match_star() {
        assert!(glob_match("*.rs", "foo.rs"));
        assert!(glob_match("*.rs", ".rs"));
        assert!(!glob_match("*.rs", "foo.txt"));
        assert!(glob_match("foo*", "foobar"));
        assert!(!glob_match("foo*", "barfoo"));
    }

    #[test]
    fn test_glob_match_question() {
        assert!(glob_match("f?o", "foo"));
        assert!(glob_match("f?o", "fXo"));
        assert!(!glob_match("f?o", "fo"));
        assert!(!glob_match("f?o", "fooo"));
    }

    #[test]
    fn test_glob_match_bracket() {
        assert!(glob_match("[abc]at", "bat"));
        assert!(glob_match("[abc]at", "cat"));
        assert!(!glob_match("[abc]at", "dat"));
    }

    #[test]
    fn test_glob_match_bracket_range() {
        // digit range
        assert!(glob_match("[0-9]", "5"));
        assert!(glob_match("[0-9]", "0"));
        assert!(glob_match("[0-9]", "9"));
        assert!(!glob_match("[0-9]", "a"));
        // lowercase range
        assert!(glob_match("[a-z]", "m"));
        assert!(!glob_match("[a-z]", "M"));
        // uppercase range
        assert!(glob_match("[A-Z]", "M"));
        assert!(!glob_match("[A-Z]", "m"));
        // multiple ranges
        assert!(glob_match("[a-zA-Z0-9]", "Z"));
        assert!(glob_match("[a-zA-Z0-9]", "7"));
        assert!(!glob_match("[a-zA-Z0-9]", "-"));
    }

    #[test]
    fn test_glob_match_bracket_negation() {
        // ! negation
        assert!(glob_match("[!0-9]", "a"));
        assert!(!glob_match("[!0-9]", "5"));
        // ^ negation
        assert!(glob_match("[^a-z]", "A"));
        assert!(!glob_match("[^a-z]", "a"));
    }

    #[test]
    fn test_has_glob() {
        assert!(has_glob("*.rs"));
        assert!(has_glob("foo?bar"));
        assert!(has_glob("[abc]"));
        assert!(!has_glob("normal"));
        assert!(!has_glob("/path/to/file"));
    }

    #[test]
    fn test_glob_replace_first_star() {
        assert_eq!(glob_replace_first("hello", "h*", "X", false), "X");
        assert_eq!(glob_replace_first("hello", "h?", "X", false), "Xllo");
        assert_eq!(glob_replace_first("hello", "l", "L", false), "heLlo");
    }

    #[test]
    fn test_glob_replace_all_char_class() {
        assert_eq!(glob_replace_all("hello", "[lo]", "X", false), "heXXX");
        assert_eq!(glob_replace_all("hello", "l", "L", false), "heLLo");
    }

    #[test]
    fn test_glob_replace_all_star() {
        // greedy: "h*" starting at 0 matches "hello" (all chars)
        assert_eq!(glob_replace_all("hello", "h*", "X", false), "X");
    }

    #[test]
    fn test_glob_match_posix_digit() {
        assert!(glob_match("[[:digit:]]", "5"));
        assert!(glob_match("[[:digit:]]", "0"));
        assert!(glob_match("[[:digit:]]", "9"));
        assert!(!glob_match("[[:digit:]]", "a"));
        assert!(!glob_match("[[:digit:]]", " "));
        // In pattern context
        assert!(glob_match("f[[:digit:]].txt", "f1.txt"));
        assert!(!glob_match("f[[:digit:]].txt", "fa.txt"));
    }

    #[test]
    fn test_glob_match_posix_alpha() {
        assert!(glob_match("[[:alpha:]]", "a"));
        assert!(glob_match("[[:alpha:]]", "Z"));
        assert!(!glob_match("[[:alpha:]]", "5"));
        assert!(!glob_match("[[:alpha:]]", " "));
    }

    #[test]
    fn test_glob_match_posix_alnum() {
        assert!(glob_match("[[:alnum:]]", "a"));
        assert!(glob_match("[[:alnum:]]", "5"));
        assert!(!glob_match("[[:alnum:]]", "_"));
        assert!(!glob_match("[[:alnum:]]", " "));
    }

    #[test]
    fn test_glob_match_posix_upper_lower() {
        assert!(glob_match("[[:upper:]]", "A"));
        assert!(!glob_match("[[:upper:]]", "a"));
        assert!(glob_match("[[:lower:]]", "a"));
        assert!(!glob_match("[[:lower:]]", "A"));
    }

    #[test]
    fn test_glob_match_posix_space() {
        assert!(glob_match("[[:space:]]", " "));
        assert!(glob_match("[[:space:]]", "\t"));
        assert!(glob_match("[[:space:]]", "\n"));
        assert!(!glob_match("[[:space:]]", "a"));
    }

    #[test]
    fn test_glob_match_posix_punct() {
        assert!(glob_match("[[:punct:]]", "."));
        assert!(glob_match("[[:punct:]]", "!"));
        assert!(glob_match("[[:punct:]]", ","));
        assert!(!glob_match("[[:punct:]]", "a"));
        assert!(!glob_match("[[:punct:]]", "5"));
    }

    #[test]
    fn test_glob_match_posix_negated() {
        assert!(glob_match("[^[:digit:]]", "a"));
        assert!(!glob_match("[^[:digit:]]", "5"));
        assert!(glob_match("[![:digit:]]", "a"));
        assert!(!glob_match("[![:digit:]]", "5"));
    }

    #[test]
    fn test_glob_match_posix_mixed() {
        // Mix POSIX class with literal characters
        assert!(glob_match("[[:digit:]ab]", "1"));
        assert!(glob_match("[[:digit:]ab]", "a"));
        assert!(glob_match("[[:digit:]ab]", "b"));
        assert!(!glob_match("[[:digit:]ab]", "c"));
    }

    #[test]
    fn test_glob_match_posix_xdigit() {
        assert!(glob_match("[[:xdigit:]]", "a"));
        assert!(glob_match("[[:xdigit:]]", "F"));
        assert!(glob_match("[[:xdigit:]]", "9"));
        assert!(!glob_match("[[:xdigit:]]", "g"));
    }

    #[test]
    fn test_glob_match_posix_blank() {
        assert!(glob_match("[[:blank:]]", " "));
        assert!(glob_match("[[:blank:]]", "\t"));
        assert!(!glob_match("[[:blank:]]", "\n"));
        assert!(!glob_match("[[:blank:]]", "a"));
    }

    #[test]
    fn test_glob_match_posix_print_graph_cntrl() {
        assert!(glob_match("[[:print:]]", "a"));
        assert!(glob_match("[[:print:]]", " "));
        assert!(!glob_match("[[:print:]]", "\x01"));
        assert!(glob_match("[[:graph:]]", "a"));
        assert!(!glob_match("[[:graph:]]", " "));
        assert!(glob_match("[[:cntrl:]]", "\x01"));
        assert!(!glob_match("[[:cntrl:]]", "a"));
    }

    // --- extglob tests ---

    #[test]
    fn test_extglob_at_matches_one_alternative() {
        assert!(glob_match_ext("@(foo|bar)", "foo", true));
        assert!(glob_match_ext("@(foo|bar)", "bar", true));
        assert!(!glob_match_ext("@(foo|bar)", "baz", true));
        assert!(!glob_match_ext("@(foo|bar)", "foobar", true));
    }

    #[test]
    fn test_extglob_question_zero_or_one() {
        assert!(glob_match_ext("?(foo)", "", true));
        assert!(glob_match_ext("?(foo)", "foo", true));
        assert!(!glob_match_ext("?(foo)", "foofoo", true));
        assert!(glob_match_ext("?(foo|bar)", "bar", true));
        assert!(glob_match_ext("?(foo|bar)", "", true));
    }

    #[test]
    fn test_extglob_star_zero_or_more() {
        assert!(glob_match_ext("*(foo)", "", true));
        assert!(glob_match_ext("*(foo)", "foo", true));
        assert!(glob_match_ext("*(foo)", "foofoo", true));
        assert!(glob_match_ext("*(foo)", "foofoofoo", true));
        assert!(!glob_match_ext("*(foo)", "foobar", true));
        assert!(glob_match_ext("*(foo|bar)", "foobar", true));
        assert!(glob_match_ext("*(foo|bar)", "barfoo", true));
    }

    #[test]
    fn test_extglob_plus_one_or_more() {
        assert!(!glob_match_ext("+(foo)", "", true));
        assert!(glob_match_ext("+(foo)", "foo", true));
        assert!(glob_match_ext("+(foo)", "foofoo", true));
        assert!(!glob_match_ext("+(foo)", "bar", true));
    }

    #[test]
    fn test_extglob_not_matches_none() {
        assert!(glob_match_ext("!(foo)", "bar", true));
        assert!(glob_match_ext("!(foo)", "fo", true));
        assert!(!glob_match_ext("!(foo)", "foo", true));
        assert!(glob_match_ext("!(foo|bar)", "baz", true));
        assert!(!glob_match_ext("!(foo|bar)", "foo", true));
        assert!(!glob_match_ext("!(foo|bar)", "bar", true));
    }

    #[test]
    fn test_extglob_with_regular_globs() {
        assert!(glob_match_ext("@(*.txt|*.rs)", "file.txt", true));
        assert!(glob_match_ext("@(*.txt|*.rs)", "main.rs", true));
        assert!(!glob_match_ext("@(*.txt|*.rs)", "file.py", true));
    }

    #[test]
    fn test_extglob_combined_with_prefix_suffix() {
        assert!(glob_match_ext("foo@(bar|baz)", "foobar", true));
        assert!(glob_match_ext("foo@(bar|baz)", "foobaz", true));
        assert!(!glob_match_ext("foo@(bar|baz)", "fooqux", true));
        assert!(glob_match_ext("pre*(mid)suf", "presuf", true));
        assert!(glob_match_ext("pre*(mid)suf", "premidsuf", true));
        assert!(glob_match_ext("pre*(mid)suf", "premidmidsuf", true));
    }

    #[test]
    fn test_extglob_nested() {
        assert!(glob_match_ext("@(foo@(bar|baz))", "foobar", true));
        assert!(glob_match_ext("+(a@(b|c))", "ab", true));
        assert!(glob_match_ext("+(a@(b|c))", "abac", true));
    }

    #[test]
    fn test_extglob_disabled_literal() {
        assert!(!glob_match_ext("@(foo)", "foo", false));
        assert!(glob_match_ext("@(foo)", "@(foo)", false));
    }

    #[test]
    fn test_has_glob_ext() {
        assert!(!has_glob_ext("@(foo)", false));
        assert!(has_glob_ext("@(foo)", true));
        assert!(has_glob_ext("*(bar)", true));
        assert!(has_glob_ext("?(x)", true));
        assert!(has_glob_ext("+(y)", true));
        assert!(has_glob_ext("!(z)", true));
        assert!(has_glob_ext("*.rs", false));
        assert!(!has_glob_ext("normal", true));
    }

    #[test]
    fn test_extglob_replace() {
        assert_eq!(glob_replace_first("foobar", "@(foo|baz)", "X", true), "Xbar");
        assert_eq!(glob_replace_all("foobarfoo", "@(foo|bar)", "X", true), "XXX");
    }
}
