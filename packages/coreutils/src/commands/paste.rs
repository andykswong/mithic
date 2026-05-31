use super::{write_stdout, write_stderr, read_stdin_all, read_file, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut delim_owned: Option<String> = None;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" | "--delimiter" => {
                i += 1;
                if i < args.len() {
                    delim_owned = Some(args[i].to_string());
                }
            }
            a if a.starts_with("-d") && a.len() > 2 => {
                delim_owned = Some(a[2..].to_string());
            }
            a if a.starts_with('-') && a.len() > 1 && a != "-" => {
                // Unknown flag — ignore
            }
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let delimiter = delim_owned.as_deref().unwrap_or("\t");

    if file_args.is_empty() {
        write_stderr("paste: missing operand\n");
        return 1;
    }

    // Read stdin once if any argument is "-"
    let stdin_data = if file_args.contains(&"-") {
        Some(read_stdin_all())
    } else {
        None
    };
    let stdin_lines: Vec<&str> = stdin_data.as_deref()
        .map(|d| lines_of(d))
        .unwrap_or_default();

    // Each "-" gets its own cursor into stdin lines, cycling through them serially.
    // When multiple "-" appear, they share the same stdin stream sequentially.
    // We pre-split stdin lines across the "-" slots.
    let dash_count = file_args.iter().filter(|&&a| a == "-").count();

    // Build per-column line arrays
    let mut all_lines: Vec<Vec<String>> = Vec::new();

    if dash_count > 0 {
        // Distribute stdin lines across dash slots: lines go to slots round-robin
        // Actually GNU paste distributes: first line to first -, second to second -, etc.
        // cycling through dashes, then next round.
        let mut dash_buckets: Vec<Vec<String>> = vec![Vec::new(); dash_count];
        for (idx, line) in stdin_lines.iter().enumerate() {
            dash_buckets[idx % dash_count].push(line.to_string());
        }
        let mut dash_iter = dash_buckets.into_iter();

        for &path in &file_args {
            if path == "-" {
                all_lines.push(dash_iter.next().unwrap_or_default());
            } else {
                match read_file(path) {
                    Some(d) => {
                        let lines: Vec<String> = lines_of(&d).iter().map(|s| s.to_string()).collect();
                        all_lines.push(lines);
                    }
                    None => {
                        write_stderr(&format!("paste: {}: No such file or directory\n", path));
                        return 1;
                    }
                }
            }
        }
    } else {
        for &path in &file_args {
            let data = match read_file(path) {
                Some(d) => d,
                None => {
                    write_stderr(&format!("paste: {}: No such file or directory\n", path));
                    return 1;
                }
            };
            let lines: Vec<String> = lines_of(&data).iter().map(|s| s.to_string()).collect();
            all_lines.push(lines);
        }
    }

    let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);

    for row in 0..max_lines {
        let mut parts: Vec<&str> = Vec::new();
        for file_lines in &all_lines {
            parts.push(if row < file_lines.len() { &file_lines[row] } else { "" });
        }
        write_stdout(&parts.join(delimiter));
        write_stdout("\n");
    }
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn merge_columns_equal_length() {
        let col1 = vec!["a", "b", "c"];
        let col2 = vec!["x", "y", "z"];
        let all_lines: Vec<&[&str]> = vec![&col1, &col2];
        let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);
        let mut output = Vec::new();
        for row in 0..max_lines {
            let parts: Vec<&str> = all_lines.iter()
                .map(|col| if row < col.len() { col[row] } else { "" })
                .collect();
            output.push(parts.join("\t"));
        }
        assert_eq!(output, vec!["a\tx", "b\ty", "c\tz"]);
    }

    #[test]
    fn merge_columns_unequal_length() {
        let col1 = vec!["a", "b"];
        let col2 = vec!["x", "y", "z"];
        let all_lines: Vec<&[&str]> = vec![&col1, &col2];
        let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);
        let mut output = Vec::new();
        for row in 0..max_lines {
            let parts: Vec<&str> = all_lines.iter()
                .map(|col| if row < col.len() { col[row] } else { "" })
                .collect();
            output.push(parts.join("\t"));
        }
        assert_eq!(output, vec!["a\tx", "b\ty", "\tz"]);
    }

    #[test]
    fn merge_with_custom_delimiter() {
        let col1 = vec!["1", "2"];
        let col2 = vec!["a", "b"];
        let delimiter = ",";
        let all_lines: Vec<&[&str]> = vec![&col1, &col2];
        let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);
        let mut output = Vec::new();
        for row in 0..max_lines {
            let parts: Vec<&str> = all_lines.iter()
                .map(|col| if row < col.len() { col[row] } else { "" })
                .collect();
            output.push(parts.join(delimiter));
        }
        assert_eq!(output, vec!["1,a", "2,b"]);
    }

    #[test]
    fn merge_three_columns() {
        let col1 = vec!["a"];
        let col2 = vec!["b"];
        let col3 = vec!["c"];
        let all_lines: Vec<&[&str]> = vec![&col1, &col2, &col3];
        let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);
        let mut output = Vec::new();
        for row in 0..max_lines {
            let parts: Vec<&str> = all_lines.iter()
                .map(|col| if row < col.len() { col[row] } else { "" })
                .collect();
            output.push(parts.join("\t"));
        }
        assert_eq!(output, vec!["a\tb\tc"]);
    }
}
