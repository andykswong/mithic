/// Arithmetic expression evaluator for `$(( expr ))`.
///
/// Public API:
///   `eval(expr, lookup, assign) -> i64`
///
/// `lookup` resolves variable names to i64 values.
/// `assign` is called for every assignment performed during evaluation.

pub fn eval(expr: &str, lookup: &dyn Fn(&str) -> i64, assign: &mut dyn FnMut(&str, i64)) -> i64 {
    let mut parser = ArithParser::new(expr, lookup, assign);
    parser.parse_expr()
}

struct ArithParser<'a> {
    chars: Vec<char>,
    pos: usize,
    lookup: &'a dyn Fn(&str) -> i64,
    assign: &'a mut dyn FnMut(&str, i64),
}

impl<'a> ArithParser<'a> {
    fn new(expr: &str, lookup: &'a dyn Fn(&str) -> i64, assign: &'a mut dyn FnMut(&str, i64)) -> Self {
        ArithParser { chars: expr.chars().collect(), pos: 0, lookup, assign }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn peek3(&self) -> Option<char> {
        self.chars.get(self.pos + 2).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if c.is_some() { self.pos += 1; }
        c
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t') | Some('\n')) {
            self.advance();
        }
    }

    /// Top-level: comma operator (lowest precedence).
    fn parse_expr(&mut self) -> i64 {
        let mut val = self.parse_assign();
        self.skip_whitespace();
        while self.peek() == Some(',') {
            self.advance();
            val = self.parse_assign();
            self.skip_whitespace();
        }
        val
    }

    /// Assignment: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `^=`, `|=`.
    fn parse_assign(&mut self) -> i64 {
        // We need lookahead: if this is a variable followed by an assignment op, handle it.
        // Otherwise fall through to ternary.
        let saved_pos = self.pos;
        self.skip_whitespace();

        // Try to read a variable name for potential assignment
        if let Some(name) = self.try_read_ident() {
            self.skip_whitespace();
            let op = self.peek_assign_op();
            if let Some(op_str) = op {
                // consume the operator
                for _ in 0..op_str.len() { self.advance(); }
                let rhs = self.parse_assign();
                let result = match op_str {
                    "=" => rhs,
                    "+=" => (self.lookup)(&name) + rhs,
                    "-=" => (self.lookup)(&name) - rhs,
                    "*=" => (self.lookup)(&name) * rhs,
                    "/=" => {
                        let lv = (self.lookup)(&name);
                        if rhs == 0 { 0 } else { lv / rhs }
                    }
                    "%=" => {
                        let lv = (self.lookup)(&name);
                        if rhs == 0 { 0 } else { lv % rhs }
                    }
                    "<<=" => (self.lookup)(&name) << rhs,
                    ">>=" => (self.lookup)(&name) >> rhs,
                    "&=" => (self.lookup)(&name) & rhs,
                    "^=" => (self.lookup)(&name) ^ rhs,
                    "|=" => (self.lookup)(&name) | rhs,
                    _ => rhs,
                };
                (self.assign)(&name, result);
                return result;
            }
        }

        // Not an assignment — restore and fall through to ternary
        self.pos = saved_pos;
        self.parse_ternary()
    }

