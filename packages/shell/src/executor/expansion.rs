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

pub(crate) fn remove_shortest_prefix(val: &str, pattern: &str) -> String {
    for i in 0..=val.len() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match(pattern, &val[..i]) {
            return val[i..].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_longest_prefix(val: &str, pattern: &str) -> String {
    for i in (0..=val.len()).rev() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match(pattern, &val[..i]) {
            return val[i..].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_shortest_suffix(val: &str, pattern: &str) -> String {
    for i in (0..=val.len()).rev() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match(pattern, &val[i..]) {
            return val[..i].to_string();
        }
    }
    val.to_string()
}

pub(crate) fn remove_longest_suffix(val: &str, pattern: &str) -> String {
    for i in 0..=val.len() {
        if !val.is_char_boundary(i) { continue; }
        if glob_match(pattern, &val[i..]) {
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

pub(crate) fn glob_match(pattern: &str, name: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let nam: Vec<char> = name.chars().collect();
    glob_match_inner(&pat, &nam)
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
            let close = pat[1..].iter().position(|&c| c == ']');
            if let Some(rel) = close {
                let class = &pat[1..1 + rel];
                let rest = &pat[2 + rel..];
                if let Some(&nc) = name.first() {
                    if class.contains(&nc) {
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

pub(crate) fn glob_replace_first(val: &str, pattern: &str, replacement: &str) -> String {
    if pattern.is_empty() { return val.to_string(); }
    let chars: Vec<char> = val.chars().collect();
    // For each start position, try longest match first (greedy, matching bash behavior)
    for start in 0..chars.len() {
        for end in (start + 1..=chars.len()).rev() {
            let substr: String = chars[start..end].iter().collect();
            if glob_match(pattern, &substr) {
                let prefix: String = chars[..start].iter().collect();
                let suffix: String = chars[end..].iter().collect();
                return format!("{}{}{}", prefix, replacement, suffix);
            }
        }
    }
    val.to_string()
}

pub(crate) fn glob_replace_all(val: &str, pattern: &str, replacement: &str) -> String {
    if pattern.is_empty() { return val.to_string(); }
    let chars: Vec<char> = val.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        let mut matched = false;
        // Try longest match first at position i (greedy, matching bash behavior)
        for end in (i + 1..=chars.len()).rev() {
            let substr: String = chars[i..end].iter().collect();
            if glob_match(pattern, &substr) {
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
    use super::{expand_tilde, glob_match, glob_replace_all, glob_replace_first, has_glob, normalize_path};

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
    fn test_has_glob() {
        assert!(has_glob("*.rs"));
        assert!(has_glob("foo?bar"));
        assert!(has_glob("[abc]"));
        assert!(!has_glob("normal"));
        assert!(!has_glob("/path/to/file"));
    }

    #[test]
    fn test_glob_replace_first_star() {
        assert_eq!(glob_replace_first("hello", "h*", "X"), "X");
        assert_eq!(glob_replace_first("hello", "h?", "X"), "Xllo");
        assert_eq!(glob_replace_first("hello", "l", "L"), "heLlo");
    }

    #[test]
    fn test_glob_replace_all_char_class() {
        assert_eq!(glob_replace_all("hello", "[lo]", "X"), "heXXX");
        assert_eq!(glob_replace_all("hello", "l", "L"), "heLLo");
    }

    #[test]
    fn test_glob_replace_all_star() {
        // greedy: "h*" starting at 0 matches "hello" (all chars)
        assert_eq!(glob_replace_all("hello", "h*", "X"), "X");
    }
}
