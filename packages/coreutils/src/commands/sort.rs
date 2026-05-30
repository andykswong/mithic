use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut reverse = false;
    let mut numeric = false;
    let mut unique = false;
    let mut delimiter: Option<char> = None;
    let mut key_spec: Option<(usize, Option<usize>, bool)> = None;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-r" => reverse = true,
            "-n" => numeric = true,
            "-u" => unique = true,
            "-rn" | "-nr" => { reverse = true; numeric = true; }
            "-t" => {
                i += 1;
                if i < args.len() {
                    delimiter = args[i].chars().next();
                }
            }
            "-k" => {
                i += 1;
                if i < args.len() {
                    key_spec = parse_key_spec(args[i]);
                }
            }
            a if a.starts_with("-t") && a.len() > 2 => {
                delimiter = a.chars().nth(2);
            }
            a if a.starts_with("-k") && a.len() > 2 => {
                key_spec = parse_key_spec(&a[2..]);
            }
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'r' => reverse = true,
                        'n' => numeric = true,
                        'u' => unique = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let (data, errors) = read_input(&file_args);
    let mut lines: Vec<String> = lines_of(&data).iter().map(|s| s.to_string()).collect();

    let key_numeric = key_spec.as_ref().map(|k| k.2).unwrap_or(false) || numeric;

    lines.sort_by(|a, b| {
        let ka = extract_key(a, key_spec.as_ref(), delimiter);
        let kb = extract_key(b, key_spec.as_ref(), delimiter);

        if key_numeric {
            let na: f64 = ka.trim().parse().unwrap_or(0.0);
            let nb: f64 = kb.trim().parse().unwrap_or(0.0);
            na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
        } else {
            ka.cmp(&kb)
        }
    });

    if reverse {
        lines.reverse();
    }

    if unique {
        let key_numeric2 = key_numeric;
        lines.dedup_by(|a, b| {
            let ka = extract_key(a, key_spec.as_ref(), delimiter);
            let kb = extract_key(b, key_spec.as_ref(), delimiter);
            if key_numeric2 {
                let na: f64 = ka.trim().parse().unwrap_or(0.0);
                let nb: f64 = kb.trim().parse().unwrap_or(0.0);
                na == nb
            } else {
                ka == kb
            }
        });
    }

    let out = lines.join("\n");
    if !out.is_empty() {
        write_stdout(&out);
        write_stdout("\n");
    }
    errors
}

fn parse_key_spec(s: &str) -> Option<(usize, Option<usize>, bool)> {
    let numeric = s.ends_with('n');
    let s = if numeric { &s[..s.len() - 1] } else { s };
    let parts: Vec<&str> = s.split(',').collect();
    let start: usize = parts[0].parse::<usize>().ok()?.saturating_sub(1);
    let end: Option<usize> = if parts.len() > 1 {
        parts[1].trim_end_matches(|c: char| c.is_alphabetic())
            .parse::<usize>().ok().map(|n| n.saturating_sub(1))
    } else {
        None
    };
    Some((start, end, numeric))
}

fn extract_key(line: &str, key_spec: Option<&(usize, Option<usize>, bool)>, delimiter: Option<char>) -> String {
    let spec = match key_spec {
        Some(s) => s,
        None => return line.to_string(),
    };

    let fields: Vec<&str> = match delimiter {
        Some(d) => line.split(d).collect(),
        None => line.split_whitespace().collect(),
    };

    let start = spec.0;
    let end = spec.1.unwrap_or(fields.len().saturating_sub(1));
    let end = end.min(fields.len().saturating_sub(1));

    if start >= fields.len() {
        return String::new();
    }

    let sep: String = match delimiter {
        Some(d) => d.to_string(),
        None => " ".to_string(),
    };
    fields[start..=end].join(&sep)
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- parse_key_spec ---

    #[test]
    fn parse_key_single_field() {
        let k = parse_key_spec("2").unwrap();
        assert_eq!(k.0, 1); // 1-indexed becomes 0-indexed
        assert_eq!(k.1, None);
        assert!(!k.2);
    }

    #[test]
    fn parse_key_range() {
        let k = parse_key_spec("2,4").unwrap();
        assert_eq!(k.0, 1);
        assert_eq!(k.1, Some(3));
    }

    #[test]
    fn parse_key_numeric_flag() {
        let k = parse_key_spec("1n").unwrap();
        assert!(k.2);
    }

    #[test]
    fn parse_key_invalid_returns_none() {
        assert!(parse_key_spec("x").is_none());
    }

    // --- extract_key ---

    #[test]
    fn extract_key_no_spec_returns_whole_line() {
        assert_eq!(extract_key("a b c", None, None), "a b c");
    }

    #[test]
    fn extract_key_single_whitespace_field() {
        let spec = (1usize, None, false);
        assert_eq!(extract_key("alpha beta gamma", Some(&spec), None), "beta gamma");
    }

    #[test]
    fn extract_key_with_delimiter() {
        let spec = (1usize, Some(1usize), false);
        assert_eq!(extract_key("a:b:c", Some(&spec), Some(':')), "b");
    }

    #[test]
    fn extract_key_out_of_range_returns_empty() {
        let spec = (10usize, None, false);
        assert_eq!(extract_key("a b", Some(&spec), None), "");
    }

    // --- numeric extraction in sort logic ---

    #[test]
    fn numeric_key_parses_correctly() {
        // Verify that numeric parse logic works for typical sort -n values
        let n: f64 = "  42 ".trim().parse().unwrap_or(0.0);
        assert_eq!(n, 42.0);
        let n2: f64 = "hello".trim().parse().unwrap_or(0.0);
        assert_eq!(n2, 0.0);
    }
}
