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

#[cfg(test)]
mod tests {
    #[test]
    fn dedup_adjacent_duplicates() {
        let lines = vec!["a", "a", "b", "b", "a"];
        let mut groups: Vec<(&str, usize)> = Vec::new();
        for &line in &lines {
            if let Some(last) = groups.last_mut() {
                if last.0 == line {
                    last.1 += 1;
                    continue;
                }
            }
            groups.push((line, 1));
        }
        assert_eq!(groups, vec![("a", 2), ("b", 2), ("a", 1)]);
    }

    #[test]
    fn dedup_case_insensitive() {
        let lines = vec!["Apple", "apple", "Banana"];
        let mut groups: Vec<(&str, usize)> = Vec::new();
        for &line in &lines {
            let key = line.to_lowercase();
            if let Some(last) = groups.last_mut() {
                if last.0.to_lowercase() == key {
                    last.1 += 1;
                    continue;
                }
            }
            groups.push((line, 1));
        }
        assert_eq!(groups, vec![("Apple", 2), ("Banana", 1)]);
    }

    #[test]
    fn dedup_all_same() {
        let lines = vec!["x", "x", "x"];
        let mut groups: Vec<(&str, usize)> = Vec::new();
        for &line in &lines {
            if let Some(last) = groups.last_mut() {
                if last.0 == line {
                    last.1 += 1;
                    continue;
                }
            }
            groups.push((line, 1));
        }
        assert_eq!(groups, vec![("x", 3)]);
    }

    #[test]
    fn dedup_empty_input() {
        let lines: Vec<&str> = Vec::new();
        let mut groups: Vec<(&str, usize)> = Vec::new();
        for &line in &lines {
            if let Some(last) = groups.last_mut() {
                if last.0 == line {
                    last.1 += 1;
                    continue;
                }
            }
            groups.push((line, 1));
        }
        assert_eq!(groups, Vec::<(&str, usize)>::new());
    }

    #[test]
    fn dup_only_filter() {
        let groups = vec![("a", 2usize), ("b", 1), ("c", 3)];
        let filtered: Vec<_> = groups.iter().filter(|g| g.1 >= 2).collect();
        assert_eq!(filtered.len(), 2);
        assert_eq!(filtered[0].0, "a");
        assert_eq!(filtered[1].0, "c");
    }

    #[test]
    fn unique_only_filter() {
        let groups = vec![("a", 2usize), ("b", 1), ("c", 3)];
        let filtered: Vec<_> = groups.iter().filter(|g| g.1 == 1).collect();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].0, "b");
    }
}
