use super::{write_stdout, read_stdin_all, expand_char_set};

pub fn run(args: &[&str]) -> u8 {
    let mut delete = false;
    let mut squeeze = false;
    let mut sets: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" => delete = true,
            "-s" => squeeze = true,
            "-ds" | "-sd" => { delete = true; squeeze = true; }
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'd' => delete = true,
                        's' => squeeze = true,
                        _ => {}
                    }
                }
            }
            _ => sets.push(args[i]),
        }
        i += 1;
    }

    let data = read_stdin_all();
    let text = String::from_utf8_lossy(&data).into_owned();

    if delete {
        let set1 = sets.first().copied().unwrap_or("");
        let del_chars: Vec<char> = expand_char_set(set1);
        let filtered: String = text.chars().filter(|c| !del_chars.contains(c)).collect();
        let result = if squeeze && sets.len() >= 2 {
            let sq_chars = expand_char_set(sets[1]);
            squeeze_chars(&filtered, &sq_chars)
        } else {
            filtered
        };
        write_stdout(&result);
    } else if sets.len() >= 2 {
        let from = expand_char_set(sets[0]);
        let to = expand_char_set(sets[1]);
        let translated: String = text.chars().map(|c| {
            if let Some(idx) = from.iter().position(|&f| f == c) {
                *to.get(idx).unwrap_or(to.last().unwrap_or(&c))
            } else {
                c
            }
        }).collect();
        let result = if squeeze {
            squeeze_chars(&translated, &to)
        } else {
            translated
        };
        write_stdout(&result);
    } else if squeeze && !sets.is_empty() {
        let sq_chars = expand_char_set(sets[0]);
        write_stdout(&squeeze_chars(&text, &sq_chars));
    } else {
        write_stdout(&text);
    }
    0
}

fn squeeze_chars(s: &str, chars: &[char]) -> String {
    let mut result = String::new();
    let mut last: Option<char> = None;
    for c in s.chars() {
        if chars.contains(&c) {
            if last != Some(c) {
                result.push(c);
            }
        } else {
            result.push(c);
        }
        last = Some(c);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::expand_char_set;

    #[test]
    fn squeeze_collapses_repeated_chars() {
        let chars = expand_char_set("a");
        assert_eq!(squeeze_chars("aaabbbccc", &chars), "abbbccc");
    }

    #[test]
    fn squeeze_multiple_char_set() {
        let chars = expand_char_set("ab");
        assert_eq!(squeeze_chars("aabbbaa", &chars), "aba");
    }

    #[test]
    fn squeeze_no_consecutive_repeats_unchanged() {
        let chars = expand_char_set("a");
        assert_eq!(squeeze_chars("abcabc", &chars), "abcabc");
    }

    #[test]
    fn squeeze_non_matching_chars_pass_through() {
        let chars = expand_char_set("x");
        assert_eq!(squeeze_chars("aabbcc", &chars), "aabbcc");
    }

    #[test]
    fn squeeze_empty_string() {
        let chars = expand_char_set("a");
        assert_eq!(squeeze_chars("", &chars), "");
    }
}
