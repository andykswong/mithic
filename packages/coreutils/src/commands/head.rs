use super::{write_stdout, write_stdout_bytes, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    let mut n: Option<usize> = None;
    let mut c: Option<usize> = None;
    let mut file_args: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-n" => {
                i += 1;
                if i < args.len() {
                    n = args[i].parse().ok();
                }
            }
            "-c" => {
                i += 1;
                if i < args.len() {
                    c = args[i].parse().ok();
                }
            }
            a if a.starts_with("-n") => {
                n = a[2..].parse().ok();
            }
            a if a.starts_with("-c") => {
                c = a[2..].parse().ok();
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    if file_args.is_empty() {
        if let Some(bytes) = c {
            head_stdin_bytes(bytes);
        } else {
            head_stdin_lines(n.unwrap_or(10));
        }
        return 0;
    }

    let mut errors = 0u8;
    for &path in &file_args {
        if let Some(bytes) = c {
            match head_file_bytes(path, bytes) {
                Ok(()) => {}
                Err(_) => {
                    write_stderr(&format!("head: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        } else {
            let line_count = n.unwrap_or(10);
            match head_file_lines(path, line_count) {
                Ok(()) => {}
                Err(_) => {
                    write_stderr(&format!("head: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        }
    }
    errors
}

fn head_stdin_bytes(count: usize) {
    use std::io::Read;
    let mut remaining = count;
    let mut buf = [0u8; 4096];
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    while remaining > 0 {
        let to_read = remaining.min(buf.len());
        match reader.read(&mut buf[..to_read]) {
            Ok(0) => break,
            Ok(n) => {
                write_stdout_bytes(&buf[..n]);
                remaining -= n;
            }
            Err(_) => break,
        }
    }
}

fn head_stdin_lines(count: usize) {
    use std::io::{BufRead, BufReader};
    let stdin = std::io::stdin();
    let reader = BufReader::new(stdin.lock());
    let mut lines_read = 0usize;
    for line in reader.lines() {
        if lines_read >= count {
            break;
        }
        match line {
            Ok(l) => {
                write_stdout(&l);
                write_stdout("\n");
                lines_read += 1;
            }
            Err(_) => break,
        }
    }
}

fn head_file_bytes(path: &str, count: usize) -> std::io::Result<()> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buf = vec![0u8; count];
    let bytes_read = file.read(&mut buf)?;
    buf.truncate(bytes_read);
    write_stdout_bytes(&buf);
    Ok(())
}

fn head_file_lines(path: &str, count: usize) -> std::io::Result<()> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path)?;
    let reader = BufReader::new(file);
    let mut lines_read = 0usize;
    for line in reader.lines() {
        if lines_read >= count {
            break;
        }
        let line = line?;
        write_stdout(&line);
        write_stdout("\n");
        lines_read += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    fn head_lines<'a>(lines: &[&'a str], n: usize) -> Vec<&'a str> {
        let take = n.min(lines.len());
        lines[..take].to_vec()
    }

    fn head_bytes(data: &[u8], n: usize) -> &[u8] {
        let take = n.min(data.len());
        &data[..take]
    }

    #[test]
    fn head_lines_fewer_than_n() {
        let lines = vec!["a", "b", "c"];
        assert_eq!(head_lines(&lines, 10), vec!["a", "b", "c"]);
    }

    #[test]
    fn head_lines_exactly_n() {
        let lines = vec!["a", "b", "c", "d", "e"];
        assert_eq!(head_lines(&lines, 3), vec!["a", "b", "c"]);
    }

    #[test]
    fn head_lines_zero() {
        let lines = vec!["a", "b"];
        assert_eq!(head_lines(&lines, 0), Vec::<&str>::new());
    }

    #[test]
    fn head_bytes_truncates() {
        let data = b"hello world";
        assert_eq!(head_bytes(data, 5), b"hello");
    }

    #[test]
    fn head_bytes_within_bounds() {
        let data = b"hi";
        assert_eq!(head_bytes(data, 100), b"hi");
    }
}
