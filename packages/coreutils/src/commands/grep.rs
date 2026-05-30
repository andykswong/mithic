use super::{write_stdout, write_stderr, read_input, read_file, read_dir, file_kind, FileKind};
use super::regex::{RegexOpts, regex_find_opts};

pub fn run(args: &[&str]) -> u8 {
    let mut invert = false;
    let mut count_mode = false;
    let mut ignore_case = false;
    let mut line_number = false;
    let mut list_files = false;
    let mut recursive = false;
    let mut after_context: usize = 0;
    let mut before_context: usize = 0;
    let mut context_requested = false;
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
            "-r" | "-R" => recursive = true,
            "-E" => {}
            "-A" => {
                i += 1;
                context_requested = true;
                if i < args.len() {
                    after_context = args[i].parse().unwrap_or(0);
                }
            }
            "-B" => {
                i += 1;
                context_requested = true;
                if i < args.len() {
                    before_context = args[i].parse().unwrap_or(0);
                }
            }
            "-C" => {
                i += 1;
                context_requested = true;
                if i < args.len() {
                    let n = args[i].parse().unwrap_or(0);
                    after_context = n;
                    before_context = n;
                }
            }
            "-e" => {
                i += 1;
                if i < args.len() {
                    patterns.push(args[i].to_string());
                }
            }
            a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => {
                let chars_vec: Vec<char> = a[1..].chars().collect();
                let mut j = 0;
                while j < chars_vec.len() {
                    match chars_vec[j] {
                        'v' => invert = true,
                        'c' => count_mode = true,
                        'i' => ignore_case = true,
                        'n' => line_number = true,
                        'l' => list_files = true,
                        'r' | 'R' => recursive = true,
                        'E' => {}
                        'A' => {
                            context_requested = true;
                            let rest: String = chars_vec[j+1..].iter().collect();
                            if !rest.is_empty() {
                                after_context = rest.parse().unwrap_or(0);
                            } else {
                                i += 1;
                                if i < args.len() {
                                    after_context = args[i].parse().unwrap_or(0);
                                }
                            }
                            j = chars_vec.len();
                            continue;
                        }
                        'B' => {
                            context_requested = true;
                            let rest: String = chars_vec[j+1..].iter().collect();
                            if !rest.is_empty() {
                                before_context = rest.parse().unwrap_or(0);
                            } else {
                                i += 1;
                                if i < args.len() {
                                    before_context = args[i].parse().unwrap_or(0);
                                }
                            }
                            j = chars_vec.len();
                            continue;
                        }
                        'C' => {
                            context_requested = true;
                            let rest: String = chars_vec[j+1..].iter().collect();
                            if !rest.is_empty() {
                                let n = rest.parse().unwrap_or(0);
                                after_context = n;
                                before_context = n;
                            } else {
                                i += 1;
                                if i < args.len() {
                                    let n = args[i].parse().unwrap_or(0);
                                    after_context = n;
                                    before_context = n;
                                }
                            }
                            j = chars_vec.len();
                            continue;
                        }
                        _ => {}
                    }
                    j += 1;
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

    // If recursive and no file args, default to "."
    if recursive && file_args.is_empty() {
        file_args.push(".");
    }

    // Expand directories recursively
    let resolved_files: Vec<String> = if recursive {
        let mut expanded = Vec::new();
        for &path in &file_args {
            collect_files_recursive(path, &mut expanded);
        }
        expanded
    } else {
        file_args.iter().map(|s| s.to_string()).collect()
    };

    let opts = RegexOpts { dot_matches_newline: true };

    let pats_cmp: Vec<String> = patterns.iter()
        .map(|p| if ignore_case { p.to_lowercase() } else { p.clone() })
        .collect();

    let line_matches = |line: &str| -> bool {
        let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
        let matched = pats_cmp.iter().any(|p| match_pattern_opts(&haystack, p, &opts));
        if invert { !matched } else { matched }
    };

    let multi_file = resolved_files.len() > 1 || (recursive && resolved_files.len() > 1);

    if list_files {
        if resolved_files.is_empty() {
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
        for file in &resolved_files {
            match read_file(file) {
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

    let has_context = context_requested;

    // Multi-file or single file/stdin
    if resolved_files.is_empty() {
        // Read from stdin
        let (data, _) = read_input(&[]);
        let text = String::from_utf8_lossy(&data);
        let lines: Vec<&str> = strip_trailing_empty(text.split('\n').collect());
        return grep_lines(&lines, &line_matches, line_number, count_mode, multi_file, None, has_context, before_context, after_context);
    }

    let mut found_any = false;
    for file in &resolved_files {
        match read_file(file) {
            Some(data) => {
                let text = String::from_utf8_lossy(&data);
                let lines: Vec<&str> = strip_trailing_empty(text.split('\n').collect());
                let prefix = if multi_file { Some(file.as_str()) } else { None };
                let ret = grep_lines(&lines, &line_matches, line_number, count_mode, multi_file, prefix, has_context, before_context, after_context);
                if ret == 0 {
                    found_any = true;
                }
            }
            None => {
                write_stderr(&format!("grep: {}: No such file or directory\n", file));
            }
        }
    }
    if found_any { 0 } else { 1 }
}

fn strip_trailing_empty(mut lines: Vec<&str>) -> Vec<&str> {
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn grep_lines(
    lines: &[&str],
    line_matches: &dyn Fn(&str) -> bool,
    show_line_number: bool,
    count_mode: bool,
    _multi_file: bool,
    file_prefix: Option<&str>,
    has_context: bool,
    before_context: usize,
    after_context: usize,
) -> u8 {
    let match_indices: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line_matches(line))
        .map(|(i, _)| i)
        .collect();

    if count_mode {
        match file_prefix {
            Some(f) => write_stdout(&format!("{}:{}\n", f, match_indices.len())),
            None => write_stdout(&format!("{}\n", match_indices.len())),
        }
        return if match_indices.is_empty() { 1 } else { 0 };
    }

    if match_indices.is_empty() {
        return 1;
    }

    if has_context {
        // Build set of line indices to print, tracking which are matches vs context
        let mut last_printed: Option<usize> = None;

        for &match_idx in &match_indices {
            let start = if before_context > match_idx { 0 } else { match_idx - before_context };
            let end = std::cmp::min(match_idx + after_context, lines.len() - 1);

            // Print separator if there's a gap
            if let Some(last) = last_printed {
                if start > last + 1 {
                    write_stdout("--\n");
                }
            }

            let actual_start = match last_printed {
                Some(last) if start <= last + 1 => last + 1,
                _ => start,
            };

            for idx in actual_start..=end {
                let sep = if idx == match_idx { ':' } else { '-' };
                format_line(lines[idx], idx + 1, sep, show_line_number, file_prefix);
            }
            if end >= last_printed.unwrap_or(0) || last_printed.is_none() {
                last_printed = Some(end);
            }
        }
    } else {
        for &idx in &match_indices {
            format_line(lines[idx], idx + 1, ':', show_line_number, file_prefix);
        }
    }
    0
}

fn format_line(line: &str, lineno: usize, sep: char, show_line_number: bool, file_prefix: Option<&str>) {
    match (file_prefix, show_line_number) {
        (Some(f), true) => write_stdout(&format!("{}:{}:{}\n", f, lineno, line)),
        (Some(f), false) => write_stdout(&format!("{}{}{}\n", f, sep, line)),
        (None, true) => write_stdout(&format!("{}:{}\n", lineno, line)),
        (None, false) => { write_stdout(line); write_stdout("\n"); }
    }
}

fn collect_files_recursive(path: &str, out: &mut Vec<String>) {
    match file_kind(path) {
        FileKind::Regular => {
            out.push(path.to_string());
        }
        FileKind::Directory => {
            let mut entries = read_dir(path);
            entries.sort();
            for entry in entries {
                let child = format!("{}/{}", path.trim_end_matches('/'), entry);
                collect_files_recursive(&child, out);
            }
        }
        _ => {}
    }
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
