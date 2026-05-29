use super::{write_stdout, write_stderr, read_stdin_all, read_file, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut delim_owned: Option<String> = None;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" | "--delimiter" => {
                i += 1;
                if i < args.len() {
                    delim_owned = Some(args[i].to_string());
                }
            }
            a if a.starts_with("-d") && a.len() > 2 => {
                delim_owned = Some(a[2..].to_string());
            }
            a if a.starts_with('-') && a.len() > 1 => {
                // Unknown flag — ignore
            }
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let delimiter = delim_owned.as_deref().unwrap_or("\t");

    if file_args.is_empty() {
        write_stderr("paste: missing operand\n");
        return 1;
    }

    // Read all files into line arrays
    let mut all_lines: Vec<Vec<String>> = Vec::new();
    for &path in &file_args {
        let data = if path == "-" {
            read_stdin_all()
        } else {
            match read_file(path) {
                Some(d) => d,
                None => {
                    write_stderr(&format!("paste: {}: No such file or directory\n", path));
                    return 1;
                }
            }
        };
        let lines: Vec<String> = lines_of(&data).iter().map(|s| s.to_string()).collect();
        all_lines.push(lines);
    }

    let max_lines = all_lines.iter().map(|v| v.len()).max().unwrap_or(0);

    for row in 0..max_lines {
        let mut parts: Vec<&str> = Vec::new();
        for file_lines in &all_lines {
            parts.push(if row < file_lines.len() { &file_lines[row] } else { "" });
        }
        write_stdout(&parts.join(delimiter));
        write_stdout("\n");
    }
    0
}
