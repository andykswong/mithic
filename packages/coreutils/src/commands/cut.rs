use super::{write_stdout, read_input};

pub fn run(args: &[&str]) -> u8 {
    let mut delim = '\t';
    let mut fields: Vec<usize> = Vec::new();
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-d" => {
                i += 1;
                if i < args.len() {
                    delim = args[i].chars().next().unwrap_or('\t');
                }
            }
            "-f" => {
                i += 1;
                if i < args.len() {
                    fields = parse_field_list(args[i]);
                }
            }
            a if a.starts_with("-d") => {
                delim = a[2..].chars().next().unwrap_or('\t');
            }
            a if a.starts_with("-f") => {
                fields = parse_field_list(&a[2..]);
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i]),
        }
        i += 1;
    }

    let (data, errors) = read_input(&file_args);
    let text = String::from_utf8_lossy(&data);

    for line in text.lines() {
        let parts: Vec<&str> = line.split(delim).collect();
        let selected: Vec<&str> = fields.iter()
            .filter_map(|&f| if f > 0 { parts.get(f - 1).copied() } else { None })
            .collect();
        if fields.is_empty() {
            write_stdout(line);
        } else {
            write_stdout(&selected.join(&delim.to_string()));
        }
        write_stdout("\n");
    }
    errors
}

fn parse_field_list(s: &str) -> Vec<usize> {
    let mut fields = Vec::new();
    for part in s.split(',') {
        if let Some((a, b)) = part.split_once('-') {
            let start: usize = a.parse().unwrap_or(1);
            let end: usize = b.parse().unwrap_or(start);
            for f in start..=end {
                fields.push(f);
            }
        } else if let Ok(n) = part.parse::<usize>() {
            fields.push(n);
        }
    }
    fields
}
