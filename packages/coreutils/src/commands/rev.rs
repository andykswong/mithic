use super::{write_stdout, read_input, lines_of};

pub fn run(args: &[&str]) -> u8 {
    let (data, errors) = read_input(args);
    let lines = lines_of(&data);
    for line in lines {
        let reversed: String = line.chars().rev().collect();
        write_stdout(&reversed);
        write_stdout("\n");
    }
    errors
}
