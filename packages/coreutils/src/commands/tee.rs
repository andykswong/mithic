use super::{write_stdout, read_stdin_all, write_file, append_file};

pub fn run(args: &[&str]) -> u8 {
    let mut append = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-a" => append = true,
            a if a.starts_with('-') => {}
            _ => file_args.push(arg),
        }
    }

    let data = read_stdin_all();
    let s = String::from_utf8_lossy(&data);
    write_stdout(&s);

    for &arg in &file_args {
        if append {
            append_file(arg, &data);
        } else {
            write_file(arg, &data);
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