    fn peek_assign_op(&self) -> Option<&'static str> {
        match (self.peek(), self.peek2(), self.peek3()) {
            (Some('<'), Some('<'), Some('=')) => Some("<<="),
            (Some('>'), Some('>'), Some('=')) => Some(">>="),
            (Some('+'), Some('='), _) => Some("+="),
            (Some('-'), Some('='), _) => Some("-="),
            (Some('*'), Some('='), _) => Some("*="),
            (Some('/'), Some('='), _) => Some("/="),
            (Some('%'), Some('='), _) => Some("%="),
            (Some('&'), Some('='), _) => Some("&="),
            (Some('^'), Some('='), _) => Some("^="),
            (Some('|'), Some('='), _) => Some("|="),
            (Some('='), c, _) if c != Some('=') => Some("="),
            _ => None,
        }
    }

    /// Try to read an identifier at the current position (skipping leading whitespace).
    /// Returns the identifier if found, and advances pos. Returns None and restores pos otherwise.
    fn try_read_ident(&mut self) -> Option<String> {
        self.skip_whitespace();
        let start = self.pos;
        match self.peek() {
            Some(c) if c.is_alphabetic() || c == '_' => {}
            _ => { self.pos = start; return None; }
        }
        let mut name = String::new();
        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '_' {
                name.push(c);
                self.advance();
            } else {
                break;
            }
        }
        if name.is_empty() {
            self.pos = start;
            None
        } else {
            Some(name)
        }
    }

    /// Ternary: `cond ? then : else`
    fn parse_ternary(&mut self) -> i64 {
        let cond = self.parse_or();
        self.skip_whitespace();
        if self.peek() == Some('?') {
            self.advance();
            let then_val = self.parse_assign();
            self.skip_whitespace();
            if self.peek() == Some(':') { self.advance(); }
            let else_val = self.parse_assign();
            if cond != 0 { then_val } else { else_val }
        } else {
            cond
        }
    }

    /// Logical OR: `||`
    fn parse_or(&mut self) -> i64 {
        let mut val = self.parse_and();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('|') && self.peek2() == Some('|') {
                self.advance(); self.advance();
                let rhs = self.parse_and();
                val = if val != 0 || rhs != 0 { 1 } else { 0 };
            } else {
                break;
            }
        }
        val
    }

    /// Logical AND: `&&`
    fn parse_and(&mut self) -> i64 {
        let mut val = self.parse_bitor();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('&') && self.peek2() == Some('&') {
                self.advance(); self.advance();
                let rhs = self.parse_bitor();
                val = if val != 0 && rhs != 0 { 1 } else { 0 };
            } else {
                break;
            }
        }
        val
    }

    /// Bitwise OR: `|`
    fn parse_bitor(&mut self) -> i64 {
        let mut val = self.parse_bitxor();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('|') && self.peek2() != Some('|') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_bitxor();
                val |= rhs;
            } else {
                break;
            }
        }
        val
    }

    /// Bitwise XOR: `^`
    fn parse_bitxor(&mut self) -> i64 {
        let mut val = self.parse_bitand();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('^') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_bitand();
                val ^= rhs;
            } else {
                break;
            }
        }
        val
    }

    /// Bitwise AND: `&`
    fn parse_bitand(&mut self) -> i64 {
        let mut val = self.parse_equality();
        loop {
            self.skip_whitespace();
            if self.peek() == Some('&') && self.peek2() != Some('&') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_equality();
                val &= rhs;
            } else {
                break;
            }
        }
        val
    }

    /// Equality: `==`, `!=`
    fn parse_equality(&mut self) -> i64 {
        let mut val = self.parse_relational();
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('='), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_relational();
                    val = if val == rhs { 1 } else { 0 };
                }
                (Some('!'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_relational();
                    val = if val != rhs { 1 } else { 0 };
                }
                _ => break,
            }
        }
        val
    }

    /// Relational: `<`, `>`, `<=`, `>=`
    fn parse_relational(&mut self) -> i64 {
        let mut val = self.parse_shift();
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('<'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_shift();
                    val = if val <= rhs { 1 } else { 0 };
                }
                (Some('>'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_shift();
                    val = if val >= rhs { 1 } else { 0 };
                }
                (Some('<'), Some(c)) if c != '<' && c != '=' => {
                    self.advance();
                    let rhs = self.parse_shift();
                    val = if val < rhs { 1 } else { 0 };
                }
                (Some('<'), None) => {
                    self.advance();
                    let rhs = self.parse_shift();
                    val = if val < rhs { 1 } else { 0 };
                }
                (Some('>'), Some(c)) if c != '>' && c != '=' => {
                    self.advance();
                    let rhs = self.parse_shift();
                    val = if val > rhs { 1 } else { 0 };
                }
                (Some('>'), None) => {
                    self.advance();
                    let rhs = self.parse_shift();
                    val = if val > rhs { 1 } else { 0 };
                }
                _ => break,
            }
        }
        val
    }

    /// Shift: `<<`, `>>`
    fn parse_shift(&mut self) -> i64 {
        let mut val = self.parse_additive();
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('<'), Some('<')) if self.peek3() != Some('=') => {
                    self.advance(); self.advance();
                    let rhs = self.parse_additive();
                    val <<= rhs;
                }
                (Some('>'), Some('>')) if self.peek3() != Some('=') => {
                    self.advance(); self.advance();
                    let rhs = self.parse_additive();
                    val >>= rhs;
                }
                _ => break,
            }
        }
        val
    }

    /// Additive: `+`, `-`
    fn parse_additive(&mut self) -> i64 {
        let mut val = self.parse_multiplicative();
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('+') if self.peek2() != Some('+') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_multiplicative();
                    val += rhs;
                }
                Some('-') if self.peek2() != Some('-') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_multiplicative();
                    val -= rhs;
                }
                _ => break,
            }
        }
        val
    }

    /// Multiplicative: `*`, `/`, `%`
    fn parse_multiplicative(&mut self) -> i64 {
        let mut val = self.parse_power();
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') if self.peek2() != Some('*') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power();
                    val *= rhs;
                }
                Some('/') if self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power();
                    val = if rhs == 0 { 0 } else { val / rhs };
                }
                Some('%') if self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power();
                    val = if rhs == 0 { 0 } else { val % rhs };
                }
                _ => break,
            }
        }
        val
    }

    /// Power: `**` (right-associative)
    fn parse_power(&mut self) -> i64 {
        let base = self.parse_unary();
        self.skip_whitespace();
        if self.peek() == Some('*') && self.peek2() == Some('*') {
            self.advance(); self.advance();
            let exp = self.parse_power(); // right-associative
            if exp < 0 { return 0; }
            base.pow(exp as u32)
        } else {
            base
        }
    }

    /// Unary: `-`, `+`, `!`, `~`, `++x`, `--x`
    fn parse_unary(&mut self) -> i64 {
        self.skip_whitespace();
        match (self.peek(), self.peek2()) {
            (Some('+'), Some('+')) => {
                self.advance(); self.advance();
                self.skip_whitespace();
                if let Some(name) = self.try_read_ident() {
                    let val = (self.lookup)(&name) + 1;
                    (self.assign)(&name, val);
                    val
                } else {
                    0
                }
            }
            (Some('-'), Some('-')) => {
                self.advance(); self.advance();
                self.skip_whitespace();
                if let Some(name) = self.try_read_ident() {
                    let val = (self.lookup)(&name) - 1;
                    (self.assign)(&name, val);
                    val
                } else {
                    0
                }
            }
            (Some('-'), _) => {
                self.advance();
                -self.parse_unary()
            }
            (Some('+'), _) => {
                self.advance();
                self.parse_unary()
            }
            (Some('!'), _) => {
                self.advance();
                let v = self.parse_unary();
                if v == 0 { 1 } else { 0 }
            }
            (Some('~'), _) => {
                self.advance();
                !self.parse_unary()
            }
            _ => self.parse_postfix(),
        }
    }

    /// Postfix: `x++`, `x--`
    fn parse_postfix(&mut self) -> i64 {
        let val = self.parse_primary();
        // We can only do post-increment on variables; the primary already consumed the var.
        // We need to track what was consumed — use a different approach: save position before
        // primary and check if it was a bare identifier followed by ++ or --.
        // Since parse_primary already consumed the ident, we check peek here.
        // If the primary was a variable read, val is its current value.
        // We just return val and check if ++ or -- follows (in which case we need the name).
        // This is handled below by re-reading in parse_primary via a flag approach.
        // For simplicity, post-increment is handled in parse_primary directly.
        val
    }

    /// Primary: number literal, variable, or parenthesized expression.
    fn parse_primary(&mut self) -> i64 {
        self.skip_whitespace();
        match self.peek() {
            Some('(') => {
                self.advance();
                let val = self.parse_expr();
                self.skip_whitespace();
                if self.peek() == Some(')') { self.advance(); }
                val
            }
            Some(c) if c.is_ascii_digit() => self.read_number(),
            Some(c) if c.is_alphabetic() || c == '_' => {
                let name = self.read_ident();
                self.skip_whitespace();
                // Check for post-increment / post-decrement
                match (self.peek(), self.peek2()) {
                    (Some('+'), Some('+')) => {
                        self.advance(); self.advance();
                        let old = (self.lookup)(&name);
                        (self.assign)(&name, old + 1);
                        old
                    }
                    (Some('-'), Some('-')) => {
                        self.advance(); self.advance();
                        let old = (self.lookup)(&name);
                        (self.assign)(&name, old - 1);
                        old
                    }
                    _ => (self.lookup)(&name),
                }
            }
            _ => 0,
        }
    }

    fn read_number(&mut self) -> i64 {
        let mut s = String::new();
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                s.push(c);
                self.advance();
            } else {
                break;
            }
        }
        s.parse().unwrap_or(0)
    }

    fn read_ident(&mut self) -> String {
        let mut name = String::new();
        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '_' {
                name.push(c);
                self.advance();
            } else {
                break;
            }
        }
        name
    }
}

