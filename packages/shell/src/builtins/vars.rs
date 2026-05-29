use crate::runtime::{InputHandle, OutputHandle, Runtime};
use crate::shell::Shell;
use crate::value::ShellValue;
use crate::executor::expansion::parse_array_subscript;

pub(crate) fn exec_builtin<R: Runtime>(
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
                // export VAR (no =): variable already in env is accessible to child processes
                // since env_list() exports all shell.env entries — no action needed
            }
            0
        }
        "readonly" => {
            for arg in args {
                if let Some((key, value)) = arg.split_once('=') {
                    if !shell.readonly_vars.contains(key) {
                        shell.env.insert(key.to_string(), ShellValue::Scalar(value.to_string()));
                    } else {
                        shell.rt.write_stderr(&format!("msh: {}: readonly variable\n", key));
                        return 1;
                    }
                    shell.readonly_vars.insert(key.to_string());
                } else {
                    shell.readonly_vars.insert(arg.to_string());
                }
            }
            0
        }
        "let" => {
            if args.is_empty() {
                return 1;
            }
            let mut last_result: i64 = 0;
            for arg in args {
                let result_str = shell.eval_arithmetic(arg);
                last_result = result_str.parse().unwrap_or(0);
            }
            if last_result != 0 { 0 } else { 1 }
        }
        "getopts" => exec_getopts(shell, args),
        "mapfile" | "readarray" => exec_mapfile(shell, args, stdin),
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
        "declare" | "local" => exec_declare(shell, name, args),
        "read" => exec_read(shell, args, stdin),
        "set" => exec_set(shell, args),
        _ => {
            shell.rt.write_stderr(&format!("msh: {}: not handled in vars builtin\n", name));
            127
        }
    }
}

fn exec_declare<R: Runtime>(shell: &mut Shell<R>, builtin_name: &str, args: &[String]) -> u8 {
    let is_local = builtin_name == "local";
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
        for var_name in &names {
            match shell.env.get(var_name) {
                Some(ShellValue::Scalar(s)) => {
                    let line = format!("declare -- {}=\"{}\"\n", var_name, s);
                    shell.rt.write_stdout(&line);
                }
                Some(ShellValue::Array(v)) => {
                    let elements: Vec<String> = v.iter().map(|e| format!("\"{}\"", e)).collect();
                    let line = format!("declare -a {}=({})\n", var_name, elements.join(" "));
                    shell.rt.write_stdout(&line);
                }
                None => {
                    shell.rt.write_stderr(&format!("declare: {}: not found\n", var_name));
                }
            }
        }
        return 0;
    }

    for arg in &remaining_args {
        let var_name = if let Some((name, _)) = arg.split_once('=') {
            name
        } else {
            arg
        };

        // When `local` is used inside a function, snapshot the outer value the first time
        // this variable is declared local in this scope, so it can be restored on return.
        if is_local && shell.in_function_depth > 0 {
            if let Some(scope) = shell.local_scopes.last_mut() {
                if !scope.contains_key(var_name) {
                    let prev = shell.env.get(var_name).cloned();
                    scope.insert(var_name.to_string(), prev);
                }
            }
        }

        if let Some((name, value)) = arg.split_once('=') {
            if is_array {
                shell.env.insert(name.to_string(), ShellValue::Array(vec![value.to_string()]));
            } else {
                shell.env.insert(name.to_string(), ShellValue::Scalar(value.to_string()));
            }
        } else if is_array {
            shell.env.insert(arg.to_string(), ShellValue::Array(Vec::new()));
        }
    }
    0
}

