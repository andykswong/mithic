use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use crate::value::ShellValue;
use super::write_out;

pub(crate) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    _stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "exit" => {
            let code: u8 = args.first()
                .and_then(|s| s.parse().ok())
                .unwrap_or(shell.last_exit);
            shell.exit_requested = true;
            code
        }
        "echo" => {
            let mut no_newline = false;
            let mut interpret_escapes = false;
            let mut arg_start = 0;

            // Parse flags: only leading args that match -[neE]+ are flags
            for (i, arg) in args.iter().enumerate() {
                if arg.starts_with('-') && arg.len() > 1 && arg[1..].chars().all(|c| c == 'n' || c == 'e' || c == 'E') {
                    for ch in arg[1..].chars() {
                        match ch {
                            'n' => no_newline = true,
                            'e' => interpret_escapes = true,
                            'E' => interpret_escapes = false,
                            _ => {}
                        }
                    }
                    arg_start = i + 1;
                } else {
                    break;
                }
            }

            let text = args[arg_start..].join(" ");
            let output = if interpret_escapes { interpret_echo_escapes(&text) } else { text };
            write_out(shell, &stdout, &output);
            if !no_newline {
                write_out(shell, &stdout, "\n");
            }
            0
        }
        "printf" => {
            if args.is_empty() {
                shell.rt.write_stderr("printf: usage: printf format [arguments]\n");
                return 1;
            }
            let format = &args[0];
            let format_args = &args[1..];
            let output = format_printf(format, format_args);
            write_out(shell, &stdout, &output);
            0
        }
        "pwd" => {
            write_out(shell, &stdout, &shell.cwd.clone());
            write_out(shell, &stdout, "\n");
            0
        }
        "cd" => {
            let target = args.first().cloned()
                .unwrap_or_else(|| shell.env.get("HOME").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| "/".to_string()));
            let resolved = shell.resolve_path(&target);
            shell.cwd = resolved;
            shell.env.insert("PWD".to_string(), ShellValue::Scalar(shell.cwd.clone()));
            0
        }
        "env" => {
            let pairs: Vec<(String, String)> = shell.env.iter()
                .map(|(k, v)| (k.clone(), v.as_scalar().to_string()))
                .collect();
            for (key, value) in &pairs {
                write_out(shell, &stdout, &format!("{}={}\n", key, value));
            }
            0
        }
        "true" => 0,
        "false" => 1,
        _ => {
            shell.rt.write_stderr(&format!("{}: {}: not handled in core builtin\n", shell.shell_name, name));
            127
        }
    }
}

fn interpret_echo_escapes(s: &str) -> String {
    let mut result = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => result.push('\n'),
                Some('t') => result.push('\t'),
                Some('\\') => result.push('\\'),
                Some('a') => result.push('\x07'),
                Some('b') => result.push('\x08'),
                Some('r') => result.push('\r'),
                Some('0') => {
                    // Octal: \0NNN — collect up to 3 octal digits
                    let mut oct = String::new();
                    for _ in 0..3 {
                        if let Some(&d) = chars.peek() {
                            if d >= '0' && d <= '7' {
                                oct.push(d);
                                chars.next();
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }
                    if oct.is_empty() {
                        result.push('\0');
                    } else {
                        let code = u8::from_str_radix(&oct, 8).unwrap_or(0);
                        result.push(code as char);
                    }
                }
                Some(other) => { result.push('\\'); result.push(other); }
                None => result.push('\\'),
            }
        } else {
            result.push(c);
        }
    }
    result
}

fn format_printf(format: &str, args: &[String]) -> String {
    let mut result = String::new();
    let mut arg_idx = 0;

    loop {
        let mut chars = format.chars().peekable();
        let mut used_arg = false;

        while let Some(c) = chars.next() {
            if c == '\\' {
                match chars.next() {
                    Some('n') => result.push('\n'),
                    Some('t') => result.push('\t'),
                    Some('\\') => result.push('\\'),
                    Some('r') => result.push('\r'),
                    Some('"') => result.push('"'),
                    Some('0') => {
                        // Octal: \0NNN
                        let mut oct = String::new();
                        for _ in 0..3 {
                            if let Some(&d) = chars.peek() {
                                if d >= '0' && d <= '7' {
                                    oct.push(d);
                                    chars.next();
                                } else {
                                    break;
                                }
                            } else {
                                break;
                            }
                        }
                        if oct.is_empty() {
                            result.push('\0');
                        } else {
                            let code = u8::from_str_radix(&oct, 8).unwrap_or(0);
                            result.push(code as char);
                        }
                    }
                    Some(other) => { result.push('\\'); result.push(other); }
                    None => result.push('\\'),
                }
            } else if c == '%' {
                match chars.next() {
                    Some('s') => {
                        if arg_idx < args.len() {
                            result.push_str(&args[arg_idx]);
                            arg_idx += 1;
                            used_arg = true;
                        }
                    }
                    Some('d') | Some('i') => {
                        if arg_idx < args.len() {
                            let n: i64 = args[arg_idx].parse().unwrap_or(0);
                            result.push_str(&n.to_string());
                            arg_idx += 1;
                            used_arg = true;
                        } else {
                            result.push('0');
                        }
                    }
                    Some('%') => result.push('%'),
                    Some(other) => { result.push('%'); result.push(other); }
                    None => result.push('%'),
                }
            } else {
                result.push(c);
            }
        }

        // Bash repeats the format string until all args are consumed
        if arg_idx < args.len() && used_arg {
            continue;
        } else {
            break;
        }
    }

    result
}
