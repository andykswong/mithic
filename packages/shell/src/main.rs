pub mod arith;
pub mod brace;
pub mod builtins;
pub mod executor;
pub mod jobs;
pub mod options;
pub mod params;
pub mod parser;
pub mod regex;
pub mod runtime;
pub mod shell;
pub mod value;

#[cfg(not(test))]
pub mod runtime_wasi;
#[cfg(test)]
pub mod runtime_test;

#[cfg(not(test))]
mod bindings {
    wit_bindgen::generate!({
        world: "shell",
        path: "./wit",
        generate_all
    });
}

#[cfg(not(test))]
fn main() {
    use crate::bindings::wasi::cli::{environment, terminal_stdin};
    use crate::runtime_wasi::WasiRuntime;
    use crate::value::ShellValue;

    let env: std::collections::HashMap<String, ShellValue> = environment::get_environment()
        .into_iter()
        .map(|(k, v)| (k, ShellValue::Scalar(v)))
        .collect();

    let cwd = environment::initial_cwd()
        .unwrap_or_else(|| "/".to_string());

    let is_interactive = terminal_stdin::get_terminal_stdin().is_some();

    let argv = environment::get_arguments();

    // Extract shell name from argv[0] (basename only)
    let argv0 = argv.first().map(|s| s.as_str()).unwrap_or("sh");
    let shell_name = argv0.rsplit('/').next().unwrap_or(argv0).to_string();

    let rt = WasiRuntime::new();
    let mut shell = shell::Shell::new(rt, env, cwd, is_interactive);
    shell.shell_name = shell_name.clone();

    // Activate POSIX mode when POSIXLY_CORRECT is set in the environment
    if shell.env.contains_key("POSIXLY_CORRECT") {
        shell.options.posix = true;
    }

    // Store $0 in env
    shell.env.insert("0".to_string(), ShellValue::Scalar(shell_name));

    // Parse CLI arguments
    let args = &argv[1..];
    let code = parse_and_run(&mut shell, args);
    if code != 0 {
        std::process::exit(code as i32);
    }
}

#[cfg(not(test))]
fn parse_and_run<R: crate::runtime::Runtime>(shell: &mut crate::shell::Shell<R>, args: &[String]) -> u8 {
    use crate::value::ShellValue;

    let mut i = 0;
    let mut command_string: Option<String> = None;
    let mut script_file: Option<String> = None;
    let mut positional_params: Vec<String> = Vec::new();
    let mut end_of_options = false;

    while i < args.len() {
        let arg = &args[i];

        if end_of_options {
            if script_file.is_none() {
                script_file = Some(arg.clone());
            } else {
                positional_params.push(arg.clone());
            }
            i += 1;
            continue;
        }

        match arg.as_str() {
            "--" => {
                end_of_options = true;
                i += 1;
            }
            "--version" => {
                shell.rt.write_stdout("sh (mithic shell) 0.1.0\n");
                return 0;
            }
            "--help" => {
                shell.rt.write_stdout("Usage: sh [options] [script] [args...]\n");
                shell.rt.write_stdout("  -c string   execute command string\n");
                shell.rt.write_stdout("  -e          exit on error\n");
                shell.rt.write_stdout("  -u          error on unset variable\n");
                shell.rt.write_stdout("  -x          trace commands\n");
                shell.rt.write_stdout("  -v          verbose (print input lines)\n");
                shell.rt.write_stdout("  --posix     enable POSIX mode (disable bash extensions)\n");
                shell.rt.write_stdout("  --version   print version\n");
                shell.rt.write_stdout("  --help      print this help\n");
                return 0;
            }
            "--posix" => {
                shell.options.posix = true;
                i += 1;
            }
            "-c" => {
                i += 1;
                if i < args.len() {
                    command_string = Some(args[i].clone());
                    i += 1;
                    // Remaining args after -c string become positional params
                    // args[i] = $0 (argv0 for the script), args[i+1..] = $1, $2, ...
                    if i < args.len() {
                        // First remaining arg overrides $0
                        shell.env.insert("0".to_string(), ShellValue::Scalar(args[i].clone()));
                        i += 1;
                        while i < args.len() {
                            positional_params.push(args[i].clone());
                            i += 1;
                        }
                    }
                }
            }
            s if s.starts_with('-') && s.len() > 1 && !s.starts_with("--") => {
                // Parse flag bundle like -exu or -e -x etc.
                let flags: Vec<char> = s[1..].chars().collect();
                for flag in flags {
                    if !shell.options.set_flag(flag, true) {
                        shell.rt.write_stderr(&format!("{}: -{}: invalid option\n", shell.shell_name, flag));
                        return 2;
                    }
                }
                i += 1;
            }
            _ => {
                // First non-option arg is script file
                script_file = Some(arg.clone());
                i += 1;
                while i < args.len() {
                    positional_params.push(args[i].clone());
                    i += 1;
                }
            }
        }
    }

    if !positional_params.is_empty() {
        shell.params.push_frame(positional_params);
    }

    if let Some(cmd) = command_string {
        shell.run_string(&cmd)
    } else if let Some(file) = script_file {
        shell.run_file(&file)
    } else {
        shell.run()
    }
}
