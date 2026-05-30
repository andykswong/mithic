use regex::RegexBuilder;

pub struct RegexOpts {
    pub dot_matches_newline: bool,
}

impl Default for RegexOpts {
    fn default() -> Self {
        Self { dot_matches_newline: true }
    }
}

pub fn regex_matches(text: &str, pattern: &str) -> bool {
    regex_find(text, pattern).is_some()
}

pub fn regex_find(text: &str, pattern: &str) -> Option<(usize, usize)> {
    let opts = RegexOpts::default();
    regex_find_opts(text, pattern, &opts)
}

pub fn regex_find_opts(text: &str, pattern: &str, opts: &RegexOpts) -> Option<(usize, usize)> {
    let re = RegexBuilder::new(pattern)
        .dot_matches_new_line(opts.dot_matches_newline)
        .build()
        .ok()?;

    let m = re.find(text)?;
    let start_chars = text[..m.start()].chars().count();
    let match_chars = m.as_str().chars().count();
    Some((start_chars, start_chars + match_chars))
}

pub fn regex_find_at(chars: &[char], from: usize, pattern: &str, opts: &RegexOpts) -> Option<(usize, usize)> {
    let text: String = chars[from..].iter().collect();

    let re = RegexBuilder::new(pattern)
        .dot_matches_new_line(opts.dot_matches_newline)
        .build()
        .ok()?;

    let m = re.find(&text)?;
    let start_chars = text[..m.start()].chars().count();
    let match_chars = m.as_str().chars().count();
    Some((from + start_chars, from + start_chars + match_chars))
}

pub fn char_matches(c: char, pat: &[char]) -> bool {
    let opts = RegexOpts::default();
    char_matches_impl(c, pat, &opts)
}

fn char_matches_impl(c: char, pat: &[char], opts: &RegexOpts) -> bool {
    if pat.is_empty() {
        return false;
    }
    match pat[0] {
        '.' => {
            if opts.dot_matches_newline { true } else { c != '\n' }
        }
        '[' => {
            let end = pat[1..].iter().position(|&x| x == ']').unwrap_or(pat.len() - 1);
            let class = &pat[1..1 + end];
            if class.first() == Some(&'^') {
                !class_contains(&class[1..], c)
            } else {
                class_contains(class, c)
            }
        }
        '\\' if pat.len() > 1 => match pat[1] {
            'd' => c.is_ascii_digit(),
            'w' => c.is_alphanumeric() || c == '_',
            's' => c.is_whitespace(),
            'D' => !c.is_ascii_digit(),
            'W' => !(c.is_alphanumeric() || c == '_'),
            'S' => !c.is_whitespace(),
            other => c == other,
        },
        literal => c == literal,
    }
}

pub fn class_contains(class: &[char], c: char) -> bool {
    let mut i = 0;
    while i < class.len() {
        if i + 2 < class.len() && class[i + 1] == '-' {
            if c >= class[i] && c <= class[i + 2] {
                return true;
            }
            i += 3;
        } else {
            if class[i] == c {
                return true;
            }
            i += 1;
        }
    }
    false
}

