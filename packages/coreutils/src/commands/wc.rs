use super::{write_stdout, read_input};

pub fn run(args: &[&str]) -> u8 {
    let mut count_lines = false;
    let mut count_words = false;
    let mut count_bytes = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-l" => count_lines = true,
            "-w" => count_words = true,
            "-c" | "-m" => count_bytes = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'l' => count_lines = true,
                        'w' => count_words = true,
                        'c' | 'm' => count_bytes = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let show_all = !count_lines && !count_words && !count_bytes;

    let (data, errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);

    let lines = text.lines().count();
    let words = text.split_whitespace().count();
    let bytes = data.len();

    let mut parts: Vec<usize> = Vec::new();
    if show_all || count_lines { parts.push(lines); }
    if show_all || count_words { parts.push(words); }
    if show_all || count_bytes { parts.push(bytes); }

    let width = parts.iter().map(|n| n.to_string().len()).max().unwrap_or(1);
    let formatted: Vec<String> = parts.iter().map(|n| format!("{:>width$}", n, width = width)).collect();
    write_stdout(&formatted.join(" "));
    write_stdout("\n");
    errors
}

#[cfg(test)]
mod tests {
    fn count_stats(text: &str) -> (usize, usize, usize) {
        let lines = text.lines().count();
        let words = text.split_whitespace().count();
        let bytes = text.len();
        (lines, words, bytes)
    }

    #[test]
    fn count_empty() {
        assert_eq!(count_stats(""), (0, 0, 0));
    }

    #[test]
    fn count_single_line() {
        let (l, w, _b) = count_stats("hello world\n");
        assert_eq!(l, 1);
        assert_eq!(w, 2);
    }

    #[test]
    fn count_multiple_lines() {
        let (l, w, _b) = count_stats("one\ntwo\nthree\n");
        assert_eq!(l, 3);
        assert_eq!(w, 3);
    }

    #[test]
    fn count_bytes() {
        let (_l, _w, b) = count_stats("abc");
        assert_eq!(b, 3);
    }

    #[test]
    fn count_words_multiple_spaces() {
        let (_l, w, _b) = count_stats("  a   b   c  \n");
        assert_eq!(w, 3);
    }
}
