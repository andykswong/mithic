use regex::Regex;

pub(crate) struct RegexMatch {
    pub matched: bool,
    pub groups: Vec<String>,
}

pub(crate) fn regex_match(text: &str, pattern: &str) -> RegexMatch {
    let re = match Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => return RegexMatch { matched: false, groups: vec![] },
    };

    match re.captures(text) {
        Some(caps) => {
            let mut groups = Vec::new();
            for i in 0..caps.len() {
                groups.push(
                    caps.get(i).map(|m| m.as_str().to_string()).unwrap_or_default(),
                );
            }
            RegexMatch { matched: true, groups }
        }
        None => RegexMatch { matched: false, groups: vec![] },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(text: &str, pat: &str) -> bool {
        regex_match(text, pat).matched
    }

    fn groups(text: &str, pat: &str) -> Vec<String> {
        regex_match(text, pat).groups
    }

    // -- Basic matching --

    #[test]
    fn literal_match() {
        assert!(m("hello", "hello"));
        assert!(!m("world", "hello"));
    }

    #[test]
    fn substring_match() {
        assert!(m("say hello world", "hello"));
        assert!(!m("world", "hello"));
    }

    #[test]
    fn dot_matches_any() {
        assert!(m("abc", "a.c"));
        assert!(m("aXc", "a.c"));
        assert!(!m("ac", "a.c"));
    }

    #[test]
    fn star_zero_or_more() {
        assert!(m("ac", "ab*c"));
        assert!(m("abc", "ab*c"));
        assert!(m("abbc", "ab*c"));
        assert!(!m("axc", "ab*c"));
    }

    #[test]
    fn plus_one_or_more() {
        assert!(!m("ac", "ab+c"));
        assert!(m("abc", "ab+c"));
        assert!(m("abbc", "ab+c"));
    }

    #[test]
    fn question_zero_or_one() {
        assert!(m("ac", "ab?c"));
        assert!(m("abc", "ab?c"));
        assert!(!m("abbc", "ab?c"));
    }

    // -- Anchors --

    #[test]
    fn anchor_start() {
        assert!(m("hello world", "^hello"));
        assert!(!m("say hello", "^hello"));
    }

    #[test]
    fn anchor_end() {
        assert!(m("say hello", "hello$"));
        assert!(!m("hello world", "hello$"));
    }

    #[test]
    fn anchor_both() {
        assert!(m("hello", "^hello$"));
        assert!(!m("hello world", "^hello$"));
        assert!(!m("say hello", "^hello$"));
    }

    // -- Character classes --

    #[test]
    fn char_class_basic() {
        assert!(m("cat", "[abc]at"));
        assert!(m("bat", "[abc]at"));
        assert!(!m("dat", "[abc]at"));
    }

    #[test]
    fn char_class_range() {
        assert!(m("a1", "[a-z][0-9]"));
        assert!(!m("A1", "[a-z][0-9]"));
        assert!(!m("aa", "[a-z][0-9]"));
    }

    #[test]
    fn char_class_negated() {
        assert!(!m("abc", "^[^abc]+$"));
        assert!(m("xyz", "[^abc]"));
    }

    // -- Alternation --

    #[test]
    fn alternation_basic() {
        assert!(m("cat", "cat|dog"));
        assert!(m("dog", "cat|dog"));
        assert!(!m("fish", "cat|dog"));
    }

    #[test]
    fn alternation_in_anchor() {
        assert!(m("hello123", "^hello([0-9]+)$"));
    }

    // -- Grouping and captures --

    #[test]
    fn capture_basic() {
        let g = groups("hello123", "^hello([0-9]+)$");
        assert_eq!(g.get(0).map(String::as_str), Some("hello123"));
        assert_eq!(g.get(1).map(String::as_str), Some("123"));
    }

    #[test]
    fn capture_multiple() {
        let g = groups("2024-01-15", "([0-9]+)-([0-9]+)-([0-9]+)");
        assert_eq!(g.get(0).map(String::as_str), Some("2024-01-15"));
        assert_eq!(g.get(1).map(String::as_str), Some("2024"));
        assert_eq!(g.get(2).map(String::as_str), Some("01"));
        assert_eq!(g.get(3).map(String::as_str), Some("15"));
    }

    #[test]
    fn no_match_returns_empty_groups() {
        let result = regex_match("hello", "^world");
        assert!(!result.matched);
        assert!(result.groups.is_empty());
    }

    // -- Escape --

    #[test]
    fn escaped_dot() {
        assert!(m("a.b", r"a\.b"));
        assert!(!m("axb", r"a\.b"));
    }

    #[test]
    fn escaped_star() {
        assert!(m("a*b", r"a\*b"));
        assert!(!m("ab", r"a\*b"));
    }

    // -- Complex patterns --

    #[test]
    fn email_like() {
        assert!(m("user@example.com", r"[a-zA-Z0-9]+@[a-zA-Z0-9]+\.[a-zA-Z]+"));
    }

    #[test]
    fn digits_only() {
        assert!(m("12345", "^[0-9]+$"));
        assert!(!m("123a5", "^[0-9]+$"));
    }

    #[test]
    fn optional_group() {
        assert!(m("colour", "colou?r"));
        assert!(m("color", "colou?r"));
    }

    #[test]
    fn word_boundary_like() {
        let g = groups("foo bar baz", "(bar)");
        assert_eq!(g.get(0).map(String::as_str), Some("bar"));
        assert_eq!(g.get(1).map(String::as_str), Some("bar"));
    }
}