pub fn advance_pattern(p: &[char], pi: usize) -> usize {
    match p[pi] {
        '[' => {
            let end = p[pi..].iter().position(|&x| x == ']').unwrap_or(p.len() - pi - 1);
            pi + end + 1
        }
        '\\' if pi + 1 < p.len() => pi + 2,
        _ => pi + 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(haystack: &str, pattern: &str) -> bool {
        regex_matches(haystack, pattern)
    }

    #[test]
    fn literal_match() {
        assert!(matches("hello world", "hello"));
    }

    #[test]
    fn literal_no_match() {
        assert!(!matches("hello world", "xyz"));
    }

    #[test]
    fn dot_matches_any_char() {
        assert!(matches("abc", "a.c"));
    }

    #[test]
    fn dot_does_not_match_nothing() {
        assert!(!matches("ac", "a.c"));
    }

    #[test]
    fn star_zero_occurrences() {
        assert!(matches("ac", "ab*c"));
    }

    #[test]
    fn star_multiple_occurrences() {
        assert!(matches("abbbc", "ab*c"));
    }

    #[test]
    fn plus_requires_at_least_one() {
        assert!(!matches("ac", "ab+c"));
        assert!(matches("abc", "ab+c"));
        assert!(matches("abbc", "ab+c"));
    }

    #[test]
    fn question_zero_or_one() {
        assert!(matches("ac", "ab?c"));
        assert!(matches("abc", "ab?c"));
        assert!(!matches("abbc", "ab?c"));
    }

    #[test]
    fn anchor_caret_anchors_start() {
        assert!(matches("hello", "^hello"));
        assert!(!matches("say hello", "^hello"));
    }

    #[test]
    fn anchor_dollar_anchors_end() {
        assert!(matches("hello", "hello$"));
        assert!(!matches("hello world", "hello$"));
    }

    #[test]
    fn anchor_both_full_match() {
        assert!(matches("hello", "^hello$"));
        assert!(!matches("hello world", "^hello$"));
    }

    #[test]
    fn char_class_basic() {
        assert!(matches("cat", "[abc]at"));
        assert!(!matches("dat", "[abc]at"));
    }

    #[test]
    fn char_class_range() {
        assert!(matches("a5b", "a[0-9]b"));
        assert!(!matches("axb", "a[0-9]b"));
    }

    #[test]
    fn char_class_negated() {
        assert!(matches("axb", "a[^0-9]b"));
        assert!(!matches("a5b", "a[^0-9]b"));
    }

    #[test]
    fn backslash_d_matches_digits() {
        assert!(matches("x5y", r"x\dy"));
        assert!(!matches("xay", r"x\dy"));
    }

    #[test]
    fn backslash_w_matches_word_chars() {
        assert!(matches("x_y", r"x\wy"));
        assert!(matches("xay", r"x\wy"));
        assert!(!matches("x y", r"x\wy"));
    }

    #[test]
    fn backslash_s_matches_whitespace() {
        assert!(matches("x y", r"x\sy"));
        assert!(!matches("xay", r"x\sy"));
    }

    #[test]
    fn backslash_capital_d_negates_digit() {
        assert!(matches("xay", r"x\Dy"));
        assert!(!matches("x5y", r"x\Dy"));
    }

    #[test]
    fn dot_star_matches_any_substring() {
        assert!(matches("foobar", "foo.*bar"));
        assert!(matches("foobar", "foo.*"));
    }

    #[test]
    fn empty_pattern_matches_everything() {
        assert!(matches("anything", ""));
    }

    #[test]
    fn pattern_longer_than_haystack_no_match() {
        assert!(!matches("ab", "abc"));
    }

    #[test]
    fn alternation_first_branch() {
        assert!(matches("foo", "foo|bar"));
        assert!(matches("bar", "foo|bar"));
        assert!(!matches("baz", "foo|bar"));
    }

    #[test]
    fn alternation_leftmost_wins() {
        let result = regex_find("foobar", "foo|foobar");
        assert_eq!(result, Some((0, 3)));
    }

    #[test]
    fn dot_star_greedy_leftmost_longest() {
        let opts = RegexOpts { dot_matches_newline: false };
        let chars: Vec<char> = "foo".chars().collect();
        let result = regex_find_at(&chars, 0, ".*", &opts);
        assert_eq!(result, Some((0, 3)));
    }

    #[test]
    fn sed_dot_does_not_match_newline() {
        let opts = RegexOpts { dot_matches_newline: false };
        assert!(!regex_find_opts("a\nb", "a.b", &opts).is_some());
    }

    #[test]
    fn grep_dot_matches_newline() {
        let opts = RegexOpts { dot_matches_newline: true };
        assert!(regex_find_opts("a\nb", "a.b", &opts).is_some());
    }
}
