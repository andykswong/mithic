use super::write_stdout;

pub fn run(args: &[&str]) -> u8 {
    let format_arg = args.iter().find(|a| a.starts_with('+'));
    let format = format_arg.map(|a| &a[1..]).unwrap_or("%a %b %e %H:%M:%S UTC %Y");

    let datetime = get_datetime();
    let output = format_datetime(format, &datetime);
    write_stdout(&output);
    write_stdout("\n");
    0
}

struct DateTime {
    year: u32,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
    weekday: u8, // 0 = Sunday
    epoch_secs: u64,
}

fn get_datetime() -> DateTime {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut dt = epoch_to_datetime(secs);
    dt.epoch_secs = secs;
    dt
}

fn epoch_to_datetime(secs: u64) -> DateTime {
    // Days since Unix epoch (1970-01-01)
    let days = (secs / 86400) as u32;
    let time_of_day = (secs % 86400) as u32;

    let hour = (time_of_day / 3600) as u8;
    let minute = ((time_of_day % 3600) / 60) as u8;
    let second = (time_of_day % 60) as u8;

    // Weekday: 1970-01-01 was Thursday (4)
    let weekday = ((days + 4) % 7) as u8;

    // Gregorian calendar conversion
    let (year, month, day) = days_to_ymd(days);

    DateTime { year, month, day, hour, minute, second, weekday, epoch_secs: secs }
}

fn days_to_ymd(days: u32) -> (u32, u8, u8) {
    // Use the civil date algorithm
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y } as u32;
    (year, m as u8, d as u8)
}

fn format_datetime(fmt: &str, dt: &DateTime) -> String {
    let months_abbr = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let months_full = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    let days_abbr = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    let days_full = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

    let mut result = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'Y' => result.push_str(&format!("{:04}", dt.year)),
                'y' => result.push_str(&format!("{:02}", dt.year % 100)),
                'm' => result.push_str(&format!("{:02}", dt.month)),
                'd' => result.push_str(&format!("{:02}", dt.day)),
                'e' => result.push_str(&format!("{:2}", dt.day)),
                'H' => result.push_str(&format!("{:02}", dt.hour)),
                'M' => result.push_str(&format!("{:02}", dt.minute)),
                'S' => result.push_str(&format!("{:02}", dt.second)),
                's' => result.push_str(&format!("{}", dt.epoch_secs)),
                'j' => {
                    let doy = day_of_year(dt.year, dt.month, dt.day);
                    result.push_str(&format!("{:03}", doy));
                }
                'b' | 'h' => {
                    if dt.month >= 1 && dt.month <= 12 {
                        result.push_str(months_abbr[(dt.month - 1) as usize]);
                    }
                }
                'B' => {
                    if dt.month >= 1 && dt.month <= 12 {
                        result.push_str(months_full[(dt.month - 1) as usize]);
                    }
                }
                'a' => {
                    result.push_str(days_abbr[(dt.weekday % 7) as usize]);
                }
                'A' => {
                    result.push_str(days_full[(dt.weekday % 7) as usize]);
                }
                'Z' => result.push_str("UTC"),
                'u' => result.push_str(&format!("{}", if dt.weekday == 0 { 7 } else { dt.weekday })),
                'w' => result.push_str(&format!("{}", dt.weekday)),
                'n' => result.push('\n'),
                't' => result.push('\t'),
                '%' => result.push('%'),
                other => {
                    result.push('%');
                    result.push(other);
                }
            }
        } else {
            result.push(chars[i]);
        }
        i += 1;
    }
    result
}

fn day_of_year(year: u32, month: u8, day: u8) -> u32 {
    let days_in_month = [31u32, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = is_leap(year);
    let mut doy = day as u32;
    for m in 0..(month as usize - 1) {
        doy += days_in_month[m];
        if m == 1 && leap { doy += 1; }
    }
    doy
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- epoch_to_datetime ---

    #[test]
    fn epoch_zero_is_unix_epoch() {
        let dt = epoch_to_datetime(0);
        assert_eq!(dt.year, 1970);
        assert_eq!(dt.month, 1);
        assert_eq!(dt.day, 1);
        assert_eq!(dt.hour, 0);
        assert_eq!(dt.minute, 0);
        assert_eq!(dt.second, 0);
        assert_eq!(dt.weekday, 4); // Thursday
    }

    #[test]
    fn epoch_one_day_later() {
        let dt = epoch_to_datetime(86400);
        assert_eq!(dt.year, 1970);
        assert_eq!(dt.month, 1);
        assert_eq!(dt.day, 2);
        assert_eq!(dt.weekday, 5); // Friday
    }

    #[test]
    fn epoch_known_date() {
        // 2000-01-01 00:00:00 UTC = 946684800
        let dt = epoch_to_datetime(946684800);
        assert_eq!(dt.year, 2000);
        assert_eq!(dt.month, 1);
        assert_eq!(dt.day, 1);
    }

    #[test]
    fn epoch_time_components() {
        // 3661 seconds = 1h 1m 1s
        let dt = epoch_to_datetime(3661);
        assert_eq!(dt.hour, 1);
        assert_eq!(dt.minute, 1);
        assert_eq!(dt.second, 1);
    }

    // --- is_leap ---

    #[test]
    fn leap_year_divisible_by_4() {
        assert!(is_leap(2024));
    }

    #[test]
    fn leap_year_century_not_leap() {
        assert!(!is_leap(1900));
    }

    #[test]
    fn leap_year_400_is_leap() {
        assert!(is_leap(2000));
    }

    #[test]
    fn non_leap_year() {
        assert!(!is_leap(2023));
    }

    // --- format_datetime ---

    #[test]
    fn format_year() {
        let dt = epoch_to_datetime(0);
        assert_eq!(format_datetime("%Y", &dt), "1970");
    }

    #[test]
    fn format_month_day() {
        let dt = epoch_to_datetime(0);
        assert_eq!(format_datetime("%m/%d", &dt), "01/01");
    }

    #[test]
    fn format_abbrev_month() {
        let dt = epoch_to_datetime(0); // January
        assert_eq!(format_datetime("%b", &dt), "Jan");
    }

    #[test]
    fn format_abbrev_weekday() {
        let dt = epoch_to_datetime(0); // Thursday
        assert_eq!(format_datetime("%a", &dt), "Thu");
    }

    #[test]
    fn format_percent_literal() {
        let dt = epoch_to_datetime(0);
        assert_eq!(format_datetime("100%%", &dt), "100%");
    }

    #[test]
    fn format_day_of_year_jan1() {
        let dt = epoch_to_datetime(0);
        assert_eq!(format_datetime("%j", &dt), "001");
    }

    #[test]
    fn format_day_of_year_dec31_non_leap() {
        // 1970-12-31 = day 365
        let dt = epoch_to_datetime(86400 * 364);
        assert_eq!(format_datetime("%j", &dt), "365");
    }
}
