use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut reverse = false;
    let mut numeric = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-r" => reverse = true,
            "-n" => numeric = true,
            "-rn" | "-nr" => { reverse = true; numeric = true; }
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'r' => reverse = true,
                        'n' => numeric = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let (data, errors) = read_input(&file_args);
    let mut lines: Vec<String> = lines_of(&data).iter().map(|s| s.to_string()).collect();

    if numeric {
        lines.sort_by(|a, b| {
            let na: f64 = a.parse().unwrap_or(0.0);
            let nb: f64 = b.parse().unwrap_or(0.0);
            na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
        });
    } else {
        lines.sort();
    }

    if reverse {
        lines.reverse();
    }

    let out = lines.join("\n");
    if !out.is_empty() {
        write_stdout(&out);
        write_stdout("\n");
    }
    errors
}