#[cfg(test)]
mod tests {
    use super::eval;
    use std::collections::HashMap;

    fn ev(expr: &str) -> i64 {
        let vars: HashMap<String, i64> = HashMap::new();
        eval(expr, &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {})
    }

    fn ev_vars(expr: &str, vars: &HashMap<String, i64>) -> i64 {
        eval(expr, &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {})
    }

    fn ev_with_assigns(expr: &str, vars: &HashMap<String, i64>) -> (i64, HashMap<String, i64>) {
        let mut assignments: HashMap<String, i64> = HashMap::new();
        let result = eval(
            expr,
            &|name| *vars.get(name).unwrap_or(&0),
            &mut |name, val| { assignments.insert(name.to_string(), val); },
        );
        (result, assignments)
    }

    #[test]
    fn test_basic_addition() {
        assert_eq!(ev("1 + 2"), 3);
        assert_eq!(ev("10 + 5"), 15);
    }

    #[test]
    fn test_basic_subtraction() {
        assert_eq!(ev("5 - 3"), 2);
        assert_eq!(ev("0 - 1"), -1);
    }

    #[test]
    fn test_basic_multiplication() {
        assert_eq!(ev("3 * 4"), 12);
    }

    #[test]
    fn test_basic_division() {
        assert_eq!(ev("10 / 2"), 5);
        assert_eq!(ev("7 / 2"), 3);
    }

