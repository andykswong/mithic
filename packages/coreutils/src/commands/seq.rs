use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    let mut fmt: Option<String> = None;
    let mut sep: Option<String> = None;
    let mut num_args: Vec<&str> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-f" | "--format" => {
                i += 1;
                if i < args.len() {
                    fmt = Some(args[i].to_string());
                }
            }
            "-s" | "--separator" => {
                i += 1;
                if i < args.len() {
                    sep = Some(args[i].to_string());
                }
            }
            a if a.starts_with("-f") && a.len() > 2 => {
                fmt = Some(a[2..].to_string());
            }
            a if a.starts_with("-s") && a.len() > 2 => {
                sep = Some(a[2..].to_string());
            }
            _ => num_args.push(args[i]),
        }
        i += 1;
    }

    let nums: Vec<f64> = num_args.iter().filter_map(|a| a.parse().ok()).collect();
    let (first, step, last) = match nums.len() {
        1 => (1.0f64, 1.0f64, nums[0]),
        2 => (nums[0], 1.0f64, nums[1]),
        3 => (nums[0], nums[1], nums[2]),
        _ => {
            write_stderr("seq: invalid usage\n");
            return 1;
        }
    };

    if step == 0.0 {
        write_stderr("seq: zero step\n");
        return 1;
    }

    let separator = sep.as_deref().unwrap_or("\n");
    let mut cur = first;
    let mut any = false;
    loop {
        if step > 0.0 && cur > last { break; }
        if step < 0.0 && cur < last { break; }
        if any {
            write_stdout(separator);
        }
        let num_str = if cur.fract() == 0.0 {
            format!("{}", cur as i64)
        } else {
            format!("{}", cur)
        };
        let s = match &fmt {
            Some(f) => apply_format(f, cur),
            None => num_str,
        };
        write_stdout(&s);
        cur += step;
        any = true;
    }
    if any {
        write_stdout("\n");
    } else {
        return 1;
    }
    0
}

fn apply_format(fmt: &str, val: f64) -> String {
    let mut result = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '%' && i + 1 < chars.len() {
            i += 1;
            // Collect flags: 0, -, +, space
            let mut zero_pad = false;
            let mut width = 0usize;
            let mut precision: Option<usize> = None;
            while i < chars.len() && (chars[i] == '0' || chars[i] == '-' || chars[i] == '+' || chars[i] == ' ') {
                if chars[i] == '0' { zero_pad = true; }
                i += 1;
            }
            // Width
            while i < chars.len() && chars[i].is_ascii_digit() {
                width = width * 10 + (chars[i] as usize - '0' as usize);
                i += 1;
            }
            // Precision
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                let mut prec = 0usize;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    prec = prec * 10 + (chars[i] as usize - '0' as usize);
                    i += 1;
                }
                precision = Some(prec);
            }
            if i < chars.len() {
                let spec = chars[i];
                i += 1;
                let formatted = match spec {
                    'g' | 'G' => {
                        if val.fract() == 0.0 {
                            format!("{}", val as i64)
                        } else {
                            format!("{}", val)
                        }
                    }
                    'f' | 'F' => {
                        let prec = precision.unwrap_or(6);
                        format!("{:.prec$}", val, prec = prec)
                    }
                    'e' | 'E' => {
                        format!("{:e}", val)
                    }
                    'd' | 'i' => {
                        format!("{}", val as i64)
                    }
                    _ => {
                        result.push('%');
                        result.push(spec);
                        continue;
                    }
                };
                if width > 0 && formatted.len() < width {
                    let pad = width - formatted.len();
                    if zero_pad {
                        result.push_str(&"0".repeat(pad));
                    } else {
                        result.push_str(&" ".repeat(pad));
                    }
                }
                result.push_str(&formatted);
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq_values(first: f64, step: f64, last: f64) -> Vec<String> {
        let mut result = Vec::new();
        let mut cur = first;
        loop {
            if step > 0.0 && cur > last { break; }
            if step < 0.0 && cur < last { break; }
            let s = if cur.fract() == 0.0 {
                format!("{}", cur as i64)
            } else {
                format!("{}", cur)
            };
            result.push(s);
            cur += step;
        }
        result
    }

    #[test]
    fn seq_one_arg_from_1() {
        assert_eq!(seq_values(1.0, 1.0, 3.0), vec!["1", "2", "3"]);
    }

    #[test]
    fn seq_two_args_range() {
        assert_eq!(seq_values(3.0, 1.0, 5.0), vec!["3", "4", "5"]);
    }

    #[test]
    fn seq_three_args_step() {
        assert_eq!(seq_values(1.0, 2.0, 6.0), vec!["1", "3", "5"]);
    }

    #[test]
    fn seq_decreasing() {
        assert_eq!(seq_values(5.0, -1.0, 3.0), vec!["5", "4", "3"]);
    }

    #[test]
    fn seq_empty_when_first_exceeds_last() {
        assert_eq!(seq_values(5.0, 1.0, 3.0), Vec::<String>::new());
    }

    #[test]
    fn seq_single_value() {
        assert_eq!(seq_values(7.0, 1.0, 7.0), vec!["7"]);
    }

    #[test]
    fn run_zero_args_returns_error() {
        assert_eq!(run(&[]), 1);
    }

    #[test]
    fn run_zero_step_returns_error() {
        assert_eq!(run(&["1", "0", "5"]), 1);
    }
}
