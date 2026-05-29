use crate::runtime::{FileType, InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use super::write_out;

pub(crate) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "cat"     => exec_cat(shell, args, stdin, stdout),
        "head"    => exec_head(shell, args, stdin, stdout),
        "tail"    => exec_tail(shell, args, stdin, stdout),
        "wc"      => exec_wc(shell, args, stdin, stdout),
        "grep"    => exec_grep(shell, args, stdin, stdout),
        "seq"     => exec_seq(shell, args, stdout),
        "sort"    => exec_sort(shell, args, stdin, stdout),
        "uniq"    => exec_uniq(shell, args, stdin, stdout),
        "tr"      => exec_tr(shell, args, stdin, stdout),
        "cut"     => exec_cut(shell, args, stdin, stdout),
        "tee"     => exec_tee(shell, args, stdin, stdout),
        "xargs"   => exec_xargs(shell, args, stdin, stdout),
        "sleep"   => exec_sleep(shell, args),
        "basename" => exec_basename(shell, args, stdout),
        "dirname"  => exec_dirname(shell, args, stdout),
        "mkdir"   => exec_mkdir(shell, args),
        "rm"      => exec_rm(shell, args),
        "cp"      => exec_cp(shell, args),
        "mv"      => exec_mv(shell, args),
        "ls"      => exec_ls(shell, args, stdout),
        _         => 127,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Read all bytes from stdin handle or file arguments. Returns (bytes, error_count).
fn read_input<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
) -> (Vec<u8>, u8) {
    if args.is_empty() {
        let data = match stdin {
            Some(h) => shell.rt.pipe_read_all(h),
            None => Vec::new(),
        };
        (data, 0)
    } else {
        let mut out = Vec::new();
        let mut errors = 0u8;
        for arg in args {
            let path = shell.resolve_path(arg);
            let data = shell.rt.read_file(&path);
            if data.is_empty() && !shell.rt.file_exists(&path) {
                shell.rt.write_stderr(&format!("msh: {}: No such file or directory\n", arg));
                errors = 1;
            } else {
                out.extend_from_slice(&data);
            }
        }
        (out, errors)
    }
}

fn lines_of(data: &[u8]) -> Vec<&str> {
    let s = std::str::from_utf8(data).unwrap_or("");
    // Split by newlines; drop a trailing empty segment from a final '\n'.
    let mut lines: Vec<&str> = s.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

/// Expand a range notation like `a-z` into its constituent chars; leave others as-is.
fn expand_char_set(set: &str) -> Vec<char> {
    let chars: Vec<char> = set.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            let start = chars[i] as u32;
            let end   = chars[i + 2] as u32;
            if start <= end {
                for c in start..=end {
                    if let Some(ch) = char::from_u32(c) {
                        result.push(ch);
                    }
                }
                i += 3;
                continue;
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

// ---------------------------------------------------------------------------
// cat
// ---------------------------------------------------------------------------

fn exec_cat<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    // Filter out flag-like args (e.g. -n, -A) that we don't implement — just ignore them.
    let file_args: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();

    if file_args.is_empty() {
        // Read from stdin
        let data = match stdin {
            Some(h) => shell.rt.pipe_read_all(h),
            None => Vec::new(),
        };
        let s = String::from_utf8_lossy(&data);
        write_out(shell, &stdout, &s);
        return 0;
    }

    let mut errors = 0u8;
    for arg in &file_args {
        let path = shell.resolve_path(arg);
        let data = shell.rt.read_file(&path);
        if data.is_empty() && !shell.rt.file_exists(&path) {
            shell.rt.write_stderr(&format!("cat: {}: No such file or directory\n", arg));
            errors = 1;
        } else {
            let s = String::from_utf8_lossy(&data);
            write_out(shell, &stdout, &s);
        }
    }
    errors
}

// ---------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------

fn exec_head<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut n: usize = 10;
    let mut file_args: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-n" => {
                i += 1;
                if i < args.len() {
                    n = args[i].parse().unwrap_or(10);
                }
            }
            a if a.starts_with("-n") => {
                n = a[2..].parse().unwrap_or(10);
            }
            a if a.starts_with('-') => {} // ignore unknown flags
            _ => file_args.push(args[i].clone()),
        }
        i += 1;
    }

    let (data, errors) = read_input(shell, &file_args, stdin);
    let lines = lines_of(&data);
    let take = n.min(lines.len());
    let out = lines[..take].join("\n");
    if !out.is_empty() {
        write_out(shell, &stdout, &out);
        write_out(shell, &stdout, "\n");
    }
    errors
}

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

