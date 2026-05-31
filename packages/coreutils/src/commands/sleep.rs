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

#[cfg(test)]
mod tests {
    #[test]
    fn parse_valid_seconds() {
        let args = &["1.5"];
        let secs: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        assert_eq!(secs, 1.5);
    }

    #[test]
    fn parse_zero() {
        let args = &["0"];
        let secs: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        assert_eq!(secs, 0.0);
    }

    #[test]
    fn parse_empty_args_defaults_to_zero() {
        let args: &[&str] = &[];
        let secs: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        assert_eq!(secs, 0.0);
    }

    #[test]
    fn parse_invalid_returns_zero() {
        let args = &["abc"];
        let secs: f64 = args.first().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        assert_eq!(secs, 0.0);
    }
}
