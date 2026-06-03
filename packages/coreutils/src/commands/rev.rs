use super::{write_stdout, write_stderr, read_file};

pub fn run(args: &[&str]) -> u8 {
    if args.is_empty() {
        rev_stdin();
        return 0;
    }

    let mut errors = 0u8;
    for &path in args {
        match read_file(path) {
            Some(data) => {
                let text = String::from_utf8_lossy(&data);
                for line in text.lines() {
                    let reversed: String = line.chars().rev().collect();
                    write_stdout(&reversed);
                    write_stdout("\n");
                }
            }
            None => {
                write_stderr(&format!("rev: {}: No such file or directory\n", path));
                errors = 1;
            }
        }
    }
    errors
}

fn rev_stdin() {
    use std::io::{BufRead, BufReader};
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = buf.trim_end_matches('\n').trim_end_matches('\r');
                let reversed: String = line.chars().rev().collect();
                write_stdout(&reversed);
                write_stdout("\n");
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn reverse_simple_string() {
        let s = "hello";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "olleh");
    }

    #[test]
    fn reverse_palindrome() {
        let s = "racecar";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, s);
    }

    #[test]
    fn reverse_numbers() {
        let s = "12345";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "54321");
    }

    #[test]
    fn reverse_empty_string() {
        let s = "";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "");
    }

    #[test]
    fn reverse_single_char() {
        let s = "x";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "x");
    }

    #[test]
    fn reverse_with_spaces() {
        let s = "hello world";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "dlrow olleh");
    }
}
