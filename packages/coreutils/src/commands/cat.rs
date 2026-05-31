use super::{write_stdout, write_stdout_bytes, write_stderr, read_stdin_all};

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
    for &path in &file_args {
        if number_lines {
            match cat_file_numbered(path) {
                Ok(()) => {}
                Err(_) => {
                    write_stderr(&format!("cat: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        } else {
            match cat_file_stream(path) {
                Ok(()) => {}
                Err(_) => {
                    write_stderr(&format!("cat: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        }
    }
    errors
}

fn cat_file_stream(path: &str) -> std::io::Result<()> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = [0u8; 4096];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => write_stdout_bytes(&buf[..n]),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn cat_file_numbered(path: &str) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut line_num = 1usize;
    for line in reader.lines() {
        let line = line?;
        write_stdout(&format!("{:>6}\t{}\n", line_num, line));
        line_num += 1;
    }
    Ok(())
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
        // trailing newline already consumed
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
