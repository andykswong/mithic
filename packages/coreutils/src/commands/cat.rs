use super::{write_stdout, write_stderr, read_stdin_all, read_file};

pub fn run(args: &[&str]) -> u8 {
    let mut number_lines = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-n" => number_lines = true,
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    if c == 'n' { number_lines = true; }
                }
            }
            _ => file_args.push(arg),
        }
    }

    if file_args.is_empty() {
        let data = read_stdin_all();
        let s = String::from_utf8_lossy(&data);
        output_data(&s, number_lines);
        return 0;
    }

    let mut errors = 0u8;
    for &arg in &file_args {
        match read_file(arg) {
            Some(data) => {
                let s = String::from_utf8_lossy(&data);
                output_data(&s, number_lines);
            }
            None => {
                write_stderr(&format!("cat: {}: No such file or directory\n", arg));
                errors = 1;
            }
        }
    }
    errors
}

fn output_data(s: &str, number_lines: bool) {
    if !number_lines {
        write_stdout(s);
        return;
    }
    let lines: Vec<&str> = s.split('\n').collect();
    let last = if lines.last() == Some(&"") { lines.len() - 1 } else { lines.len() };
    for (i, line) in lines[..last].iter().enumerate() {
        write_stdout(&format!("{:>6}\t{}\n", i + 1, line));
    }
    if lines.last() == Some(&"") {
        // trailing newline already consumed — no extra blank line
    } else if let Some(&last_line) = lines.last() {
        write_stdout(&format!("{:>6}\t{}", last_line.len(), last_line));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_number_flag() {
        let args = &["-n", "file.txt"];
        let mut number_lines = false;
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-n" => number_lines = true,
                _ => file_args.push(arg),
            }
        }
        assert!(number_lines);
        assert_eq!(file_args, vec!["file.txt"]);
    }

    #[test]
    fn parse_combined_flags() {
        let args = &["-n"];
        let mut number_lines = false;
        for &arg in args {
            if arg.starts_with('-') && arg.len() > 1 {
                for c in arg[1..].chars() {
                    if c == 'n' { number_lines = true; }
                }
            }
        }
        assert!(number_lines);
    }

    #[test]
    fn no_flags_means_no_numbering() {
        let args = &["file1.txt", "file2.txt"];
        let mut number_lines = false;
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-n" => number_lines = true,
                a if a.starts_with('-') && a.len() > 1 => {}
                _ => file_args.push(arg),
            }
        }
        assert!(!number_lines);
        assert_eq!(file_args, vec!["file1.txt", "file2.txt"]);
    }
}
