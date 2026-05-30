use super::{write_stdout, read_stdin_all, dispatch};

pub fn run(args: &[&str]) -> u8 {
    let mut max_args: Option<usize> = None;
    let mut null_delim = false;
    let mut replace_str: Option<String> = None;
    let mut cmd_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-0" => null_delim = true,
            "-n" => {
                i += 1;
                if i < args.len() {
                    max_args = args[i].parse().ok();
                }
            }
            "-I" => {
                i += 1;
                if i < args.len() {
                    replace_str = Some(args[i].to_string());
                }
            }
            a if a.starts_with("-I") && a.len() > 2 => {
                replace_str = Some(a[2..].to_string());
            }
            a if a.starts_with("-n") && a.len() > 2 => {
                max_args = a[2..].parse().ok();
            }
            _ => cmd_args.push(args[i]),
        }
        i += 1;
    }

    let cmd = cmd_args.first().copied().unwrap_or("echo");
    let cmd_extra: &[&str] = if cmd_args.is_empty() { &[] } else { &cmd_args[1..] };

    let data = read_stdin_all();

    let items: Vec<String> = if null_delim {
        data.split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect()
    } else {
        String::from_utf8_lossy(&data)
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    };

    if items.is_empty() {
        return 0;
    }

    if let Some(repl) = &replace_str {
        let mut exit = 0u8;
        for item in &items {
            let substituted_extra: Vec<String> = cmd_extra.iter()
                .map(|a| a.replace(repl.as_str(), item))
                .collect();
            let substituted_refs: Vec<&str> = substituted_extra.iter().map(|s| s.as_str()).collect();

            if cmd == "echo" {
                write_stdout(&substituted_refs.join(" "));
                write_stdout("\n");
            } else {
                let e = dispatch(cmd, &substituted_refs);
                if e != 0 { exit = e; }
            }
        }
        return exit;
    }

    let chunk_size = max_args.unwrap_or(items.len()).max(1);
    let mut exit = 0u8;

    for chunk in items.chunks(chunk_size) {
        let mut all_args: Vec<&str> = cmd_extra.to_vec();
        let chunk_strs: Vec<&str> = chunk.iter().map(|s| s.as_str()).collect();
        all_args.extend(chunk_strs);

        if cmd == "echo" {
            write_stdout(&all_args.join(" "));
            write_stdout("\n");
        } else {
            let e = dispatch(cmd, &all_args);
            if e != 0 { exit = e; }
        }
    }
    exit
}

#[cfg(test)]
mod tests {
    fn split_whitespace_items(data: &[u8]) -> Vec<String> {
        String::from_utf8_lossy(data)
            .split_whitespace()
            .map(|s| s.to_string())
            .collect()
    }

    fn split_null_items(data: &[u8]) -> Vec<String> {
        data.split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect()
    }

    #[test]
    fn split_whitespace_basic() {
        let items = split_whitespace_items(b"a b c");
        assert_eq!(items, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_whitespace_newlines() {
        let items = split_whitespace_items(b"a\nb\nc\n");
        assert_eq!(items, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_whitespace_extra_spaces() {
        let items = split_whitespace_items(b"  a   b  ");
        assert_eq!(items, vec!["a", "b"]);
    }

    #[test]
    fn split_whitespace_empty() {
        let items = split_whitespace_items(b"");
        assert!(items.is_empty());
    }

    #[test]
    fn split_null_basic() {
        let data = b"a\0b\0c\0";
        let items = split_null_items(data);
        assert_eq!(items, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_null_no_trailing_null() {
        let data = b"x\0y";
        let items = split_null_items(data);
        assert_eq!(items, vec!["x", "y"]);
    }

    #[test]
    fn split_null_skips_empty_segments() {
        let data = b"\0a\0\0b\0";
        let items = split_null_items(data);
        assert_eq!(items, vec!["a", "b"]);
    }

    #[test]
    fn chunk_size_respected() {
        let items: Vec<String> = vec!["a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let chunks: Vec<Vec<String>> = items.chunks(2).map(|c| c.to_vec()).collect();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0], vec!["a", "b"]);
        assert_eq!(chunks[1], vec!["c", "d"]);
    }
}
