use super::{write_stdout, read_stdin_all, dispatch};

pub fn run(args: &[&str]) -> u8 {
    let cmd = args.first().copied().unwrap_or("echo");
    let cmd_extra_args: &[&str] = if args.is_empty() { &[] } else { &args[1..] };

    let data = read_stdin_all();
    let text = String::from_utf8_lossy(&data);
    let words: Vec<&str> = text.split_whitespace().collect();

    if words.is_empty() {
        return 0;
    }

    let mut all_args: Vec<&str> = cmd_extra_args.to_vec();
    all_args.extend(words.iter().copied());

    match cmd {
        "echo" => {
            write_stdout(&all_args.join(" "));
            write_stdout("\n");
            0
        }
        known => dispatch(known, &all_args),
    }
}