fn exec_tail<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut n: usize = 10;
    let mut file_args: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-n" => {
                i += 1;
                if i < args.len() {
                    n = args[i].parse().unwrap_or(10);
                }
            }
            a if a.starts_with("-n") => {
                n = a[2..].parse().unwrap_or(10);
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i].clone()),
        }
        i += 1;
    }

    let (data, errors) = read_input(shell, &file_args, stdin);
    let lines = lines_of(&data);
    let skip = if lines.len() > n { lines.len() - n } else { 0 };
    let out = lines[skip..].join("\n");
    if !out.is_empty() {
        write_out(shell, &stdout, &out);
        write_out(shell, &stdout, "\n");
    }
    errors
}

// ---------------------------------------------------------------------------
// wc
// ---------------------------------------------------------------------------

fn exec_wc<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut count_lines = false;
    let mut count_words = false;
    let mut count_bytes = false;
    let mut file_args: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
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
            _ => file_args.push(arg.clone()),
        }
    }

    // Default: show all three
    let show_all = !count_lines && !count_words && !count_bytes;

    let (data, errors) = read_input(shell, &file_args, stdin);
    let text = String::from_utf8_lossy(&data);

    let lines = text.lines().count();
    let words = text.split_whitespace().count();
    let bytes = data.len();

    let mut parts: Vec<String> = Vec::new();
    if show_all || count_lines { parts.push(lines.to_string()); }
    if show_all || count_words { parts.push(words.to_string()); }
    if show_all || count_bytes { parts.push(bytes.to_string()); }

    write_out(shell, &stdout, &parts.join(" "));
    write_out(shell, &stdout, "\n");
    errors
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

fn exec_grep<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut invert = false;
    let mut count_mode = false;
    let mut ignore_case = false;
    let mut line_number = false;
    let mut pattern: Option<String> = None;
    let mut file_args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-v" => invert = true,
            "-c" => count_mode = true,
            "-i" => ignore_case = true,
            "-n" => line_number = true,
            "-e" => {
                i += 1;
                if i < args.len() && pattern.is_none() {
                    pattern = Some(args[i].clone());
                }
            }
            a if a.starts_with('-') && a.len() > 1 => {
                for c in a[1..].chars() {
                    match c {
                        'v' => invert = true,
                        'c' => count_mode = true,
                        'i' => ignore_case = true,
                        'n' => line_number = true,
                        _ => {}
                    }
                }
            }
            _ => {
                if pattern.is_none() {
                    pattern = Some(args[i].clone());
                } else {
                    file_args.push(args[i].clone());
                }
            }
        }
        i += 1;
    }

    let pat = match pattern {
        Some(p) => p,
        None => {
            shell.rt.write_stderr("grep: missing pattern\n");
            return 2;
        }
    };

    let (data, _read_errors) = read_input(shell, &file_args, stdin);
    let text = String::from_utf8_lossy(&data);
    let lines: Vec<&str> = text.split('\n').collect();

    // Strip trailing empty line from final '\n'
    let lines: Vec<&str> = if lines.last() == Some(&"") {
        &lines[..lines.len() - 1]
    } else {
        &lines
    }.to_vec();

    let pat_cmp = if ignore_case { pat.to_lowercase() } else { pat.clone() };

    let matches: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| {
            let haystack = if ignore_case { line.to_lowercase() } else { line.to_string() };
            let matched = match_pattern(&haystack, &pat_cmp);
            if invert { !matched } else { matched }
        })
        .map(|(i, l)| (i + 1, *l))
        .collect();

    if count_mode {
        write_out(shell, &stdout, &format!("{}\n", matches.len()));
        return if matches.is_empty() { 1 } else { 0 };
    }

    if matches.is_empty() {
        return 1;
    }

    for (lineno, line) in &matches {
        if line_number {
            write_out(shell, &stdout, &format!("{}:{}\n", lineno, line));
        } else {
            write_out(shell, &stdout, line);
            write_out(shell, &stdout, "\n");
        }
    }
    0
}

/// Basic pattern matching: supports `^` anchor, `$` anchor, and substring match.
fn match_pattern(haystack: &str, pattern: &str) -> bool {
    if pattern.starts_with('^') && pattern.ends_with('$') && pattern.len() >= 2 {
        let inner = &pattern[1..pattern.len() - 1];
        haystack == inner
    } else if pattern.starts_with('^') {
        haystack.starts_with(&pattern[1..])
    } else if pattern.ends_with('$') {
        haystack.ends_with(&pattern[..pattern.len() - 1])
    } else {
        haystack.contains(pattern)
    }
}

