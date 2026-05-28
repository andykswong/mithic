#[cfg(not(test))]
use crate::shell::Shell;
#[cfg(not(test))]
use crate::bindings::mithic::process::types::{InputStream, OutputStream};
#[cfg(not(test))]
use crate::io;
#[cfg(not(test))]
use crate::jobs::JobStatus;
#[cfg(not(test))]
use super::write_out;

#[cfg(not(test))]
pub(super) fn exec_builtin(
    shell: &mut Shell,
    name: &str,
    args: &[String],
    _stdin: Option<InputStream>,
    stdout: Option<OutputStream>,
) -> u8 {
    match name {
        "jobs" => {
            for job in shell.jobs.iter() {
                let marker = if shell.jobs.current_id() == Some(job.id) { "+" } else { "-" };
                let status_str = match job.status {
                    JobStatus::Running => "Running",
                    JobStatus::Stopped => "Stopped",
                    JobStatus::Done(_) => "Done",
                };
                let line = format!("[{}]{} {:24}{}\n", job.id, marker, status_str, job.command);
                write_out(&stdout, &line);
            }
            0
        }
        "fg" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { io::write_stderr(&msg); return 1; }
            };

            let job = match shell.jobs.get_mut(job_id) {
                Some(j) => j,
                None => {
                    io::write_stderr(&format!("msh: fg: %{}: no such job\n", job_id));
                    return 1;
                }
            };

            io::write_stderr(&format!("{}\n", job.command));

            if job.status == JobStatus::Stopped {
                for proc in &job.processes {
                    let _ = proc.kill(crate::bindings::mithic::process::types::Signal::Sigcont);
                }
                job.status = JobStatus::Running;
            }

            let mut job = shell.jobs.remove(job_id).unwrap();
            shell.foreground_pids = job.pids.clone();

            let last = job.processes.pop();
            for p in job.processes { let _ = p.wait(); }
            let exit = if let Some(p) = last { p.wait() as u8 } else { 0 };

            shell.foreground_pids.clear();
            if exit >= 128 {
                let sig_name = crate::shell::signal_name_from_num(exit - 128);
                if !sig_name.is_empty() {
                    shell.run_trap(sig_name);
                }
            }
            exit
        }
        "bg" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { io::write_stderr(&msg); return 1; }
            };

            let job = match shell.jobs.get_mut(job_id) {
                Some(j) => j,
                None => {
                    io::write_stderr(&format!("msh: bg: %{}: no such job\n", job_id));
                    return 1;
                }
            };

            if job.status == JobStatus::Stopped {
                for proc in &job.processes {
                    let _ = proc.kill(crate::bindings::mithic::process::types::Signal::Sigcont);
                }
                job.status = JobStatus::Running;
                io::write_stderr(&format!("[{}]+ {} &\n", job.id, job.command));
            }
            0
        }
        "wait" => {
            if args.is_empty() {
                let ids: Vec<usize> = shell.jobs.iter().map(|j| j.id).collect();
                let mut last_exit = 0u8;
                for id in ids {
                    if let Some(mut job) = shell.jobs.remove(id) {
                        let last = job.processes.pop();
                        for p in job.processes { let _ = p.wait(); }
                        if let Some(p) = last {
                            last_exit = p.wait() as u8;
                        }
                    }
                }
                last_exit
            } else {
                let job_id = match resolve_job_id(shell, args) {
                    Ok(id) => id,
                    Err(msg) => { io::write_stderr(&msg); return 127; }
                };
                if let Some(mut job) = shell.jobs.remove(job_id) {
                    let last = job.processes.pop();
                    for p in job.processes { let _ = p.wait(); }
                    if let Some(p) = last { p.wait() as u8 } else { 0 }
                } else {
                    io::write_stderr(&format!("msh: wait: %{}: no such job\n", job_id));
                    127
                }
            }
        }
        "disown" => {
            let job_id = match resolve_job_id(shell, args) {
                Ok(id) => id,
                Err(msg) => { io::write_stderr(&msg); return 1; }
            };
            if shell.jobs.remove(job_id).is_none() {
                io::write_stderr(&format!("msh: disown: %{}: no such job\n", job_id));
                return 1;
            }
            0
        }
        "kill" => {
            use crate::bindings::mithic::process::types::Signal;
            let mut signal = Signal::Sigterm;
            let mut targets: Vec<String> = Vec::new();

            for arg in args {
                if let Some(sig) = parse_signal_flag(arg) {
                    signal = sig;
                } else {
                    targets.push(arg.clone());
                }
            }

            if targets.is_empty() {
                io::write_stderr("msh: kill: usage: kill [-signal] pid|%job ...\n");
                return 1;
            }

            let mut exit = 0u8;
            for target in &targets {
                if target.starts_with('%') {
                    let id_str = &target[1..];
                    if let Ok(id) = id_str.parse::<usize>() {
                        if let Some(job) = shell.jobs.get(id) {
                            for proc in &job.processes {
                                let _ = proc.kill(signal);
                            }
                        } else {
                            io::write_stderr(&format!("msh: kill: %{}: no such job\n", id));
                            exit = 1;
                        }
                    }
                } else if let Ok(_pid) = target.parse::<u32>() {
                    let found = shell.jobs.iter()
                        .find(|j| j.pids.contains(&_pid));
                    if let Some(job) = found {
                        for proc in &job.processes {
                            if proc.pid() == _pid {
                                let _ = proc.kill(signal);
                            }
                        }
                    } else {
                        io::write_stderr(&format!("msh: kill: ({}) - No such process\n", _pid));
                        exit = 1;
                    }
                }
            }
            exit
        }
        "trap" => {
            if args.is_empty() {
                for (sig, handler) in &shell.traps {
                    write_out(&stdout, &format!("trap -- '{}' {}\n", handler, sig));
                }
                return 0;
            }

            if args.len() == 1 && args[0] == "-" {
                shell.traps.clear();
                return 0;
            }

            if args.len() < 2 {
                io::write_stderr("msh: trap: usage: trap 'command' signal ...\n");
                return 2;
            }

            let handler = &args[0];
            for sig_name in &args[1..] {
                let normalized = if let Ok(num) = sig_name.parse::<u8>() {
                    crate::shell::signal_name_from_num(num).to_string()
                } else {
                    let upper = sig_name.to_uppercase();
                    upper.strip_prefix("SIG").unwrap_or(&upper).to_string()
                };
                if normalized.is_empty() {
                    io::write_stderr(&format!("msh: trap: {}: invalid signal\n", sig_name));
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
            io::write_stderr(&format!("msh: {}: not handled in jobs builtin\n", name));
            127
        }
    }
}

