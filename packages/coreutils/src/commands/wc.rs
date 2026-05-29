use super::{write_stdout, read_input};

pub fn run(args: &[&str]) -> u8 {
    let mut count_lines = false;
    let mut count_words = false;
    let mut count_bytes = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-l" => count_lines = true,
            "-w" => count_words = true,
            "-c" | "-m" => count_bytes = true,
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'l' => count_lines = true,
                        'w' => count_words = true,
                        'c' | 'm' => count_bytes = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let show_all = !count_lines && !count_words && !count_bytes;

    let (data, errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);

    let lines = text.lines().count();
    let words = text.split_whitespace().count();
    let bytes = data.len();

    let mut parts: Vec<String> = Vec::new();
    if show_all || count_lines { parts.push(lines.to_string()); }
    if show_all || count_words { parts.push(words.to_string()); }
    if show_all || count_bytes { parts.push(bytes.to_string()); }

    write_stdout(&parts.join(" "));
    write_stdout("\n");
    errors
}
