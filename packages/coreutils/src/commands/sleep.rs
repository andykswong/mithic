use super::write_stderr;

pub fn run(args: &[&str]) -> u8 {
    let secs: f64 = args.first()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);

    if secs < 0.0 {
        write_stderr("sleep: invalid time interval\n");
        return 1;
    }

    if secs > 0.0 {
        std::thread::sleep(std::time::Duration::from_secs_f64(secs));
    }
    0
}
