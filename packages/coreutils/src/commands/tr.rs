use super::{write_stdout, read_stdin_all, expand_char_set};

pub fn run(args: &[&str]) -> u8 {
    let mut delete = false;
    let mut sets: Vec<&str> = Vec::new();

    for &arg in args {
        match arg {
            "-d" => delete = true,
            "-s" => {}
            a if a.starts_with('-') => {}
            _ => sets.push(arg),
        }
    }

    let data = read_stdin_all();
    let text = String::from_utf8_lossy(&data).into_owned();

    if delete {
        let set1 = sets.first().copied().unwrap_or("");
        let del_chars: Vec<char> = expand_char_set(set1);
        let result: String = text.chars().filter(|c| !del_chars.contains(c)).collect();
        write_stdout(&result);
    } else if sets.len() >= 2 {
        let from = expand_char_set(sets[0]);
        let to = expand_char_set(sets[1]);
        let result: String = text.chars().map(|c| {
            if let Some(idx) = from.iter().position(|&f| f == c) {
                *to.get(idx).unwrap_or(to.last().unwrap_or(&c))
            } else {
                c
            }
        }).collect();
        write_stdout(&result);
    } else {
        write_stdout(&text);
    }
    0
}
