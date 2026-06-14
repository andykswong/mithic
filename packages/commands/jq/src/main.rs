pub mod json;
pub mod filter;
pub mod eval;
pub mod builtins;

use json::{JValue, FormatOpts, format_value, parse_json, parse_json_at};
use filter::parse_filter;
use eval::{JqError, Env, eval};

fn write_stdout(s: &str) {
    use std::io::Write;
    let mut out = std::io::stdout();
    if out.write_all(s.as_bytes()).is_err() { std::process::exit(141); }
    if out.flush().is_err() { std::process::exit(141); }
}

fn write_stderr(s: &str) {
    use std::io::Write;
    let mut err = std::io::stderr();
    err.write_all(s.as_bytes()).ok();
    err.flush().ok();
}

fn read_stdin_all() -> Vec<u8> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::io::stdin().read_to_end(&mut buf).ok();
    buf
}

fn read_file(path: &str) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd_args: Vec<&str> = args[1..].iter().map(|s| s.as_str()).collect();
    let code = run(&cmd_args);
    if code != 0 {
        std::process::exit(code as i32);
    }
}

pub fn run(args: &[&str]) -> u8 {
    let mut raw_output = false;
    let mut raw_input = false;
    let mut null_input = false;
    let mut compact = false;
    let mut sort_keys = false;
    let mut exit_status = false;
    let mut use_tab = false;
    let mut indent: usize = 2;
    let mut slurp = false;
    let mut extra_args: Vec<(String, JValue)> = Vec::new();
    let mut json_args: Vec<JValue> = Vec::new();
    let mut filter_str: Option<&str> = None;
    let mut file_args: Vec<&str> = Vec::new();
    let mut positional_done = false;
    let mut jsonargs_mode = false;

    let mut i = 0;
    while i < args.len() {
        if jsonargs_mode {
            match parse_json(args[i]) {
                Ok(v) => json_args.push(v),
                Err(e) => {
                    write_stderr(&format!("jq: --jsonargs: {}\n", e));
                    return 2;
                }
            }
            i += 1;
            continue;
        }
        match args[i] {
            "-r" | "--raw-output" => raw_output = true,
            "-R" | "--raw-input" => raw_input = true,
            "-n" | "--null-input" => null_input = true,
            "-c" | "--compact-output" => compact = true,
            "-S" | "--sort-keys" => sort_keys = true,
            "-e" | "--exit-status" => exit_status = true,
            "--tab" => use_tab = true,
            "-s" | "--slurp" => slurp = true,
            "--indent" => {
                i += 1;
                if i < args.len() {
                    indent = args[i].parse().unwrap_or(2).min(7);
                }
            }
            "--arg" => {
                i += 1;
                if i + 1 < args.len() {
                    let name = args[i].to_string();
                    let val = JValue::String(args[i + 1].to_string());
                    extra_args.push((name, val));
                    i += 1;
                }
            }
            "--argjson" => {
                i += 1;
                if i + 1 < args.len() {
                    let name = args[i].to_string();
                    match parse_json(args[i + 1]) {
                        Ok(v) => extra_args.push((name, v)),
                        Err(e) => {
                            write_stderr(&format!("jq: --argjson: {}\n", e));
                            return 2;
                        }
                    }
                    i += 1;
                }
            }
            "--jsonargs" => {
                jsonargs_mode = true;
            }
            "--" => {
                positional_done = true;
            }
            a if !positional_done && a.starts_with('-') && a.len() > 1 => {
                let mut chars = a[1..].chars().peekable();
                let mut unknown = false;
                while let Some(c) = chars.next() {
                    match c {
                        'r' => raw_output = true,
                        'R' => raw_input = true,
                        'n' => null_input = true,
                        'c' => compact = true,
                        'S' => sort_keys = true,
                        'e' => exit_status = true,
                        's' => slurp = true,
                        _ => { unknown = true; break; }
                    }
                }
                if unknown {
                    write_stderr(&format!("jq: unknown option: {}\n", a));
                    return 2;
                }
            }
            a => {
                if filter_str.is_none() {
                    filter_str = Some(a);
                } else {
                    file_args.push(a);
                }
            }
        }
        i += 1;
    }

    let filter_src = filter_str.unwrap_or(".");

    let filter = match parse_filter(filter_src) {
        Ok(f) => f,
        Err(e) => {
            write_stderr(&format!("jq: parse error: {}\n", e));
            return 3;
        }
    };

    let fmt = FormatOpts {
        compact,
        sort_keys,
        indent: if use_tab { 0 } else { indent },
        use_tab,
        raw_output,
    };

    let mut args_positional = Vec::new();
    for v in &json_args {
        args_positional.push(v.clone());
    }
    let mut args_named_fields: Vec<(String, JValue)> = Vec::new();
    for (name, val) in &extra_args {
        args_named_fields.push((name.clone(), val.clone()));
    }
    let args_obj = JValue::Object(vec![
        ("positional".to_string(), JValue::Array(args_positional)),
        ("named".to_string(), JValue::Object(args_named_fields)),
    ]);

    let mut env = Env::new();
    env.bind("ARGS".to_string(), args_obj);
    for (name, val) in &extra_args {
        env.bind(name.clone(), val.clone());
    }

    let mut last_output: Option<JValue> = None;
    let mut had_error = false;
    let mut exit_code: u8 = 0;

    let process_input = |input: JValue, env: &mut Env, filter: &filter::Filter,
                          fmt: &FormatOpts, last_output: &mut Option<JValue>,
                          had_error: &mut bool| {
        match eval(filter, &input, env) {
            Ok(outputs) => {
                for v in outputs {
                    let s = if fmt.raw_output {
                        match &v {
                            JValue::String(s) => format!("{}\n", s),
                            _ => format!("{}\n", format_value(&v, fmt)),
                        }
                    } else {
                        format!("{}\n", format_value(&v, fmt))
                    };
                    write_stdout(&s);
                    *last_output = Some(v);
                }
            }
            Err(JqError::HaltError(code)) => {
                std::process::exit(code as i32);
            }
            Err(JqError::Halt) => {
                std::process::exit(0);
            }
            Err(e) => {
                write_stderr(&format!("jq: {}\n", e));
                *had_error = true;
            }
        }
    };

    if null_input {
        let input = JValue::Null;
        process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
    } else if file_args.is_empty() {
        let data = read_stdin_all();
        if raw_input {
            let text = String::from_utf8_lossy(&data);
            if slurp {
                let input = JValue::String(text.into_owned());
                process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
            } else {
                for line in text.lines() {
                    let input = JValue::String(line.to_string());
                    process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
                }
            }
        } else if slurp {
            let text = String::from_utf8_lossy(&data);
            let mut inputs = Vec::new();
            let mut pos = 0;
            let s = text.as_ref();
            loop {
                let trimmed = s[pos..].trim_start();
                if trimmed.is_empty() { break; }
                let offset = pos + (s.len() - pos - trimmed.len());
                match parse_json_at(s, offset) {
                    Ok((v, new_pos)) => { inputs.push(v); pos = new_pos; }
                    Err(_) => break,
                }
            }
            let input = JValue::Array(inputs);
            process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
        } else {
            let text = String::from_utf8_lossy(&data);
            let mut pos = 0;
            let s = text.as_ref();
            loop {
                let ahead = s[pos..].trim_start();
                if ahead.is_empty() { break; }
                let offset = pos + (s.len() - pos - ahead.len());
                match parse_json_at(s, offset) {
                    Ok((v, new_pos)) => {
                        pos = new_pos;
                        process_input(v, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
                    }
                    Err(e) => {
                        write_stderr(&format!("jq: parse error: {}\n", e));
                        had_error = true;
                        break;
                    }
                }
            }
        }
    } else {
        let mut all_inputs: Vec<JValue> = Vec::new();
        for &path in &file_args {
            let data = match read_file(path) {
                Some(d) => d,
                None => {
                    write_stderr(&format!("jq: {}: No such file or directory\n", path));
                    had_error = true;
                    continue;
                }
            };
            if raw_input {
                let text = String::from_utf8_lossy(&data);
                if slurp {
                    all_inputs.push(JValue::String(text.into_owned()));
                } else {
                    for line in text.lines() {
                        let input = JValue::String(line.to_string());
                        process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
                    }
                }
            } else {
                let text = String::from_utf8_lossy(&data);
                let s = text.as_ref();
                let mut pos = 0;
                loop {
                    let ahead = s[pos..].trim_start();
                    if ahead.is_empty() { break; }
                    let offset = pos + (s.len() - pos - ahead.len());
                    match parse_json_at(s, offset) {
                        Ok((v, new_pos)) => {
                            pos = new_pos;
                            if slurp { all_inputs.push(v); } else {
                                process_input(v, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
                            }
                        }
                        Err(e) => {
                            write_stderr(&format!("jq: {}: parse error: {}\n", path, e));
                            had_error = true;
                            break;
                        }
                    }
                }
            }
        }
        if slurp && !all_inputs.is_empty() {
            let input = JValue::Array(all_inputs);
            process_input(input, &mut env, &filter, &fmt, &mut last_output, &mut had_error);
        }
    }

    if had_error {
        exit_code = 5;
    }
    if exit_status {
        match &last_output {
            None | Some(JValue::Null) | Some(JValue::Bool(false)) => {
                if exit_code == 0 { exit_code = 1; }
            }
            _ => {}
        }
    }
    exit_code
}
