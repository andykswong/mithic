use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut n: usize = 10;
    let mut file_args: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-n" => {
                i += 1;
                if i < args.len() {
                    n = args[i].parse().unwrap_or(10);
                }
            }
            a if a.starts_with("-n") => {
                n = a[2..].parse().unwrap_or(10);
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let (data, errors) = read_input(&file_args);
    let lines = lines_of(&data);
    let take = n.min(lines.len());
    let out = lines[..take].join("\n");
    if !out.is_empty() {
        write_stdout(&out);
        write_stdout("\n");
    }
    errors
}
