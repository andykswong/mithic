use crate::runtime::Runtime;
use crate::shell::Shell;
use crate::executor::expansion::glob_match_ext;
use crate::value::ShellValue;

impl<R: Runtime> Shell<R> {
    pub(crate) fn eval_test(&self, args: &[String]) -> bool {
        if args.is_empty() { return false; }

        if args[0] == "!" {
            return !self.eval_test(&args[1..]);
        }

        if args.len() == 1 {
            return !args[0].is_empty();
        }

        if args.len() == 2 {
            let op = args[0].as_str();
            let val = &args[1];
            return match op {
                "-z" => val.is_empty(),
                "-n" => !val.is_empty(),
                "-e" | "-f" | "-d" | "-r" | "-w" | "-x" => self.test_file(op, val),
                _ => false,
            };
        }

        if args.len() == 3 {
            let left = &args[0];
            let op = args[1].as_str();
            let right = &args[2];
            return match op {
                "=" | "==" => left == right,
                "!=" => left != right,
                "-eq" => self.parse_int(left) == self.parse_int(right),
                "-ne" => self.parse_int(left) != self.parse_int(right),
                "-lt" => self.parse_int(left) < self.parse_int(right),
                "-gt" => self.parse_int(left) > self.parse_int(right),
                "-le" => self.parse_int(left) <= self.parse_int(right),
                "-ge" => self.parse_int(left) >= self.parse_int(right),
                "-a" => self.eval_test(&args[..1]) && self.eval_test(&args[2..]),
                "-o" => self.eval_test(&args[..1]) || self.eval_test(&args[2..]),
                _ => false,
            };
        }

        for i in 0..args.len() {
            if args[i] == "-a" {
                return self.eval_test(&args[..i]) && self.eval_test(&args[i+1..]);
            }
        }
        for i in 0..args.len() {
            if args[i] == "-o" {
                return self.eval_test(&args[..i]) || self.eval_test(&args[i+1..]);
            }
        }

        false
    }

    pub(crate) fn parse_int(&self, s: &str) -> i64 {
        s.parse().unwrap_or(0)
    }

    pub(crate) fn test_file(&self, op: &str, path: &str) -> bool {
        use crate::runtime::FileType;
        let resolved = self.resolve_path(path);
        match op {
            "-e" | "-r" | "-w" | "-x" => self.rt.file_exists(&resolved),
            "-f" => self.rt.file_type(&resolved) == FileType::Regular,
            "-d" => self.rt.file_type(&resolved) == FileType::Directory,
            _ => false,
        }
    }

    pub(crate) fn eval_extended_test(&mut self, args: &[String]) -> bool {
        if args.is_empty() { return false; }

        if args[0] == "!" {
            return !self.eval_extended_test(&args[1..].to_vec());
        }

        for i in 0..args.len() {
            if args[i] == "&&" {
                let left = args[..i].to_vec();
                let right = args[i+1..].to_vec();
                return self.eval_extended_test(&left) && self.eval_extended_test(&right);
            }
        }
        for i in 0..args.len() {
            if args[i] == "||" {
                let left = args[..i].to_vec();
                let right = args[i+1..].to_vec();
                return self.eval_extended_test(&left) || self.eval_extended_test(&right);
            }
        }

        if args.len() == 1 {
            return !args[0].is_empty();
        }

        if args.len() == 2 {
            return match args[0].as_str() {
                "-z" => args[1].is_empty(),
                "-n" => !args[1].is_empty(),
                "-e" | "-f" | "-d" | "-r" | "-w" | "-x" => self.test_file(&args[0], &args[1]),
                _ => false,
            };
        }

        if args.len() == 3 {
            let left = args[0].clone();
            let op = args[1].as_str().to_string();
            let right = args[2].clone();
            return match op.as_str() {
                "==" | "=" => glob_match_ext(&right, &left, self.options.extglob),
                "!=" => !glob_match_ext(&right, &left, self.options.extglob),
                "<" => left < right,
                ">" => left > right,
                "-eq" => self.parse_int(&left) == self.parse_int(&right),
                "-ne" => self.parse_int(&left) != self.parse_int(&right),
                "-lt" => self.parse_int(&left) < self.parse_int(&right),
                "-gt" => self.parse_int(&left) > self.parse_int(&right),
                "-le" => self.parse_int(&left) <= self.parse_int(&right),
                "-ge" => self.parse_int(&left) >= self.parse_int(&right),
                "=~" => {
                    let m = crate::regex::regex_match(&left, &right);
                    self.env.insert(
                        "BASH_REMATCH".to_string(),
                        ShellValue::Array(if m.matched { m.groups } else { vec![] }),
                    );
                    m.matched
                }
                _ => false,
            };
        }

        false
    }
}
