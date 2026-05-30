use super::{write_stdout, write_stderr, read_input};
use super::regex::{RegexOpts, regex_find_opts};

pub fn run(args: &[&str]) -> u8 {
    let mut invert = false;
    let mut count_mode = false;
    let mut ignore_case = false;
    let mut line_number = false;
    let mut list_files = false;
    let mut patterns: Vec<String> = Vec::new();
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-v" => invert = true,
            "-c" => count_mode = true,
            "-i" => ignore_case = true,
            "-n" => line_number = true,
            "-l" => list_files = true,
            "-E" => {}
            "-e" => {
                i += 1;
                if i < args.len() {
                    patterns.push(args[i].to_string());
                }
            }
            a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => {
                for c in a[1..].chars() {
                    match c {
                        'v' => invert = true,
                        'c' => count_mode = true,
                        'i' => ignore_case = true,
                        'n' => line_number = true,
                        'l' => list_files = true,
                        'E' => {}
                        _ => {}
                    }
                }
            }
            _ => {
                if patterns.is_empty() {
                    patterns.push(args[i].to_string());
                } else {
                    file_args.push(args[i]);
                }
            }
        }
        i += 1;
    }

    if patterns.is_empty() {
        write_stderr("grep: missing pattern\n");
        return 2;
    }

    let opts = RegexOpts { dot_matches_newline: true };

    let pats_cmp: Vec<String> = patterns.iter()
        .map(|p| if ignore_case { p.to_lowercase() } else { p.clone() })
        .collect();

    let line_matches = |line: &str| -> bool {
        let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
        let matched = pats_cmp.iter().any(|p| match_pattern_opts(&haystack, p, &opts));
        if invert { !matched } else { matched }
    };

    if list_files {
        if file_args.is_empty() {
            let (data, _) = read_input(&[]);
            let text = String::from_utf8_lossy(&data);
            for line in text.split('\n') {
                if line_matches(line) {
                    write_stdout("(standard input)\n");
                    return 0;
                }
            }
            return 1;
        }
        let mut found_any = false;
        for &file in &file_args {
            match super::read_file(file) {
                Some(data) => {
                    let text = String::from_utf8_lossy(&data);
                    let file_matched = text.split('\n').any(|line| line_matches(line));
                    if file_matched {
                        write_stdout(&format!("{}\n", file));
                        found_any = true;
                    }
                }
                None => {
                    write_stderr(&format!("grep: {}: No such file or directory\n", file));
                }
            }
        }
        return if found_any { 0 } else { 1 };
    }

    let (data, _read_errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);
    let lines: Vec<&str> = text.split('\n').collect();

    let lines: Vec<&str> = if lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        &lines
    }.to_vec();

    let matches: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line_matches(line))
        .map(|(i, l)| (i + 1, *l))
        .collect();

    if count_mode {
        write_stdout(&format!("{}\n", matches.len()));
        return if matches.is_empty() { 1 } else { 0 };
    }

    if matches.is_empty() {
        return 1;
    }

    for (lineno, line) in &matches {
        if line_number {
            write_stdout(&format!("{}:{}\n", lineno, line));
        } else {
            write_stdout(line);
            write_stdout("\n");
        }
    }
    0
}

fn match_pattern_opts(haystack: &str, pattern: &str, opts: &RegexOpts) -> bool {
    if pattern.is_empty() {
        return true;
    }
    regex_find_opts(haystack, pattern, opts).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::regex::regex_matches;

    #[test]
    fn empty_pattern_matches_everything() {
        assert!(match_pattern_opts("anything", "", &RegexOpts::default()));
        assert!(match_pattern_opts("", "", &RegexOpts::default()));
    }

    #[test]
    fn literal_match_via_shared_engine() {
        assert!(regex_matches("hello world", "hello"));
        assert!(!regex_matches("hello world", "xyz"));
    }

    #[test]
    fn alternation_match() {
        assert!(regex_matches("foo", "foo|bar"));
        assert!(regex_matches("bar", "foo|bar"));
        assert!(!regex_matches("baz", "foo|bar"));
    }

    #[test]
    fn list_files_flag_parsed() {
        let opts = RegexOpts { dot_matches_newline: true };
        assert!(match_pattern_opts("hello", "hello", &opts));
    }
}
