use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let mut count_mode = false;
    let mut dup_only = false;
    let mut unique_only = false;
    let mut ignore_case = false;
    let mut file_args: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-c" => count_mode = true,
            "-d" => dup_only = true,
            "-u" => unique_only = true,
            "-i" => ignore_case = true,
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'c' => count_mode = true,
                        'd' => dup_only = true,
                        'u' => unique_only = true,
                        'i' => ignore_case = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg),
        }
    }

    let (data, errors) = read_input(&file_args);
    let lines = lines_of(&data);

    struct Group<'a> {
        line: &'a str,
        count: usize,
    }

    let mut groups: Vec<Group> = Vec::new();
    for &line in &lines {
        let key = if ignore_case { line.to_lowercase() } else { line.to_string() };
        if let Some(last) = groups.last_mut() {
            let last_key = if ignore_case { last.line.to_lowercase() } else { last.line.to_string() };
            if last_key == key {
                last.count += 1;
                continue;
            }
        }
        groups.push(Group { line, count: 1 });
    }

    for g in &groups {
        if dup_only && g.count < 2 { continue; }
        if unique_only && g.count > 1 { continue; }
        if count_mode {
            write_stdout(&format!("{:>7} {}\n", g.count, g.line));
        } else {
            write_stdout(g.line);
            write_stdout("\n");
        }
    }
    errors
}
