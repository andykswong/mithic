use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use crate::value::ShellValue;
use crate::executor::expansion::parse_array_subscript;

pub(super) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    stdin: Option<InputHandle>,
    _stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "export" => {
            for arg in args {
                if let Some((key, value)) = arg.split_once('=') {
                    shell.env.insert(key.to_string(), ShellValue::Scalar(value.to_string()));
                }
            }
            0
        }
        "unset" => {
            for arg in args {
                if let Some((name, subscript)) = parse_array_subscript(arg) {
                    if let Some(ShellValue::Array(v)) = shell.env.get_mut(name) {
                        if let Ok(idx) = subscript.parse::<i64>() {
                            let actual = if idx < 0 {
                                (v.len() as i64 + idx).max(0) as usize
                            } else {
                                idx as usize
                            };
                            if actual < v.len() {
                                v[actual] = String::new();
                            }
                        }
                    }
                } else {
                    shell.env.remove(arg.as_str());
                }
            }
            0
        }
        "declare" | "local" => exec_declare(shell, args),
        "read" => exec_read(shell, args, stdin),
        "set" => exec_set(shell, args),
        _ => {
            shell.rt.write_stderr(&format!("msh: {}: not handled in vars builtin\n", name));
            127
        }
    }
}

fn exec_declare<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let mut is_array = false;
    let mut print_mode = false;
    let mut remaining_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-a" => is_array = true,
            "-p" => print_mode = true,
            arg if arg.starts_with('-') => {
                // Unknown flag — ignore for now
            }
            _ => remaining_args.push(&args[i]),
        }
        i += 1;
    }

    if print_mode {
        let names: Vec<String> = remaining_args.iter().map(|s| s.to_string()).collect();
        for name in &names {
            match shell.env.get(name) {
                Some(ShellValue::Scalar(s)) => {
                    let line = format!("declare -- {}=\"{}\"\n", name, s);
                    shell.rt.write_stdout(&line);
                }
                Some(ShellValue::Array(v)) => {
                    let elements: Vec<String> = v.iter().map(|e| format!("\"{}\"", e)).collect();
                    let line = format!("declare -a {}=({})\n", name, elements.join(" "));
                    shell.rt.write_stdout(&line);
                }
                None => {
                    shell.rt.write_stderr(&format!("declare: {}: not found\n", name));
                }
            }
        }
        return 0;
    }

    for arg in &remaining_args {
        if let Some((name, value)) = arg.split_once('=') {
            if is_array {
                shell.env.insert(name.to_string(), ShellValue::Array(vec![value.to_string()]));
            } else {
                shell.env.insert(name.to_string(), ShellValue::Scalar(value.to_string()));
            }
        } else if is_array {
            if !shell.env.contains_key(*arg) {
                shell.env.insert(arg.to_string(), ShellValue::Array(Vec::new()));
            }
        }
    }
    0
}

fn exec_read<R: Runtime>(shell: &mut Shell<R>, args: &[String], stdin: Option<InputHandle>) -> u8 {
    let mut var_names: Vec<&str> = Vec::new();
    let mut prompt = None;
    let mut raw = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-p" => {
                i += 1;
                if i < args.len() { prompt = Some(args[i].as_str()); }
            }
            "-r" => { raw = true; }
            _ => { var_names.push(&args[i]); }
        }
        i += 1;
    }

    if var_names.is_empty() {
        var_names.push("REPLY");
    }

    if let Some(p) = prompt {
        shell.rt.write_stderr(p);
    }

    let line = match &stdin {
        Some(h) => {
            match shell.rt.pipe_read_line(h) {
                Some(l) => l,
                None => return 1,
            }
        }
        None => {
            match shell.rt.read_line() {
                Some(l) => l.trim_end_matches('\n').to_string(),
                None => return 1,
            }
        }
    };

    let line = if raw { line } else { line.replace("\\\n", "") };

    let ifs = shell.env.get("IFS").map(|v| v.as_scalar().to_string()).unwrap_or_else(|| " \t\n".to_string());
    let fields: Vec<&str> = if ifs.is_empty() {
        vec![&line]
    } else {
        line.split(|c: char| ifs.contains(c))
            .filter(|s| !s.is_empty())
            .collect()
    };

    let var_names: Vec<String> = var_names.iter().map(|s| s.to_string()).collect();
    for (idx, var_name) in var_names.iter().enumerate() {
        if idx == var_names.len() - 1 {
            let remaining: Vec<&str> = if idx < fields.len() { fields[idx..].to_vec() } else { vec![] };
            shell.env.insert(var_name.to_string(), ShellValue::Scalar(remaining.join(" ")));
        } else if idx < fields.len() {
            shell.env.insert(var_name.to_string(), ShellValue::Scalar(fields[idx].to_string()));
        } else {
            shell.env.insert(var_name.to_string(), ShellValue::Scalar(String::new()));
        }
    }

    0
}

fn exec_set<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-o" || arg == "+o" {
            let enable = arg.starts_with('-');
            i += 1;
            if i < args.len() {
                shell.options.set_o_flag(&args[i], enable);
            }
        } else if arg.starts_with('-') || arg.starts_with('+') {
            let enable = arg.starts_with('-');
            for c in arg[1..].chars() {
                shell.options.set_flag(c, enable);
            }
        }
        i += 1;
    }
    0
}
