use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let file_args: Vec<&str> = args.iter().copied().filter(|a| !a.starts_with('-')).collect();
    let (data, errors) = read_input(&file_args);
    let lines = lines_of(&data);

    let mut prev: Option<&str> = None;
    let mut result: Vec<&str> = Vec::new();
    for &line in &lines {
        if prev != Some(line) {
            result.push(line);
            prev = Some(line);
        }
    }

    let out = result.join("\n");
    if !out.is_empty() {
        write_stdout(&out);
        write_stdout("\n");
    }
    errors
}
