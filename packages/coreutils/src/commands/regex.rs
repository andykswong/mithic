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
    let alternatives = split_alternatives(pattern);
    if alternatives.len() > 1 {
        let chars: Vec<char> = text.chars().collect();
        let mut best: Option<(usize, usize)> = None;
        for alt in &alternatives {
            if let Some((s, e)) = regex_find_at(&chars, 0, alt, opts) {
                match best {
                    None => best = Some((s, e)),
                    Some((bs, _)) if s < bs => best = Some((s, e)),
                    _ => {}
                }
            }
        }
        return best;
    }
    let chars: Vec<char> = text.chars().collect();
    regex_find_at(&chars, 0, pattern, opts)
}

pub fn regex_find_at(chars: &[char], from: usize, pattern: &str, opts: &RegexOpts) -> Option<(usize, usize)> {
    let pat: Vec<char> = pattern.chars().collect();
    if pat.first() == Some(&'^') {
        return regex_match_here(chars, from, &pat, 1, opts).map(|end| (from, end));
    }
    for start in from..=chars.len() {
        if let Some(end) = regex_match_here(chars, start, &pat, 0, opts) {
            return Some((start, end));
        }
    }
    None
}

fn split_alternatives(pattern: &str) -> Vec<String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut alts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut i = 0;
    let mut depth = 0i32;
    while i < chars.len() {
        match chars[i] {
            '\\' if i + 1 < chars.len() => {
                current.push('\\');
                current.push(chars[i + 1]);
                i += 2;
                continue;
            }
            '[' => { depth += 1; current.push('['); }
            ']' => {
                if depth > 0 { depth -= 1; }
                current.push(']');
            }
            '|' if depth == 0 => {
                alts.push(current.clone());
                current.clear();
            }
            c => current.push(c),
        }
        i += 1;
    }
    alts.push(current);
    alts
}

pub fn regex_match_here(h: &[char], hi: usize, p: &[char], pi: usize, opts: &RegexOpts) -> Option<usize> {
    let mut hi = hi;
    let mut pi = pi;
    loop {
        if pi >= p.len() {
            return Some(hi);
        }
        if p[pi] == '$' && pi == p.len() - 1 {
            return if hi == h.len() { Some(hi) } else { None };
        }

        let next_is_star = pi + 1 < p.len() && p[pi + 1] == '*';
        let next_is_plus = pi + 1 < p.len() && p[pi + 1] == '+';
        let next_is_quest = pi + 1 < p.len() && p[pi + 1] == '?';

        if next_is_star {
            let rest_pi = pi + 2;
            let start_hi = hi;
            while hi < h.len() && char_matches_impl(h[hi], p, pi, opts) {
                hi += 1;
            }
            loop {
                if let Some(r) = regex_match_here(h, hi, p, rest_pi, opts) {
                    return Some(r);
                }
                if hi == start_hi { break; }
                hi -= 1;
            }
            return None;
        }

        if next_is_plus {
            if hi >= h.len() || !char_matches_impl(h[hi], p, pi, opts) {
                return None;
            }
            hi += 1;
            let rest_pi = pi + 2;
            let start_hi = hi;
            while hi < h.len() && char_matches_impl(h[hi], p, pi, opts) {
                hi += 1;
            }
            loop {
                if let Some(r) = regex_match_here(h, hi, p, rest_pi, opts) {
                    return Some(r);
                }
                if hi == start_hi { break; }
                hi -= 1;
            }
            return None;
        }

        if next_is_quest {
            let rest_pi = pi + 2;
            if hi < h.len() && char_matches_impl(h[hi], p, pi, opts) {
                if let Some(r) = regex_match_here(h, hi + 1, p, rest_pi, opts) {
                    return Some(r);
                }
            }
            return regex_match_here(h, hi, p, rest_pi, opts);
        }

        if hi >= h.len() {
            return None;
        }
        if !char_matches_impl(h[hi], p, pi, opts) {
            return None;
        }
        hi += 1;
        pi = advance_pattern(p, pi);
    }
}

fn char_matches_impl(c: char, pat: &[char], pi: usize, opts: &RegexOpts) -> bool {
    match pat[pi] {
        '.' => {
            if opts.dot_matches_newline { true } else { c != '\n' }
        }
        '[' => {
            let end = pat[pi..].iter().position(|&x| x == ']').unwrap_or(pat.len() - pi - 1);
            let class = &pat[pi + 1..pi + end];
            if class.first() == Some(&'^') {
                !class_contains(&class[1..], c)
            } else {
                class_contains(class, c)
            }
        }
        '\\' if pi + 1 < pat.len() => match pat[pi + 1] {
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

pub fn char_matches(c: char, pat: &[char]) -> bool {
    let opts = RegexOpts::default();
    char_matches_impl(c, pat, 0, &opts)
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