#[cfg(not(test))]
impl Shell {
    pub(crate) fn check_background_jobs(&mut self) {
        let mut done_ids: Vec<(usize, String, u8)> = Vec::new();
        for job in self.jobs.iter() {
            if job.status != JobStatus::Running { continue; }
            if let Some(proc) = job.processes.last() {
                if let Some(exit_code) = proc.try_wait() {
                    done_ids.push((job.id, job.command.clone(), exit_code));
                }
            }
        }
        for (id, cmd, exit_code) in &done_ids {
            if self.is_interactive {
                io::write_stderr(&format!("[{}]+ Done ({})             {}\n", id, exit_code, cmd));
            }
            self.jobs.remove(*id);
        }
    }
}

#[cfg(not(test))]
fn resolve_job_id(shell: &Shell, args: &[String]) -> Result<usize, String> {
    if let Some(arg) = args.first() {
        let id_str = arg.strip_prefix('%').unwrap_or(arg);
        match id_str.parse::<usize>() {
            Ok(id) => Ok(id),
            Err(_) => Err(format!("msh: {}: no such job\n", arg)),
        }
    } else {
        match shell.jobs.current_id() {
            Some(id) => Ok(id),
            None => Err("msh: no current job\n".to_string()),
        }
    }
}

#[cfg(not(test))]
fn parse_signal_flag(arg: &str) -> Option<crate::bindings::mithic::process::types::Signal> {
    use crate::bindings::mithic::process::types::Signal;
    if !arg.starts_with('-') { return None; }
    let s = &arg[1..];
    match s {
        "INT" | "SIGINT" | "2" => Some(Signal::Sigint),
        "TERM" | "SIGTERM" | "15" => Some(Signal::Sigterm),
        "KILL" | "SIGKILL" | "9" => Some(Signal::Sigkill),
        "TSTP" | "SIGTSTP" | "20" => Some(Signal::Sigtstp),
        "CONT" | "SIGCONT" | "18" => Some(Signal::Sigcont),
        _ => None,
    }
}
