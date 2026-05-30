use super::{write_stdout, read_input, lines_of};

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

    let (data, errors) = read_input(&file_args);

    if let Some(bytes) = c {
        let skip = if data.len() > bytes { data.len() - bytes } else { 0 };
        write_stdout(&String::from_utf8_lossy(&data[skip..]));
    } else {
        let n = n.unwrap_or(10);
        let lines = lines_of(&data);
        let skip = if lines.len() > n { lines.len() - n } else { 0 };
        let out = lines[skip..].join("\n");
        if !out.is_empty() {
            write_stdout(&out);
            write_stdout("\n");
        }
    }
    errors
}

#[cfg(test)]
mod tests {
    fn tail_lines<'a>(lines: &[&'a str], n: usize) -> Vec<&'a str> {
        let skip = if lines.len() > n { lines.len() - n } else { 0 };
        lines[skip..].to_vec()
    }

    fn tail_bytes(data: &[u8], n: usize) -> &[u8] {
        let skip = if data.len() > n { data.len() - n } else { 0 };
        &data[skip..]
    }

    #[test]
    fn tail_lines_fewer_than_n() {
        let lines = vec!["a", "b", "c"];
        assert_eq!(tail_lines(&lines, 10), vec!["a", "b", "c"]);
    }

    #[test]
    fn tail_lines_last_n() {
        let lines = vec!["a", "b", "c", "d", "e"];
        assert_eq!(tail_lines(&lines, 3), vec!["c", "d", "e"]);
    }

    #[test]
    fn tail_lines_zero() {
        let lines = vec!["a", "b"];
        assert_eq!(tail_lines(&lines, 0), Vec::<&str>::new());
    }

    #[test]
    fn tail_bytes_last_n() {
        let data = b"hello world";
        assert_eq!(tail_bytes(data, 5), b"world");
    }

    #[test]
    fn tail_bytes_within_bounds() {
        let data = b"hi";
        assert_eq!(tail_bytes(data, 100), b"hi");
    }
}
