use super::{write_stdout, write_stderr};

pub fn run(args: &[&str]) -> u8 {
    let nums: Vec<f64> = args.iter().filter_map(|a| a.parse().ok()).collect();
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

    let mut cur = first;
    let mut any = false;
    loop {
        if step > 0.0 && cur > last { break; }
        if step < 0.0 && cur < last { break; }
        let s = if cur.fract() == 0.0 {
            format!("{}", cur as i64)
        } else {
            format!("{}", cur)
        };
        write_stdout(&s);
        write_stdout("\n");
        cur += step;
        any = true;
    }
    if !any { return 1; }
    0
}
