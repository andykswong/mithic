use super::{write_stdout, file_kind, read_dir, FileKind};

pub fn run(args: &[&str]) -> u8 {
    let mut start_path = ".";
    let mut name_pattern: Option<&str> = None;
    let mut type_filter: Option<char> = None;

    let mut i = 0;
    // First non-flag arg before any predicates is the search path
    if i < args.len() && !args[i].starts_with('-') {
        start_path = args[i];
        i += 1;
    }

    while i < args.len() {
        match args[i] {
            "-name" => {
                i += 1;
                if i < args.len() {
                    name_pattern = Some(args[i]);
                }
            }
            "-type" => {
                i += 1;
                if i < args.len() {
                    type_filter = args[i].chars().next();
                }
            }
            _ => {}
        }
        i += 1;
    }

    find_recursive(start_path, start_path, name_pattern, type_filter);
    0
}

fn matches_glob(name: &str, pattern: &str) -> bool {
    // Simple glob: support * wildcard
    if pattern == "*" {
        return true;
    }
    if !pattern.contains('*') {
        return name == pattern;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    let mut pos = 0usize;
    let name_bytes = name.as_bytes();
    for (idx, part) in parts.iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let part_bytes = part.as_bytes();
        if idx == 0 {
            // Must match at start
            if !name_bytes.starts_with(part_bytes) {
                return false;
            }
            pos = part.len();
        } else if idx == parts.len() - 1 {
            // Must match at end
            if pos > name_bytes.len() {
                return false;
            }
            return name_bytes[pos..].ends_with(part_bytes);
        } else {
            // Find anywhere from pos
            match name[pos..].find(part) {
                Some(found) => pos += found + part.len(),
                None => return false,
            }
        }
    }
    true
}

fn find_recursive(base: &str, path: &str, name_pattern: Option<&str>, type_filter: Option<char>) {
    let kind = file_kind(path);
    let display = if path == "." { ".".to_string() } else { path.to_string() };

    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let type_ok = match type_filter {
        Some('f') => matches!(kind, FileKind::Regular),
        Some('d') => matches!(kind, FileKind::Directory),
        _ => true,
    };

    let name_ok = match name_pattern {
        Some(pat) => matches_glob(&name, pat),
        None => true,
    };

    // Print the root path itself if it matches (but skip "." name check — use actual path)
    let effective_name = if path == base && path == "." { "." } else { &name };
    let name_ok_for_print = match name_pattern {
        Some(pat) => matches_glob(effective_name, pat),
        None => true,
    };

    if type_ok && name_ok_for_print {
        write_stdout(&display);
        write_stdout("\n");
    }

    if matches!(kind, FileKind::Directory) {
        let mut entries = read_dir(path);
        entries.sort();
        for entry in entries {
            let child = format!("{}/{}", path.trim_end_matches('/'), entry);
            find_recursive(base, &child, name_pattern, type_filter);
        }
    }

    let _ = name_ok; // suppress unused warning (name_ok_for_print used instead)
}