// ---------------------------------------------------------------------------
// seq
// ---------------------------------------------------------------------------

fn exec_seq<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdout: Option<OutputHandle>,
) -> u8 {
    let nums: Vec<f64> = args.iter().filter_map(|a| a.parse().ok()).collect();
    let (first, step, last) = match nums.len() {
        1 => (1.0f64, 1.0f64, nums[0]),
        2 => (nums[0], 1.0f64, nums[1]),
        3 => (nums[0], nums[1], nums[2]),
        _ => {
            shell.rt.write_stderr("seq: invalid usage\n");
            return 1;
        }
    };

    if step == 0.0 {
        shell.rt.write_stderr("seq: zero step\n");
        return 1;
    }

    let mut cur = first;
    let mut any = false;
    loop {
        if step > 0.0 && cur > last { break; }
        if step < 0.0 && cur < last { break; }
        // Format: if all args were integers, print as integer
        let s = if cur.fract() == 0.0 {
            format!("{}", cur as i64)
        } else {
            format!("{}", cur)
        };
        write_out(shell, &stdout, &s);
        write_out(shell, &stdout, "\n");
        cur += step;
        any = true;
    }
    if !any { return 1; }
    0
}

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

fn exec_sort<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut reverse = false;
    let mut numeric = false;
    let mut file_args: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
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
            _ => file_args.push(arg.clone()),
        }
    }

    let (data, errors) = read_input(shell, &file_args, stdin);
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
        write_out(shell, &stdout, &out);
        write_out(shell, &stdout, "\n");
    }
    errors
}

// ---------------------------------------------------------------------------
// uniq
// ---------------------------------------------------------------------------

fn exec_uniq<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let file_args: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    let (data, errors) = read_input(shell, &file_args, stdin);
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
        write_out(shell, &stdout, &out);
        write_out(shell, &stdout, "\n");
    }
    errors
}

// ---------------------------------------------------------------------------
// tr
// ---------------------------------------------------------------------------

fn exec_tr<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut delete = false;
    let mut sets: Vec<&str> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-d" => delete = true,
            "-s" => {} // squeeze — ignore for now
            a if a.starts_with('-') => {}
            _ => sets.push(arg.as_str()),
        }
    }

    let data = match stdin {
        Some(h) => shell.rt.pipe_read_all(h),
        None => Vec::new(),
    };
    let text = String::from_utf8_lossy(&data).into_owned();

    if delete {
        let set1 = sets.first().copied().unwrap_or("");
        let del_chars: Vec<char> = expand_char_set(set1);
        let result: String = text.chars().filter(|c| !del_chars.contains(c)).collect();
        write_out(shell, &stdout, &result);
    } else if sets.len() >= 2 {
        let from = expand_char_set(sets[0]);
        let to   = expand_char_set(sets[1]);
        let result: String = text.chars().map(|c| {
            if let Some(idx) = from.iter().position(|&f| f == c) {
                *to.get(idx).unwrap_or(to.last().unwrap_or(&c))
            } else {
                c
            }
        }).collect();
        write_out(shell, &stdout, &result);
    } else {
        write_out(shell, &stdout, &text);
    }
    0
}

// ---------------------------------------------------------------------------
// cut
// ---------------------------------------------------------------------------

fn exec_cut<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut delim = '\t';
    let mut fields: Vec<usize> = Vec::new();
    let mut file_args: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-d" => {
                i += 1;
                if i < args.len() {
                    delim = args[i].chars().next().unwrap_or('\t');
                }
            }
            "-f" => {
                i += 1;
                if i < args.len() {
                    fields = parse_field_list(&args[i]);
                }
            }
            a if a.starts_with("-d") => {
                delim = a[2..].chars().next().unwrap_or('\t');
            }
            a if a.starts_with("-f") => {
                fields = parse_field_list(&a[2..]);
            }
            a if a.starts_with('-') => {}
            _ => file_args.push(args[i].clone()),
        }
        i += 1;
    }

    let (data, errors) = read_input(shell, &file_args, stdin);
    let text = String::from_utf8_lossy(&data);

    for line in text.lines() {
        let parts: Vec<&str> = line.split(delim).collect();
        let selected: Vec<&str> = fields.iter()
            .filter_map(|&f| if f > 0 { parts.get(f - 1).copied() } else { None })
            .collect();
        if fields.is_empty() {
            write_out(shell, &stdout, line);
        } else {
            write_out(shell, &stdout, &selected.join(&delim.to_string()));
        }
        write_out(shell, &stdout, "\n");
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

// ---------------------------------------------------------------------------
// tee
// ---------------------------------------------------------------------------

fn exec_tee<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    let mut append = false;
    let mut file_args: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-a" => append = true,
            a if a.starts_with('-') => {}
            _ => file_args.push(arg.clone()),
        }
    }

    let data = match stdin {
        Some(h) => shell.rt.pipe_read_all(h),
        None => Vec::new(),
    };

    // Write to stdout
    let s = String::from_utf8_lossy(&data);
    write_out(shell, &stdout, &s);

    // Write to each file
    for arg in &file_args {
        let path = shell.resolve_path(arg);
        if append {
            let mut existing = shell.rt.read_file(&path);
            existing.extend_from_slice(&data);
            shell.rt.write_file(&path, &existing);
        } else {
            shell.rt.write_file(&path, &data);
        }
    }
    0
}

