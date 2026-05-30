use crate::runtime::{InputHandle, OutputHandle, Runtime, Signal};
use crate::shell::{Shell, signal_name_from_num};
use crate::jobs::JobStatus;
use super::write_out;

pub(crate) fn exec_builtin<R: Runtime>(
    shell: &mut Shell<R>,
    name: &str,
    args: &[String],
    _stdin: Option<InputHandle>,
    stdout: Option<OutputHandle>,
) -> u8 {
    match name {
        "jobs" => {
            let job_infos: Vec<(usize, Option<usize>, String, String)> = shell.jobs.iter()
                .map(|job| {
                    let marker = if shell.jobs.current_id() == Some(job.id) { "+" } else { "-" };
                    let status_str = match job.status {
                        JobStatus::Running => "Running",
                        JobStatus::Stopped => "Stopped",
                        JobStatus::Done(_) => "Done",
                    };
                    (job.id, shell.jobs.current_id(), format!("{}", marker), format!("{:24}{}", status_str, job.command))
                })
                .collect();
            for (id, _, marker, rest) in &job_infos {
                let line = format!("[{}]{} {}\n", id, marker, rest);
                write_out(shell, &stdout, &line);
            }
            0
        }
        "fg" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { shell.rt.write_stderr(&msg); return 1; }
            };

            let job = match shell.jobs.get(job_id) {
                Some(j) => j,
                None => {
                    shell.rt.write_stderr(&format!("{}: fg: %{}: no such job\n", shell.shell_name, job_id));
                    return 1;
                }
            };

            shell.rt.write_stderr(&format!("{}\n", job.command));

            if job.status == JobStatus::Stopped {
                let proc_handles: Vec<_> = job.processes.iter().map(|h| crate::runtime::ProcessHandle(h.0)).collect();
                for proc in &proc_handles {
                    let _ = shell.rt.kill(proc, Signal::Cont);
                }
            }

            let mut job = match shell.jobs.remove(job_id) {
                Some(j) => j,
                None => {
                    shell.rt.write_stderr(&format!("{}: fg: %{}: no such job\n", shell.shell_name, job_id));
                    return 1;
                }
            };
            shell.foreground_pids = job.pids.clone();

            let last = job.processes.pop();
            for p in job.processes {
                let _ = shell.rt.wait(&p);
            }
            let exit = if let Some(p) = last { shell.rt.wait(&p) } else { 0 };

            shell.foreground_pids.clear();
            if exit >= 128 {
                let sig_name = signal_name_from_num(exit - 128);
                if !sig_name.is_empty() {
                    shell.run_trap(sig_name);
                }
            }
            exit
        }
        "bg" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { shell.rt.write_stderr(&msg); return 1; }
            };

            let job = match shell.jobs.get_mut(job_id) {
                Some(j) => j,
                None => {
                    shell.rt.write_stderr(&format!("{}: bg: %{}: no such job\n", shell.shell_name, job_id));
                    return 1;
                }
            };

            if job.status == JobStatus::Stopped {
                let proc_handles: Vec<_> = job.processes.iter().map(|h| crate::runtime::ProcessHandle(h.0)).collect();
                let cmd = job.command.clone();
                let id = job.id;
                job.status = JobStatus::Running;
                for proc in &proc_handles {
                    let _ = shell.rt.kill(proc, Signal::Cont);
                }
                shell.rt.write_stderr(&format!("[{}]+ {} &\n", id, cmd));
            }
            0
        }
        "wait" => {
            // Check for -n flag: wait for any ONE job to complete
            if args.len() == 1 && args[0] == "-n" {
                // Try to find a job that's already done
                let done_id = shell.jobs.iter()
                    .find(|j| matches!(j.status, JobStatus::Done(_)))
                    .map(|j| j.id);
                if let Some(id) = done_id {
                    if let Some(job) = shell.jobs.remove(id) {
                        if let JobStatus::Done(code) = job.status {
                            return code;
                        }
                    }
                    return 0;
                }
                // No job already done — wait for the first one to finish
                let ids: Vec<usize> = shell.jobs.iter()
                    .filter(|j| j.status == JobStatus::Running)
                    .map(|j| j.id)
                    .collect();
                if ids.is_empty() {
                    return 127; // no jobs to wait for
                }
                // Wait for the first job (in table order)
                let first_id = ids[0];
                if let Some(mut job) = shell.jobs.remove(first_id) {
                    let last = job.processes.pop();
                    for p in job.processes {
                        let _ = shell.rt.wait(&p);
                    }
                    if let Some(p) = last { shell.rt.wait(&p) } else { 0 }
                } else {
                    127
                }
            } else if args.is_empty() {
                let ids: Vec<usize> = shell.jobs.iter().map(|j| j.id).collect();
                let mut last_exit = 0u8;
                for id in ids {
                    if let Some(mut job) = shell.jobs.remove(id) {
                        let last = job.processes.pop();
                        for p in job.processes {
                            let _ = shell.rt.wait(&p);
                        }
                        if let Some(p) = last {
                            last_exit = shell.rt.wait(&p);
                        }
                    }
                }
                last_exit
            } else {
                let job_id = match resolve_job_id(shell, args) {
                    Ok(id) => id,
                    Err(msg) => { shell.rt.write_stderr(&msg); return 127; }
                };
                if let Some(mut job) = shell.jobs.remove(job_id) {
                    let last = job.processes.pop();
                    for p in job.processes {
                        let _ = shell.rt.wait(&p);
                    }
                    if let Some(p) = last { shell.rt.wait(&p) } else { 0 }
                } else {
                    shell.rt.write_stderr(&format!("{}: wait: %{}: no such job\n", shell.shell_name, job_id));
                    127
                }
            }
        }
        "disown" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { shell.rt.write_stderr(&msg); return 1; }
            };
            if shell.jobs.remove(job_id).is_none() {
                shell.rt.write_stderr(&format!("{}: disown: %{}: no such job\n", shell.shell_name, job_id));
                return 1;
            }
            0
        }
        "kill" => {
            let mut signal = Signal::Term;
            let mut targets: Vec<String> = Vec::new();

            for arg in args {
                if let Some(sig) = parse_signal_flag(arg) {
                    signal = sig;
                } else {
                    targets.push(arg.clone());
                }
            }

            if targets.is_empty() {
                shell.rt.write_stderr(&format!("{}: kill: usage: kill [-signal] pid|%job ...\n", shell.shell_name));
                return 1;
            }

            let mut exit = 0u8;
            for target in &targets {
                if target.starts_with('%') {
                    let id_str = &target[1..];
                    if let Ok(id) = id_str.parse::<usize>() {
                        if let Some(job) = shell.jobs.get(id) {
                            let proc_handles: Vec<_> = job.processes.iter().map(|h| crate::runtime::ProcessHandle(h.0)).collect();
                            for proc in &proc_handles {
                                let _ = shell.rt.kill(proc, signal);
                            }
                        } else {
                            shell.rt.write_stderr(&format!("{}: kill: %{}: no such job\n", shell.shell_name, id));
                            exit = 1;
                        }
                    }
                } else if let Ok(_pid) = target.parse::<u32>() {
                    let job_id = shell.jobs.iter()
                        .find(|j| j.pids.contains(&_pid))
                        .map(|j| j.id);
                    if let Some(jid) = job_id {
                        if let Some(job) = shell.jobs.get(jid) {
                            let matching: Vec<_> = job.processes.iter()
                                .enumerate()
                                .filter(|(i, _)| i < &job.pids.len() && job.pids[*i] == _pid)
                                .map(|(_, h)| crate::runtime::ProcessHandle(h.0))
                                .collect();
                            for proc in &matching {
                                let _ = shell.rt.kill(proc, signal);
                            }
                        }
                    } else {
                        shell.rt.write_stderr(&format!("{}: kill: ({}) - No such process\n", shell.shell_name, _pid));
                        exit = 1;
                    }
                }
            }
            exit
        }
        "trap" => {
            if args.is_empty() {
                let trap_infos: Vec<(String, String)> = shell.traps.iter()
                    .map(|(sig, handler)| (sig.clone(), handler.clone()))
                    .collect();
                for (sig, handler) in &trap_infos {
                    write_out(shell, &stdout, &format!("trap -- '{}' {}\n", handler, sig));
                }
                return 0;
            }

            if args.len() == 1 && args[0] == "-" {
                shell.traps.clear();
                return 0;
            }

            if args.len() < 2 {
                shell.rt.write_stderr(&format!("{}: trap: usage: trap 'command' signal ...\n", shell.shell_name));
                return 2;
            }

            let handler = args[0].clone();
            for sig_name in &args[1..] {
                let normalized = if let Ok(num) = sig_name.parse::<u8>() {
                    signal_name_from_num(num).to_string()
                } else {
                    let upper = sig_name.to_uppercase();
                    upper.strip_prefix("SIG").unwrap_or(&upper).to_string()
                };
                if normalized.is_empty() {
                    shell.rt.write_stderr(&format!("{}: trap: {}: invalid signal\n", shell.shell_name, sig_name));
                    continue;
                }
                if handler == "-" {
                    shell.traps.remove(&normalized);
                } else {
                    shell.traps.insert(normalized, handler.clone());
                }
            }
            0
        }
        _ => {
            shell.rt.write_stderr(&format!("{}: {}: not handled in jobs builtin\n", shell.shell_name, name));
            127
        }
    }
}

fn resolve_job_id<R: Runtime>(shell: &Shell<R>, args: &[String]) -> Result<usize, String> {
    if let Some(arg) = args.first() {
        let id_str = arg.strip_prefix('%').unwrap_or(arg);
        match id_str.parse::<usize>() {
            Ok(id) => Ok(id),
            Err(_) => Err(format!("{}: {}: no such job\n", shell.shell_name, arg)),
        }
    } else {
        match shell.jobs.current_id() {
            Some(id) => Ok(id),
            None => Err(format!("{}: no current job\n", shell.shell_name)),
        }
    }
}

fn parse_signal_flag(arg: &str) -> Option<Signal> {
    if !arg.starts_with('-') { return None; }
    let s = &arg[1..];
    match s {
        "INT" | "SIGINT" | "2" => Some(Signal::Int),
        "TERM" | "SIGTERM" | "15" => Some(Signal::Term),
        "KILL" | "SIGKILL" | "9" => Some(Signal::Kill),
        "TSTP" | "SIGTSTP" | "20" => Some(Signal::Tstp),
        "CONT" | "SIGCONT" | "18" => Some(Signal::Cont),
        _ => None,
    }
}
