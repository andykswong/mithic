use super::{write_stdout_bytes, write_file, append_file};

pub fn run(args: &[&str]) -> u8 {
    use std::io::Read;

    let mut append_mode = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-a" => append_mode = true,
            a if a.starts_with('-') => {}
            _ => file_args.push(arg),
        }
    }

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut buf = [0u8; 4096];
    let mut first_write = vec![true; file_args.len()];

    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                write_stdout_bytes(chunk);
                for (i, &path) in file_args.iter().enumerate() {
                    if first_write[i] && !append_mode {
                        write_file(path, chunk);
                        first_write[i] = false;
                    } else {
                        append_file(path, chunk);
                    }
                }
            }
            Err(_) => break,
        }
    }
    0
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_append_flag() {
        let args = &["-a", "output.txt"];
        let mut append = false;
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-a" => append = true,
                a if a.starts_with('-') => {}
                _ => file_args.push(arg),
            }
        }
        assert!(append);
        assert_eq!(file_args, vec!["output.txt"]);
    }

    #[test]
    fn parse_multiple_files() {
        let args = &["file1.txt", "file2.txt"];
        let mut file_args: Vec<&str> = Vec::new();
        for &arg in args {
            match arg {
                "-a" => {}
                a if a.starts_with('-') => {}
                _ => file_args.push(arg),
            }
        }
        assert_eq!(file_args, vec!["file1.txt", "file2.txt"]);
    }
}
