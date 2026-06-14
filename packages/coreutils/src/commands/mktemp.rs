use super::{write_stdout, write_stderr, resolve_path};

pub fn run(args: &[&str]) -> u8 {
    let mut directory = false;
    let mut tmpdir: Option<String> = None;
    let mut use_tmpdir_flag = false;
    let mut dry_run = false;
    let mut quiet = false;
    let mut suffix = String::new();
    let mut template: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i];
        match arg {
            "-d" | "--directory" => directory = true,
            "-u" | "--dry-run" => dry_run = true,
            "-q" | "--quiet" => quiet = true,
            "-t" => use_tmpdir_flag = true,
            "-p" => {
                i += 1;
                if i < args.len() {
                    tmpdir = Some(args[i].to_string());
                } else {
                    if !quiet {
                        write_stderr("mktemp: option '-p' requires an argument\n");
                    }
                    return 1;
                }
            }
            a if a.starts_with("--tmpdir=") => {
                tmpdir = Some(a["--tmpdir=".len()..].to_string());
            }
            "--tmpdir" => {
                tmpdir = Some(String::new());
            }
            a if a.starts_with("--suffix=") => {
                suffix = a["--suffix=".len()..].to_string();
            }
            a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => {
                for c in a[1..].chars() {
                    match c {
                        'd' => directory = true,
                        'u' => dry_run = true,
                        'q' => quiet = true,
                        't' => use_tmpdir_flag = true,
                        'p' => {
                            i += 1;
                            if i < args.len() {
                                tmpdir = Some(args[i].to_string());
                            } else {
                                if !quiet {
                                    write_stderr("mktemp: option '-p' requires an argument\n");
                                }
                                return 1;
                            }
                        }
                        _ => {
                            if !quiet {
                                write_stderr(&format!("mktemp: invalid option -- '{}'\n", c));
                            }
                            return 1;
                        }
                    }
                }
            }
            _ => {
                if template.is_none() {
                    template = Some(arg.to_string());
                } else {
                    if !quiet {
                        write_stderr("mktemp: too many templates\n");
                    }
                    return 1;
                }
            }
        }
        i += 1;
    }

    let default_template = "tmp.XXXXXXXXXX".to_string();
    let tmpl = template.unwrap_or(default_template);

    let base_dir = if use_tmpdir_flag {
        get_tmpdir_or(tmpdir.as_deref())
    } else if tmpdir.is_some() {
        let d = tmpdir.unwrap();
        if d.is_empty() {
            get_tmpdir_or(None)
        } else {
            d
        }
    } else if tmpl.contains('/') {
        String::new()
    } else {
        get_tmpdir_or(None)
    };

    let (prefix, x_count, tmpl_suffix) = match parse_template(&tmpl, &suffix) {
        Some(v) => v,
        None => {
            if !quiet {
                write_stderr(&format!(
                    "mktemp: too few X's in template '{}'\n",
                    tmpl
                ));
            }
            return 1;
        }
    };

    for _ in 0..100 {
        let random_part = generate_random_chars(x_count);
        let filename = format!("{}{}{}", prefix, random_part, tmpl_suffix);

        let full_path = if base_dir.is_empty() {
            resolve_path(&filename)
        } else {
            let dir = resolve_path(&base_dir);
            format!("{}/{}", dir.trim_end_matches('/'), filename)
        };

        if dry_run {
            write_stdout(&format!("{}\n", full_path));
            return 0;
        }

        if directory {
            if std::fs::create_dir(&full_path).is_ok() {
                write_stdout(&format!("{}\n", full_path));
                return 0;
            }
        } else {
            if std::fs::metadata(&full_path).is_err() {
                if std::fs::write(&full_path, b"").is_ok() {
                    write_stdout(&format!("{}\n", full_path));
                    return 0;
                }
            }
        }
    }

    if !quiet {
        write_stderr("mktemp: failed to create file via template\n");
    }
    1
}

fn get_tmpdir_or(dir: Option<&str>) -> String {
    match dir {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            if let Ok(tmpdir) = std::env::var("TMPDIR") {
                if std::fs::metadata(&tmpdir).is_ok() {
                    return tmpdir;
                }
            }
            "/tmp".to_string()
        }
    }
}

fn parse_template(tmpl: &str, suffix: &str) -> Option<(String, usize, String)> {
    let name = if tmpl.contains('/') {
        tmpl.rsplit('/').next().unwrap_or(tmpl)
    } else {
        tmpl
    };

    let dir_prefix = if tmpl.contains('/') {
        &tmpl[..tmpl.len() - name.len()]
    } else {
        ""
    };

    let x_count = name.chars().rev().take_while(|&c| c == 'X').count();

    if x_count < 3 {
        return None;
    }

    let prefix = format!("{}{}", dir_prefix, &name[..name.len() - x_count]);
    let tmpl_suffix = suffix.to_string();

    Some((prefix, x_count, tmpl_suffix))
}

fn generate_random_chars(count: usize) -> String {
    use std::time::SystemTime;

    let seed = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;

    let charset = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let mut state = seed ^ 0x517cc1b727220a95;
    let mut result = String::with_capacity(count);
    for i in 0..count {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state = state.wrapping_add(i as u64);
        let idx = (state % charset.len() as u64) as usize;
        result.push(charset[idx] as char);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_random_chars_correct_length() {
        let s = generate_random_chars(10);
        assert_eq!(s.len(), 10);
    }

    #[test]
    fn test_generate_random_chars_alphanumeric() {
        let s = generate_random_chars(100);
        assert!(s.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn test_generate_random_chars_not_all_same() {
        let s = generate_random_chars(10);
        let first = s.chars().next().unwrap();
        assert!(!s.chars().all(|c| c == first), "should not be all same char");
    }

    #[test]
    fn test_parse_template_basic() {
        let (prefix, count, suffix) = parse_template("tmp.XXXXXXXXXX", "").unwrap();
        assert_eq!(prefix, "tmp.");
        assert_eq!(count, 10);
        assert_eq!(suffix, "");
    }

    #[test]
    fn test_parse_template_with_path() {
        let (prefix, count, suffix) = parse_template("/tmp/myapp.XXXXXX", "").unwrap();
        assert_eq!(prefix, "/tmp/myapp.");
        assert_eq!(count, 6);
        assert_eq!(suffix, "");
    }

    #[test]
    fn test_parse_template_min_3_xs() {
        assert!(parse_template("foo.XX", "").is_none());
        assert!(parse_template("foo.XXX", "").is_some());
    }

    #[test]
    fn test_parse_template_with_suffix() {
        let (prefix, count, suffix) = parse_template("tmp.XXXXXX", ".txt").unwrap();
        assert_eq!(prefix, "tmp.");
        assert_eq!(count, 6);
        assert_eq!(suffix, ".txt");
    }

    #[test]
    fn test_get_tmpdir_default() {
        let result = get_tmpdir_or(None);
        assert!(!result.is_empty());
    }

    #[test]
    fn test_get_tmpdir_custom() {
        let result = get_tmpdir_or(Some("/var/tmp"));
        assert_eq!(result, "/var/tmp");
    }

    #[test]
    fn test_parse_template_only_xs() {
        let (prefix, count, suffix) = parse_template("XXXXXX", "").unwrap();
        assert_eq!(prefix, "");
        assert_eq!(count, 6);
        assert_eq!(suffix, "");
    }
}