    #[test]
    fn test_modulo() {
        assert_eq!(ev("7 % 3"), 1);
    }

    #[test]
    fn test_operator_precedence() {
        assert_eq!(ev("2 + 3 * 4"), 14);
        assert_eq!(ev("10 - 2 * 3"), 4);
        assert_eq!(ev("(2 + 3) * 4"), 20);
    }

    #[test]
    fn test_power() {
        assert_eq!(ev("2 ** 8"), 256);
        assert_eq!(ev("2 ** 0"), 1);
        assert_eq!(ev("3 ** 3"), 27);
    }

    #[test]
    fn test_power_right_associative() {
        // 2 ** 3 ** 2 == 2 ** (3**2) == 2 ** 9 == 512
        assert_eq!(ev("2 ** 3 ** 2"), 512);
    }

    #[test]
    fn test_comparison_gt() {
        assert_eq!(ev("5 > 3"), 1);
        assert_eq!(ev("3 > 5"), 0);
        assert_eq!(ev("3 > 3"), 0);
    }

    #[test]
    fn test_comparison_lt() {
        assert_eq!(ev("3 < 5"), 1);
        assert_eq!(ev("5 < 3"), 0);
    }

    #[test]
    fn test_comparison_ge() {
        assert_eq!(ev("5 >= 5"), 1);
        assert_eq!(ev("5 >= 3"), 1);
        assert_eq!(ev("3 >= 5"), 0);
    }

    #[test]
    fn test_comparison_le() {
        assert_eq!(ev("3 <= 5"), 1);
        assert_eq!(ev("5 <= 5"), 1);
        assert_eq!(ev("5 <= 3"), 0);
    }

    #[test]
    fn test_equality() {
        assert_eq!(ev("2 == 2"), 1);
        assert_eq!(ev("2 == 3"), 0);
        assert_eq!(ev("2 != 3"), 1);
        assert_eq!(ev("2 != 2"), 0);
    }

    #[test]
    fn test_logical_and() {
        assert_eq!(ev("1 && 1"), 1);
        assert_eq!(ev("1 && 0"), 0);
        assert_eq!(ev("0 && 1"), 0);
    }

    #[test]
    fn test_logical_or() {
        assert_eq!(ev("0 || 1"), 1);
        assert_eq!(ev("1 || 0"), 1);
        assert_eq!(ev("0 || 0"), 0);
    }

