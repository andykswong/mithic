use super::{write_stdout, expand_char_set};

pub fn run(args: &[&str]) -> u8 {
    use std::io::{BufRead, BufReader};

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

    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut buf = String::new();

    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let result = transform_line(&buf, delete, squeeze, &sets);
                write_stdout(&result);
            }
            Err(_) => break,
        }
    }
    0
}

fn transform_line(text: &str, delete: bool, squeeze: bool, sets: &[&str]) -> String {
    if delete {
        let set1 = sets.first().copied().unwrap_or("");
        let del_chars: Vec<char> = expand_char_set(set1);
        let filtered: String = text.chars().filter(|c| !del_chars.contains(c)).collect();
        if squeeze && sets.len() >= 2 {
            let sq_chars = expand_char_set(sets[1]);
            squeeze_chars(&filtered, &sq_chars)
        } else {
            filtered
        }
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
        if squeeze {
            squeeze_chars(&translated, &to)
        } else {
            translated
        }
    } else if squeeze && !sets.is_empty() {
        let sq_chars = expand_char_set(sets[0]);
        squeeze_chars(text, &sq_chars)
    } else {
        text.to_string()
    }
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