fn exec_read<R: Runtime>(shell: &mut Shell<R>, args: &[String], stdin: Option<InputHandle>) -> u8 {
    let mut var_names: Vec<&str> = Vec::new();
    let mut prompt = None;
    let mut raw = false;
    let mut array_mode = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-p" => {
                i += 1;
                if i < args.len() { prompt = Some(args[i].as_str()); }
            }
            "-r" => { raw = true; }
            "-a" => { array_mode = true; }
            flag if flag.starts_with('-') && flag.len() > 1 => {
                for ch in flag[1..].chars() {
                    match ch {
                        'r' => raw = true,
                        'a' => array_mode = true,
                        _ => {}
                    }
                }
            }
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

    if array_mode {
        let arr_name = var_names.first().map(|s| s.to_string()).unwrap_or_else(|| "REPLY".to_string());
        let arr: Vec<String> = fields.iter().map(|s| s.to_string()).collect();
        shell.env.insert(arr_name, ShellValue::Array(arr));
    } else {
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

fn exec_getopts<R: Runtime>(shell: &mut Shell<R>, args: &[String]) -> u8 {
    if args.len() < 2 {
        shell.rt.write_stderr("msh: getopts: usage: getopts optstring name\n");
        return 2;
    }
    let optstring = &args[0];
    let varname = &args[1];

    let optind: usize = shell.env.get("OPTIND")
        .and_then(|v| v.as_scalar().parse::<usize>().ok())
        .unwrap_or(1);

    let positional = shell.params.current().to_vec();
    if optind == 0 || optind > positional.len() {
        shell.env.insert("OPTIND".to_string(), ShellValue::Scalar("1".to_string()));
        return 1;
    }

    let arg = &positional[optind - 1];
    if !arg.starts_with('-') || arg == "-" || arg == "--" {
        return 1;
    }

    // Each flag character in the arg (e.g. -abc handles 'a' then 'b' then 'c')
    // We track position within the current arg via a sub-index stored in OPTARG_IDX (internal)
    // For simplicity: consume one flag per call, advance optind when arg is exhausted.
    // We store the current char offset in "OPTARG_IDX" (not POSIX but functional).
    let char_idx: usize = shell.env.get("OPTARG_IDX")
        .and_then(|v| v.as_scalar().parse::<usize>().ok())
        .unwrap_or(1); // offset within arg (1 = first flag char after '-')

    let flag_chars: Vec<char> = arg[1..].chars().collect();
    if char_idx > flag_chars.len() {
        // exhausted this arg — advance to next
        shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 1).to_string()));
        shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
        return exec_getopts(shell, args);
    }

    let opt_char = flag_chars[char_idx - 1];
    let opt_str = opt_char.to_string();

    let opt_pos = optstring.find(opt_char);
    if let Some(pos) = opt_pos {
        let takes_arg = optstring.chars().nth(pos + 1) == Some(':');
        if takes_arg {
            // Argument is rest of this flag-cluster, or next positional
            let rest_of_arg: String = flag_chars[char_idx..].iter().collect();
            if !rest_of_arg.is_empty() {
                shell.env.insert("OPTARG".to_string(), ShellValue::Scalar(rest_of_arg));
                shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 1).to_string()));
                shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
            } else if optind < positional.len() {
                shell.env.insert("OPTARG".to_string(), ShellValue::Scalar(positional[optind].clone()));
                shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 2).to_string()));
                shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
            } else {
                shell.env.insert("OPTARG".to_string(), ShellValue::Scalar(String::new()));
                shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 1).to_string()));
                shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
            }
        } else {
            shell.env.insert("OPTARG".to_string(), ShellValue::Scalar(String::new()));
            // Advance char_idx; advance optind when all flags in this arg consumed
            let next_char_idx = char_idx + 1;
            if next_char_idx > flag_chars.len() {
                shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 1).to_string()));
                shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
            } else {
                shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar(next_char_idx.to_string()));
            }
        }
        shell.env.insert(varname.to_string(), ShellValue::Scalar(opt_str));
    } else {
        shell.env.insert(varname.to_string(), ShellValue::Scalar("?".to_string()));
        shell.env.insert("OPTARG".to_string(), ShellValue::Scalar(opt_str));
        let next_char_idx = char_idx + 1;
        if next_char_idx > flag_chars.len() {
            shell.env.insert("OPTIND".to_string(), ShellValue::Scalar((optind + 1).to_string()));
            shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar("1".to_string()));
        } else {
            shell.env.insert("OPTARG_IDX".to_string(), ShellValue::Scalar(next_char_idx.to_string()));
        }
    }
    0
}

fn exec_mapfile<R: Runtime>(shell: &mut Shell<R>, args: &[String], stdin: Option<InputHandle>) -> u8 {
    let mut strip_trailing = false;
    let mut arr_name = "MAPFILE".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" => strip_trailing = true,
            name if !name.starts_with('-') => arr_name = name.to_string(),
            _ => {}
        }
        i += 1;
    }

    let data = if let Some(inp) = stdin {
        let bytes = shell.rt.pipe_read_all(inp);
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        String::new()
    };

    let lines: Vec<String> = data.lines()
        .map(|l| if strip_trailing { l.to_string() } else { format!("{}\n", l) })
        .collect();

    shell.env.insert(arr_name, ShellValue::Array(lines));
    0
}
