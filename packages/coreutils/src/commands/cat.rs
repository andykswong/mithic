use super::{write_stdout, write_stderr, read_stdin_all, read_file};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();

    if file_args.is_empty() {
        let data = read_stdin_all();
        let s = String::from_utf8_lossy(&data);
        write_stdout(&s);
        return 0;
    }

    let mut errors = 0u8;
    for &arg in &file_args {
        match read_file(arg) {
            Some(data) => {
                let s = String::from_utf8_lossy(&data);
                write_stdout(&s);
            }
            None => {
                write_stderr(&format!("cat: {}: No such file or directory\n", arg));
                errors = 1;
            }
        }
    }
    errors
}
