use super::{write_stdout, write_stderr, read_input};

pub fn run(args: &[&str]) -> u8 {
    let mut invert = false;
    let mut count_mode = false;
    let mut ignore_case = false;
    let mut line_number = false;
    let mut pattern: Option<String> = None;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-v" => invert = true,
            "-c" => count_mode = true,
            "-i" => ignore_case = true,
            "-n" => line_number = true,
            "-e" => {
                i += 1;
                if i < args.len() && pattern.is_none() {
                    pattern = Some(args[i].to_string());
                }
            }
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'v' => invert = true,
                        'c' => count_mode = true,
                        'i' => ignore_case = true,
                        'n' => line_number = true,
                        _ => {}
                    }
                }
            }
            _ => {
                if pattern.is_none() {
                    pattern = Some(args[i].to_string());
                } else {
                    file_args.push(args[i]);
                }
            }
        }
        i += 1;
    }

    let pat = match pattern {
        Some(p) => p,
        None => {
            write_stderr("grep: missing pattern\n");
            return 2;
        }
    };

    let (data, _read_errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);
    let lines: Vec<&str> = text.split('\n').collect();

    let lines: Vec<&str> = if lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        &lines
    }.to_vec();

    let pat_cmp = if ignore_case { pat.to_lowercase() } else { pat.clone() };

    let matches: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
            let matched = match_pattern(&haystack, &pat_cmp);
            if invert { !matched } else { matched }
        })
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

fn match_pattern(haystack: &str, pattern: &str) -> bool {
    if pattern.starts_with('^') && pattern.ends_with('$') && pattern.len() >= 2 {
        let inner = &pattern[1..pattern.len() - 1];
        haystack == inner
    } else if pattern.starts_with('^') {
        haystack.starts_with(&pattern[1..])
    } else if pattern.ends_with('$') {
        haystack.ends_with(&pattern[..pattern.len() - 1])
    } else {
        haystack.contains(pattern)
    }
}
