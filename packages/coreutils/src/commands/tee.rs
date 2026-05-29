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
