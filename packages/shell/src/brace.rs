pub fn find_brace_group(s: &str) -> Option<(&str, &str, &str)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let start = i;
            let mut depth = 1usize;
            i += 1;
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'{' => depth += 1,
                    b'}' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            if depth == 0 {
                let inner_start = start + 1;
                let inner_end = i - 1;
                return Some((&s[..start], &s[inner_start..inner_end], &s[i..]));
            }
            return None;
        }
        i += 1;
    }
    None
}

pub fn split_brace_alternatives(inner: &str) -> Vec<&str> {
    let mut results = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in inner.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                results.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    results.push(&inner[start..]);
    results
}

pub fn try_sequence(inner: &str) -> Option<Vec<String>> {
    let parts: Vec<&str> = inner.split("..").collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }

    if let (Ok(start_n), Ok(end_n)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
        let step: i64 = if parts.len() == 3 {
            parts[2].parse().ok()?
        } else {
            1
        };
        if step == 0 {
            return None;
        }
        let mut seq = Vec::new();
        if start_n <= end_n {
            let mut i = start_n;
            while i <= end_n {
                seq.push(i.to_string());
                i += step;
            }
        } else {
            let mut i = start_n;
            while i >= end_n {
                seq.push(i.to_string());
                i -= step;
            }
        }
        return Some(seq);
    }

    if parts[0].len() == 1 && parts[1].len() == 1 && parts.len() == 2 {
        let start_c = parts[0].as_bytes()[0];
        let end_c = parts[1].as_bytes()[0];
        if start_c.is_ascii_alphabetic() && end_c.is_ascii_alphabetic() {
            let mut seq = Vec::new();
            if start_c <= end_c {
                for c in start_c..=end_c {
                    seq.push((c as char).to_string());
                }
            } else {
                for c in (end_c..=start_c).rev() {
                    seq.push((c as char).to_string());
                }
            }
            return Some(seq);
        }
    }

    None
}

pub fn expand_braces(s: &str) -> Vec<String> {
    let Some((prefix, inner, suffix)) = find_brace_group(s) else {
        return vec![s.to_string()];
    };

    if let Some(seq) = try_sequence(inner) {
        return seq.into_iter()
            .flat_map(|item| expand_braces(&format!("{}{}{}", prefix, item, suffix)))
            .collect();
    }

    let alternatives = split_brace_alternatives(inner);
    if alternatives.len() <= 1 {
        return vec![s.to_string()];
    }

    alternatives.into_iter()
        .flat_map(|alt| expand_braces(&format!("{}{}{}", prefix, alt, suffix)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::expand_braces;

    #[test]
    fn test_brace_comma() {
        assert_eq!(expand_braces("{a,b,c}"), vec!["a", "b", "c"]);
        assert_eq!(expand_braces("pre{a,b}suf"), vec!["preasuf", "prebsuf"]);
    }

    #[test]
    fn test_brace_sequence_numeric() {
        assert_eq!(expand_braces("{1..5}"), vec!["1", "2", "3", "4", "5"]);
        assert_eq!(expand_braces("{5..1}"), vec!["5", "4", "3", "2", "1"]);
    }

    #[test]
    fn test_brace_sequence_alpha() {
        assert_eq!(expand_braces("{a..e}"), vec!["a", "b", "c", "d", "e"]);
    }

    #[test]
    fn test_brace_sequence_step() {
        assert_eq!(expand_braces("{0..10..2}"), vec!["0", "2", "4", "6", "8", "10"]);
    }

    #[test]
    fn test_brace_nested() {
        assert_eq!(expand_braces("{a,b{1,2}}"), vec!["a", "b1", "b2"]);
    }

    #[test]
    fn test_brace_no_expansion() {
        assert_eq!(expand_braces("hello"), vec!["hello"]);
        assert_eq!(expand_braces("{solo}"), vec!["{solo}"]);
    }
}