// ---------------------------------------------------------------------------
// xargs
// ---------------------------------------------------------------------------

fn exec_xargs<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    // The command to run (default: echo)
    let cmd = args.first().map(|s| s.as_str()).unwrap_or("echo");
    let cmd_extra_args = if args.is_empty() { &[] as &[String] } else { &args[1..] };

    let data = match stdin {
        Some(h) => shell.rt.pipe_read_all(h),
        None => Vec::new(),
    };
    let text = String::from_utf8_lossy(&data);
    let words: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();

    if words.is_empty() {
        return 0;
    }

    // Build arg list: extra_args + stdin words
    let mut all_args: Vec<String> = cmd_extra_args.to_vec();
    all_args.extend(words);

    // Dispatch the command
    if let Some(f) = crate::builtins::lookup_builtin::<R>(cmd) {
        f(shell, cmd, &all_args, None, stdout)
    } else {
        use crate::runtime::SpawnOpts;
        let env = shell.env_list();
        let opts = SpawnOpts {
            env: Some(env),
            stdin: None,
            stdout,
            stderr: None,
        };
        match shell.rt.spawn(cmd, &all_args, opts) {
            Ok(proc) => shell.rt.wait(&proc),
            Err(_) => {
                shell.rt.write_stderr(&format!("xargs: {}: command not found\n", cmd));
                127
            }
        }
    }
}

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

fn exec_sleep<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let secs: f64 = args.first()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    if secs < 0.0 {
        shell.rt.write_stderr("sleep: invalid time interval\n");
        return 1;
    }

    // In a WASM context there is no blocking sleep available; for non-zero
    // durations we simply return immediately (best-effort approximation).
    let _ = secs;
    0
}

// ---------------------------------------------------------------------------
// basename
// ---------------------------------------------------------------------------

fn exec_basename<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdout: Option<OutputHandle>,
) -> u8 {
    if args.is_empty() {
        shell.rt.write_stderr("basename: missing operand\n");
        return 1;
    }
    let path = &args[0];
    let suffix = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let base = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let result = if !suffix.is_empty() && base.ends_with(suffix) {
        base[..base.len() - suffix.len()].to_string()
    } else {
        base
    };

    write_out(shell, &stdout, &result);
    write_out(shell, &stdout, "\n");
    0
}

// ---------------------------------------------------------------------------
// dirname
// ---------------------------------------------------------------------------

fn exec_dirname<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdout: Option<OutputHandle>,
) -> u8 {
    if args.is_empty() {
        shell.rt.write_stderr("dirname: missing operand\n");
        return 1;
    }
    let path = &args[0];
    let dir = std::path::Path::new(path)
        .parent()
        .map(|p| {
            let s = p.to_string_lossy();
            if s.is_empty() { ".".to_string() } else { s.into_owned() }
        })
        .unwrap_or_else(|| ".".to_string());

    write_out(shell, &stdout, &dir);
    write_out(shell, &stdout, "\n");
    0
}

// ---------------------------------------------------------------------------
// mkdir
// ---------------------------------------------------------------------------

fn exec_mkdir<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let dirs: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if dirs.is_empty() {
        shell.rt.write_stderr("mkdir: missing operand\n");
        return 1;
    }
    let mut errors = 0u8;
    for arg in &dirs {
        let path = shell.resolve_path(arg);
        shell.rt.mkdir(&path);
        if shell.rt.file_type(&path) == FileType::NotFound {
            shell.rt.write_stderr(&format!("mkdir: cannot create directory '{}'\n", arg));
            errors = 1;
        }
    }
    errors
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

