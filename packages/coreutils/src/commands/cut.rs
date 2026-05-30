use super::{write_stdout, read_input};

enum Mode {
    Fields { delim: char, list: Vec<usize> },
    Chars(Vec<usize>),
    Bytes(Vec<usize>),
}

pub fn run(args: &[&str]) -> u8 {
    let mut delim = '\t';
    let mut field_list: Option<Vec<usize>> = None;
    let mut char_list: Option<Vec<usize>> = None;
    let mut byte_list: Option<Vec<usize>> = None;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" => {
                i += 1;
                if i < args.len() {
                    delim = args[i].chars().next().unwrap_or('\t');
                }
            }
            "-f" => {
                i += 1;
                if i < args.len() {
                    field_list = Some(parse_list(args[i]));
                }
            }
            "-c" => {
                i += 1;
                if i < args.len() {
                    char_list = Some(parse_list(args[i]));
                }
            }
            "-b" => {
                i += 1;
                if i < args.len() {
                    byte_list = Some(parse_list(args[i]));
                }
            }
            a if a.starts_with("-d") => {
                delim = a[2..].chars().next().unwrap_or('\t');
            }
            a if a.starts_with("-f") => {
                field_list = Some(parse_list(&a[2..]));
            }
            a if a.starts_with("-c") => {
                char_list = Some(parse_list(&a[2..]));
            }
            a if a.starts_with("-b") => {
                byte_list = Some(parse_list(&a[2..]));
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let mode = if let Some(list) = byte_list {
        Mode::Bytes(list)
    } else if let Some(list) = char_list {
        Mode::Chars(list)
    } else {
        Mode::Fields { delim, list: field_list.unwrap_or_default() }
    };

    let (data, errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);

    for line in text.lines() {
        match &mode {
            Mode::Fields { delim, list } => {
                if list.is_empty() {
                    write_stdout(line);
                } else {
                    let parts: Vec<&str> = line.split(*delim).collect();
                    let selected: Vec<&str> = list.iter()
                        .filter_map(|&f| if f > 0 { parts.get(f - 1).copied() } else { None })
                        .collect();
                    write_stdout(&selected.join(&delim.to_string()));
                }
            }
            Mode::Chars(list) => {
                let chars: Vec<char> = line.chars().collect();
                let selected: String = list.iter()
                    .filter_map(|&p| if p > 0 { chars.get(p - 1).copied() } else { None })
                    .collect();
                write_stdout(&selected);
            }
            Mode::Bytes(list) => {
                let bytes = line.as_bytes();
                let selected: Vec<u8> = list.iter()
                    .filter_map(|&p| if p > 0 { bytes.get(p - 1).copied() } else { None })
                    .collect();
                write_stdout(&String::from_utf8_lossy(&selected));
            }
        }
        write_stdout("\n");
    }
    errors
}

fn parse_list(s: &str) -> Vec<usize> {
    let mut list = Vec::new();
    for part in s.split(',') {
        if let Some((a, b)) = part.split_once('-') {
            let start: usize = a.parse().unwrap_or(1);
            let end: usize = b.parse().unwrap_or(start);
            for f in start..=end {
                list.push(f);
            }
        } else if let Ok(n) = part.parse::<usize>() {
            list.push(n);
        }
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_list_single() {
        assert_eq!(parse_list("3"), vec![3]);
    }

    #[test]
    fn parse_list_multiple_comma() {
        assert_eq!(parse_list("1,3,5"), vec![1, 3, 5]);
    }

    #[test]
    fn parse_list_range() {
        assert_eq!(parse_list("2-5"), vec![2, 3, 4, 5]);
    }

    #[test]
    fn parse_list_mixed() {
        assert_eq!(parse_list("1,3-5,7"), vec![1, 3, 4, 5, 7]);
    }

    #[test]
    fn parse_list_single_range_element() {
        // "3-3" => [3]
        assert_eq!(parse_list("3-3"), vec![3]);
    }

    #[test]
    fn parse_list_ignores_non_numeric() {
        // non-numeric parts produce nothing (unwrap_or falls back)
        let list = parse_list("x,2");
        assert!(list.contains(&2));
    }
}
