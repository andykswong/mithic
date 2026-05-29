use super::{write_stdout, write_stderr, read_stdin_all, read_file, write_file};

pub fn run(args: &[&str]) -> u8 {
    let mut expressions: Vec<String> = Vec::new();
    let mut in_place = false;
    let mut file_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-i" | "--in-place" => in_place = true,
            "-e" | "--expression" => {
                i += 1;
                if i < args.len() {
                    expressions.push(args[i].to_string());
                }
            }
            a if a.starts_with('-') && a.len() > 1 => {
                // Handle combined flags like -i or unknown flags
                let rest = &a[1..];
                for c in rest.chars() {
                    match c {
                        'i' => in_place = true,
                        'e' => {} // handled separately
                        _ => {}
                    }
                }
            }
            _ => {
                if expressions.is_empty() && file_args.is_empty() {
                    // First non-flag arg is the expression when no -e given
                    expressions.push(args[i].to_string());
                } else {
                    file_args.push(args[i]);
                }
            }
        }
        i += 1;
    }

    if expressions.is_empty() {
        write_stderr("sed: no script command\n");
        return 1;
    }

    let parsed: Vec<SedExpr> = expressions.iter().filter_map(|e| parse_expr(e)).collect();
    if parsed.len() != expressions.len() {
        write_stderr("sed: invalid expression\n");
        return 1;
    }

    if file_args.is_empty() {
        let data = read_stdin_all();
        let text = String::from_utf8_lossy(&data);
        let result = apply_expressions(&text, &parsed);
        write_stdout(&result);
    } else {
        let mut errors = 0u8;
        for &path in &file_args {
            match read_file(path) {
                Some(data) => {
                    let text = String::from_utf8_lossy(&data);
                    let result = apply_expressions(&text, &parsed);
                    if in_place {
                        if !write_file(path, result.as_bytes()) {
                            write_stderr(&format!("sed: cannot write '{}'\n", path));
                            errors = 1;
                        }
                    } else {
                        write_stdout(&result);
                    }
                }
                None => {
                    write_stderr(&format!("sed: {}: No such file or directory\n", path));
                    errors = 1;
                }
            }
        }
        return errors;
    }
    0
}

struct SedExpr {
    pattern: String,
    replacement: String,
    global: bool,
}

fn parse_expr(expr: &str) -> Option<SedExpr> {
    // Expect s/pattern/replacement/[g]
    if !expr.starts_with('s') {
        return None;
    }
    let rest = &expr[1..];
    if rest.is_empty() {
        return None;
    }
    let delim = rest.chars().next()?;
    let parts: Vec<&str> = rest[1..].splitn(3, delim).collect();
    if parts.len() < 2 {
        return None;
    }
    let pattern = parts[0].to_string();
    let (replacement, flags) = if parts.len() == 3 {
        (parts[1].to_string(), parts[2].to_string())
    } else {
        (parts[1].to_string(), String::new())
    };
    let global = flags.contains('g');
    Some(SedExpr { pattern, replacement, global })
}

fn apply_expressions(text: &str, exprs: &[SedExpr]) -> String {
    let mut result = String::new();
    for line in text.split('\n') {
        let mut s = line.to_string();
        for expr in exprs {
            s = apply_substitute(&s, &expr.pattern, &expr.replacement, expr.global);
        }
        result.push_str(&s);
        result.push('\n');
    }
    // Remove trailing newline added to empty last segment if input didn't end with newline
    if !text.ends_with('\n') && result.ends_with('\n') {
        result.pop();
    } else if text.ends_with('\n') && result.ends_with('\n') {
        // correct — keep it
    }
    result
}

fn apply_substitute(line: &str, pattern: &str, replacement: &str, global: bool) -> String {
    if pattern.is_empty() {
        return line.to_string();
    }
    if global {
        let mut result = String::new();
        let mut remaining = line;
        while let Some(pos) = remaining.find(pattern) {
            result.push_str(&remaining[..pos]);
            result.push_str(replacement);
            remaining = &remaining[pos + pattern.len()..];
            if pattern.is_empty() { break; }
        }
        result.push_str(remaining);
        result
    } else {
        match line.find(pattern) {
            Some(pos) => {
                let mut result = String::new();
                result.push_str(&line[..pos]);
                result.push_str(replacement);
                result.push_str(&line[pos + pattern.len()..]);
                result
            }
            None => line.to_string(),
        }
    }
}