fn exec_rm<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let mut recursive = false;
    let mut force = false;
    let mut file_args: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-r" | "-R" | "--recursive" => recursive = true,
            "-f" | "--force" => force = true,
            "-rf" | "-fr" => { recursive = true; force = true; }
            a if a.starts_with('-') => {
                for c in a[1..].chars() {
                    match c {
                        'r' | 'R' => recursive = true,
                        'f' => force = true,
                        _ => {}
                    }
                }
            }
            _ => file_args.push(arg.clone()),
        }
    }

    let mut errors = 0u8;
    for arg in &file_args {
        let path = shell.resolve_path(arg);
        match shell.rt.file_type(&path) {
            FileType::Regular | FileType::Other => {
                shell.rt.unlink(&path);
            }
            FileType::Directory => {
                if recursive {
                    remove_dir_recursive(shell, &path);
                } else {
                    shell.rt.write_stderr(&format!("rm: cannot remove '{}': Is a directory\n", arg));
                    errors = 1;
                }
            }
            FileType::NotFound => {
                if !force {
                    shell.rt.write_stderr(&format!("rm: cannot remove '{}': No such file or directory\n", arg));
                    errors = 1;
                }
            }
        }
    }
    errors
}

fn remove_dir_recursive<R: Runtime>(shell: &mut Shell<R>, path: &str) {
    let entries = shell.rt.read_directory(path);
    for entry in entries {
        let child = format!("{}/{}", path.trim_end_matches('/'), entry);
        match shell.rt.file_type(&child) {
            FileType::Directory => remove_dir_recursive(shell, &child),
            _ => shell.rt.unlink(&child),
        }
    }
    // Remove the directory itself — use unlink as a best-effort fallback.
    shell.rt.unlink(path);
}

// ---------------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------------

fn exec_cp<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let file_args: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if file_args.len() < 2 {
        shell.rt.write_stderr("cp: missing destination\n");
        return 1;
    }
    let src = shell.resolve_path(&file_args[file_args.len() - 2]);
    let dst_arg = file_args[file_args.len() - 1].clone();
    let mut dst = shell.resolve_path(&dst_arg);

    // If destination is a directory, place source filename inside it.
    if shell.rt.file_type(&dst) == FileType::Directory {
        let basename = std::path::Path::new(&src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        dst = format!("{}/{}", dst.trim_end_matches('/'), basename);
    }

    let data = shell.rt.read_file(&src);
    if data.is_empty() && !shell.rt.file_exists(&src) {
        shell.rt.write_stderr(&format!("cp: cannot stat '{}': No such file or directory\n", file_args[file_args.len() - 2]));
        return 1;
    }
    shell.rt.write_file(&dst, &data);
    0
}

// ---------------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------------

fn exec_mv<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let file_args: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();
    if file_args.len() < 2 {
        shell.rt.write_stderr("mv: missing destination\n");
        return 1;
    }
    let src = shell.resolve_path(&file_args[file_args.len() - 2]);
    let dst_arg = file_args[file_args.len() - 1].clone();
    let mut dst = shell.resolve_path(&dst_arg);

    if shell.rt.file_type(&dst) == FileType::Directory {
        let basename = std::path::Path::new(&src)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        dst = format!("{}/{}", dst.trim_end_matches('/'), basename);
    }

    let data = shell.rt.read_file(&src);
    if data.is_empty() && !shell.rt.file_exists(&src) {
        shell.rt.write_stderr(&format!("mv: cannot stat '{}': No such file or directory\n", file_args[file_args.len() - 2]));
        return 1;
    }
    shell.rt.write_file(&dst, &data);
    shell.rt.unlink(&src);
    0
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

fn exec_ls<R: Runtime>(
    shell: &mut Shell<R>,
    args: &[String],
    stdout: Option<OutputHandle>,
) -> u8 {
    let file_args: Vec<String> = args.iter().filter(|a| !a.starts_with('-')).cloned().collect();

    let targets: Vec<String> = if file_args.is_empty() {
        vec![shell.cwd.clone()]
    } else {
        file_args.iter().map(|a| shell.resolve_path(a)).collect()
    };

    let mut errors = 0u8;
    for target in &targets {
        match shell.rt.file_type(target) {
            FileType::Regular | FileType::Other => {
                // Single file — just print it
                let name = std::path::Path::new(target)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| target.clone());
                write_out(shell, &stdout, &name);
                write_out(shell, &stdout, "\n");
            }
            FileType::Directory => {
                let mut entries = shell.rt.read_directory(target);
                entries.sort();
                for entry in &entries {
                    write_out(shell, &stdout, entry);
                    write_out(shell, &stdout, "\n");
                }
            }
            FileType::NotFound => {
                shell.rt.write_stderr(&format!("ls: cannot access '{}': No such file or directory\n", target));
                errors = 1;
            }
        }
    }
    errors
}