    #[test]
    fn test_bitwise_and() {
        assert_eq!(ev("6 & 3"), 2);
        assert_eq!(ev("12 & 10"), 8);
    }

    #[test]
    fn test_bitwise_or() {
        assert_eq!(ev("6 | 3"), 7);
    }

    #[test]
    fn test_bitwise_xor() {
        assert_eq!(ev("6 ^ 3"), 5);
    }

    #[test]
    fn test_shift() {
        assert_eq!(ev("1 << 4"), 16);
        assert_eq!(ev("16 >> 2"), 4);
    }

    #[test]
    fn test_ternary() {
        assert_eq!(ev("1 ? 42 : 99"), 42);
        assert_eq!(ev("0 ? 42 : 99"), 99);
    }

    #[test]
    fn test_unary_minus() {
        assert_eq!(ev("-5"), -5);
        assert_eq!(ev("-(3 + 2)"), -5);
    }

    #[test]
    fn test_unary_plus() {
        assert_eq!(ev("+5"), 5);
    }

    #[test]
    fn test_logical_not() {
        assert_eq!(ev("!0"), 1);
        assert_eq!(ev("!1"), 0);
        assert_eq!(ev("!5"), 0);
    }

    #[test]
    fn test_bitwise_not() {
        assert_eq!(ev("~0"), -1);
        assert_eq!(ev("~(-1)"), 0);
    }

    #[test]
    fn test_variables() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 10i64);
        vars.insert("y".to_string(), 3i64);
        assert_eq!(ev_vars("x + y", &vars), 13);
        assert_eq!(ev_vars("x * y", &vars), 30);
        assert_eq!(ev_vars("x - y", &vars), 7);
    }

    #[test]
    fn test_undefined_variable_is_zero() {
        let vars = HashMap::new();
        assert_eq!(ev_vars("undefined + 1", &vars), 1);
    }

    #[test]
    fn test_assignment() {
        let vars = HashMap::new();
        let (result, assigns) = ev_with_assigns("x = 7", &vars);
        assert_eq!(result, 7);
        assert_eq!(assigns.get("x"), Some(&7));
    }

    #[test]
    fn test_compound_assignment_add() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 5i64);
        let (result, assigns) = ev_with_assigns("x += 3", &vars);
        assert_eq!(result, 8);
        assert_eq!(assigns.get("x"), Some(&8));
    }

    #[test]
    fn test_compound_assignment_sub() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 10i64);
        let (result, assigns) = ev_with_assigns("x -= 4", &vars);
        assert_eq!(result, 6);
        assert_eq!(assigns.get("x"), Some(&6));
    }

    #[test]
    fn test_compound_assignment_mul() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 3i64);
        let (result, assigns) = ev_with_assigns("x *= 4", &vars);
        assert_eq!(result, 12);
        assert_eq!(assigns.get("x"), Some(&12));
    }

    #[test]
    fn test_pre_increment() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 5i64);
        let (result, assigns) = ev_with_assigns("++x", &vars);
        assert_eq!(result, 6);
        assert_eq!(assigns.get("x"), Some(&6));
    }

    #[test]
    fn test_pre_decrement() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 5i64);
        let (result, assigns) = ev_with_assigns("--x", &vars);
        assert_eq!(result, 4);
        assert_eq!(assigns.get("x"), Some(&4));
    }

    #[test]
    fn test_post_increment() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 5i64);
        let (result, assigns) = ev_with_assigns("x++", &vars);
        assert_eq!(result, 5); // old value returned
        assert_eq!(assigns.get("x"), Some(&6));
    }

    #[test]
    fn test_post_decrement() {
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 5i64);
        let (result, assigns) = ev_with_assigns("x--", &vars);
        assert_eq!(result, 5); // old value returned
        assert_eq!(assigns.get("x"), Some(&4));
    }

    #[test]
    fn test_comma_operator() {
        // comma evaluates both sides and returns last
        assert_eq!(ev("1, 2, 3"), 3);
    }

    #[test]
    fn test_nested_parens() {
        assert_eq!(ev("((3 + 4) * 2)"), 14);
        assert_eq!(ev("(2 + (3 * (1 + 1)))"), 8);
    }

    #[test]
    fn test_division_by_zero() {
        assert_eq!(ev("5 / 0"), 0); // graceful: returns 0
        assert_eq!(ev("5 % 0"), 0);
    }
}
