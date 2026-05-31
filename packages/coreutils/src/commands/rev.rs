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

#[cfg(test)]
mod tests {
    #[test]
    fn reverse_simple_string() {
        let s = "hello";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "olleh");
    }

    #[test]
    fn reverse_palindrome() {
        let s = "racecar";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, s);
    }

    #[test]
    fn reverse_numbers() {
        let s = "12345";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "54321");
    }

    #[test]
    fn reverse_empty_string() {
        let s = "";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "");
    }

    #[test]
    fn reverse_single_char() {
        let s = "x";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "x");
    }

    #[test]
    fn reverse_with_spaces() {
        let s = "hello world";
        let reversed: String = s.chars().rev().collect();
        assert_eq!(reversed, "dlrow olleh");
    }
}
