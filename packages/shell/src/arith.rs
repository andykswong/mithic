/// Arithmetic expression evaluator for `$(( expr ))`.
///
/// Public API:
///   `eval(expr, lookup, assign) -> Result<i64, String>`
///
/// `lookup` resolves variable names to i64 values.
/// `assign` is called for every assignment performed during evaluation.

pub fn eval(expr: &str, lookup: &dyn Fn(&str) -> i64, assign: &mut dyn FnMut(&str, i64)) -> Result<i64, String> {
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
    fn parse_expr(&mut self) -> Result<i64, String> {
        let mut val = self.parse_assign()?;
        self.skip_whitespace();
        while self.peek() == Some(',') {
            self.advance();
            val = self.parse_assign()?;
            self.skip_whitespace();
        }
        Ok(val)
    }

    /// Assignment: `=`, `+=`, `-=`, `*=`, `/=`, `%=`, `<<=`, `>>=`, `&=`, `^=`, `|=`.
    fn parse_assign(&mut self) -> Result<i64, String> {
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
                let rhs = self.parse_assign()?;
                let result = match op_str {
                    "=" => rhs,
                    "+=" => (self.lookup)(&name).wrapping_add(rhs),
                    "-=" => (self.lookup)(&name).wrapping_sub(rhs),
                    "*=" => (self.lookup)(&name).wrapping_mul(rhs),
                    "/=" => {
                        let lv = (self.lookup)(&name);
                        if rhs == 0 {
                            return Err(format!("division by 0 (error token is \"{}\")", rhs));
                        }
                        lv / rhs
                    }
                    "%=" => {
                        let lv = (self.lookup)(&name);
                        if rhs == 0 {
                            return Err(format!("division by 0 (error token is \"{}\")", rhs));
                        }
                        lv % rhs
                    }
                    "<<=" => (self.lookup)(&name).wrapping_shl((rhs as u32) & 63),
                    ">>=" => (self.lookup)(&name).wrapping_shr((rhs as u32) & 63),
                    "&=" => (self.lookup)(&name) & rhs,
                    "^=" => (self.lookup)(&name) ^ rhs,
                    "|=" => (self.lookup)(&name) | rhs,
                    _ => rhs,
                };
                (self.assign)(&name, result);
                return Ok(result);
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
    fn parse_ternary(&mut self) -> Result<i64, String> {
        let cond = self.parse_or()?;
        self.skip_whitespace();
        if self.peek() == Some('?') {
            self.advance();
            let then_val = self.parse_assign()?;
            self.skip_whitespace();
            if self.peek() == Some(':') { self.advance(); }
            let else_val = self.parse_assign()?;
            Ok(if cond != 0 { then_val } else { else_val })
        } else {
            Ok(cond)
        }
    }

    /// Logical OR: `||`
    fn parse_or(&mut self) -> Result<i64, String> {
        let mut val = self.parse_and()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some('|') && self.peek2() == Some('|') {
                self.advance(); self.advance();
                let rhs = self.parse_and()?;
                val = if val != 0 || rhs != 0 { 1 } else { 0 };
            } else {
                break;
            }
        }
        Ok(val)
    }

    /// Logical AND: `&&`
    fn parse_and(&mut self) -> Result<i64, String> {
        let mut val = self.parse_bitor()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some('&') && self.peek2() == Some('&') {
                self.advance(); self.advance();
                let rhs = self.parse_bitor()?;
                val = if val != 0 && rhs != 0 { 1 } else { 0 };
            } else {
                break;
            }
        }
        Ok(val)
    }

    /// Bitwise OR: `|`
    fn parse_bitor(&mut self) -> Result<i64, String> {
        let mut val = self.parse_bitxor()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some('|') && self.peek2() != Some('|') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_bitxor()?;
                val |= rhs;
            } else {
                break;
            }
        }
        Ok(val)
    }

    /// Bitwise XOR: `^`
    fn parse_bitxor(&mut self) -> Result<i64, String> {
        let mut val = self.parse_bitand()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some('^') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_bitand()?;
                val ^= rhs;
            } else {
                break;
            }
        }
        Ok(val)
    }

    /// Bitwise AND: `&`
    fn parse_bitand(&mut self) -> Result<i64, String> {
        let mut val = self.parse_equality()?;
        loop {
            self.skip_whitespace();
            if self.peek() == Some('&') && self.peek2() != Some('&') && self.peek2() != Some('=') {
                self.advance();
                let rhs = self.parse_equality()?;
                val &= rhs;
            } else {
                break;
            }
        }
        Ok(val)
    }

    /// Equality: `==`, `!=`
    fn parse_equality(&mut self) -> Result<i64, String> {
        let mut val = self.parse_relational()?;
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('='), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_relational()?;
                    val = if val == rhs { 1 } else { 0 };
                }
                (Some('!'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_relational()?;
                    val = if val != rhs { 1 } else { 0 };
                }
                _ => break,
            }
        }
        Ok(val)
    }

    /// Relational: `<`, `>`, `<=`, `>=`
    fn parse_relational(&mut self) -> Result<i64, String> {
        let mut val = self.parse_shift()?;
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('<'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val <= rhs { 1 } else { 0 };
                }
                (Some('>'), Some('=')) => {
                    self.advance(); self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val >= rhs { 1 } else { 0 };
                }
                (Some('<'), Some(c)) if c != '<' && c != '=' => {
                    self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val < rhs { 1 } else { 0 };
                }
                (Some('<'), None) => {
                    self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val < rhs { 1 } else { 0 };
                }
                (Some('>'), Some(c)) if c != '>' && c != '=' => {
                    self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val > rhs { 1 } else { 0 };
                }
                (Some('>'), None) => {
                    self.advance();
                    let rhs = self.parse_shift()?;
                    val = if val > rhs { 1 } else { 0 };
                }
                _ => break,
            }
        }
        Ok(val)
    }

    /// Shift: `<<`, `>>`
    fn parse_shift(&mut self) -> Result<i64, String> {
        let mut val = self.parse_additive()?;
        loop {
            self.skip_whitespace();
            match (self.peek(), self.peek2()) {
                (Some('<'), Some('<')) if self.peek3() != Some('=') => {
                    self.advance(); self.advance();
                    let rhs = self.parse_additive()?;
                    val = val.wrapping_shl((rhs as u32) & 63);
                }
                (Some('>'), Some('>')) if self.peek3() != Some('=') => {
                    self.advance(); self.advance();
                    let rhs = self.parse_additive()?;
                    val = val.wrapping_shr((rhs as u32) & 63);
                }
                _ => break,
            }
        }
        Ok(val)
    }

    /// Additive: `+`, `-`
    fn parse_additive(&mut self) -> Result<i64, String> {
        let mut val = self.parse_multiplicative()?;
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('+') if self.peek2() != Some('+') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_multiplicative()?;
                    val = val.wrapping_add(rhs);
                }
                Some('-') if self.peek2() != Some('-') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_multiplicative()?;
                    val = val.wrapping_sub(rhs);
                }
                _ => break,
            }
        }
        Ok(val)
    }

    /// Multiplicative: `*`, `/`, `%`
    fn parse_multiplicative(&mut self) -> Result<i64, String> {
        let mut val = self.parse_power()?;
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some('*') if self.peek2() != Some('*') && self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power()?;
                    val = val.wrapping_mul(rhs);
                }
                Some('/') if self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power()?;
                    if rhs == 0 {
                        return Err(format!("division by 0 (error token is \"{}\")", rhs));
                    }
                    val /= rhs;
                }
                Some('%') if self.peek2() != Some('=') => {
                    self.advance();
                    let rhs = self.parse_power()?;
                    if rhs == 0 {
                        return Err(format!("division by 0 (error token is \"{}\")", rhs));
                    }
                    val %= rhs;
                }
                _ => break,
            }
        }
        Ok(val)
    }

    /// Power: `**` (right-associative)
    fn parse_power(&mut self) -> Result<i64, String> {
        let base = self.parse_unary()?;
        self.skip_whitespace();
        if self.peek() == Some('*') && self.peek2() == Some('*') {
            self.advance(); self.advance();
            let exp = self.parse_power()?; // right-associative
            if exp < 0 { return Ok(0); }
            Ok(base.pow(exp as u32))
        } else {
            Ok(base)
        }
    }

    /// Unary: `-`, `+`, `!`, `~`, `++x`, `--x`
    fn parse_unary(&mut self) -> Result<i64, String> {
        self.skip_whitespace();
        match (self.peek(), self.peek2()) {
            (Some('+'), Some('+')) => {
                self.advance(); self.advance();
                self.skip_whitespace();
                if let Some(name) = self.try_read_ident() {
                    let val = (self.lookup)(&name).wrapping_add(1);
                    (self.assign)(&name, val);
                    Ok(val)
                } else {
                    Ok(0)
                }
            }
            (Some('-'), Some('-')) => {
                self.advance(); self.advance();
                self.skip_whitespace();
                if let Some(name) = self.try_read_ident() {
                    let val = (self.lookup)(&name).wrapping_sub(1);
                    (self.assign)(&name, val);
                    Ok(val)
                } else {
                    Ok(0)
                }
            }
            (Some('-'), _) => {
                self.advance();
                Ok(-self.parse_unary()?)
            }
            (Some('+'), _) => {
                self.advance();
                self.parse_unary()
            }
            (Some('!'), _) => {
                self.advance();
                let v = self.parse_unary()?;
                Ok(if v == 0 { 1 } else { 0 })
            }
            (Some('~'), _) => {
                self.advance();
                Ok(!self.parse_unary()?)
            }
            _ => self.parse_primary(),
        }
    }

    /// Primary: number literal, variable, or parenthesized expression.
    fn parse_primary(&mut self) -> Result<i64, String> {
        self.skip_whitespace();
        match self.peek() {
            Some('(') => {
                self.advance();
                let val = self.parse_expr()?;
                self.skip_whitespace();
                if self.peek() == Some(')') { self.advance(); }
                Ok(val)
            }
            Some(c) if c.is_ascii_digit() => Ok(self.read_number()),
            Some(c) if c.is_alphabetic() || c == '_' => {
                let name = self.read_ident();
                self.skip_whitespace();
                // Check for post-increment / post-decrement
                match (self.peek(), self.peek2()) {
                    (Some('+'), Some('+')) => {
                        self.advance(); self.advance();
                        let old = (self.lookup)(&name);
                        (self.assign)(&name, old.wrapping_add(1));
                        Ok(old)
                    }
                    (Some('-'), Some('-')) => {
                        self.advance(); self.advance();
                        let old = (self.lookup)(&name);
                        (self.assign)(&name, old.wrapping_sub(1));
                        Ok(old)
                    }
                    _ => Ok((self.lookup)(&name)),
                }
            }
            _ => Ok(0),
        }
    }

    fn read_number(&mut self) -> i64 {
        // Check for hex: 0x or 0X
        if self.peek() == Some('0') && matches!(self.peek2(), Some('x') | Some('X')) {
            self.advance(); // consume '0'
            self.advance(); // consume 'x' or 'X'
            let mut s = String::new();
            while let Some(c) = self.peek() {
                if c.is_ascii_hexdigit() {
                    s.push(c);
                    self.advance();
                } else {
                    break;
                }
            }
            return i64::from_str_radix(&s, 16).unwrap_or(0);
        }

        // Check for octal: starts with '0' followed by more digits
        if self.peek() == Some('0') && matches!(self.peek2(), Some('0'..='7')) {
            self.advance(); // consume leading '0'
            let mut s = String::new();
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    s.push(c);
                    self.advance();
                } else {
                    break;
                }
            }
            return i64::from_str_radix(&s, 8).unwrap_or(0);
        }

        // Decimal
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
        eval(expr, &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {}).unwrap()
    }

    fn ev_vars(expr: &str, vars: &HashMap<String, i64>) -> i64 {
        eval(expr, &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {}).unwrap()
    }

    fn ev_with_assigns(expr: &str, vars: &HashMap<String, i64>) -> (i64, HashMap<String, i64>) {
        let mut assignments: HashMap<String, i64> = HashMap::new();
        let result = eval(
            expr,
            &|name| *vars.get(name).unwrap_or(&0),
            &mut |name, val| { assignments.insert(name.to_string(), val); },
        ).unwrap();
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
    fn test_division_by_zero_error() {
        let vars: HashMap<String, i64> = HashMap::new();
        let result = eval("5 / 0", &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {});
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("division by 0"));
    }

    #[test]
    fn test_modulo_by_zero_error() {
        let vars: HashMap<String, i64> = HashMap::new();
        let result = eval("5 % 0", &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn test_hex_literal() {
        assert_eq!(ev("0xFF"), 255);
        assert_eq!(ev("0x10"), 16);
        assert_eq!(ev("0XA"), 10);
    }

    #[test]
    fn test_octal_literal() {
        assert_eq!(ev("010"), 8);
        assert_eq!(ev("077"), 63);
        assert_eq!(ev("0"), 0);
    }

    #[test]
    fn test_nested_div_by_zero() {
        let vars: HashMap<String, i64> = HashMap::new();
        let result = eval("1 + 2 / 0", &|name| *vars.get(name).unwrap_or(&0), &mut |_, _| {});
        assert!(result.is_err());
    }

    #[test]
    fn test_shift_by_64_wraps() {
        // 1 << 64 should wrap (equivalent to 1 << 0 = 1 with masking)
        assert_eq!(ev("1 << 64"), 1);
    }

    #[test]
    fn test_shift_by_63() {
        // 1 << 63 should produce i64::MIN (sign bit set)
        assert_eq!(ev("1 << 63"), i64::MIN);
    }

    #[test]
    fn test_overflow_add() {
        // i64::MAX + 1 should wrap to i64::MIN
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MAX);
        assert_eq!(ev_vars("x + 1", &vars), i64::MIN);
    }

    #[test]
    fn test_overflow_sub() {
        // i64::MIN - 1 should wrap to i64::MAX
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MIN);
        assert_eq!(ev_vars("x - 1", &vars), i64::MAX);
    }

    #[test]
    fn test_overflow_mul() {
        // i64::MAX * 2 should wrap
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MAX);
        assert_eq!(ev_vars("x * 2", &vars), -2);
    }

    #[test]
    fn test_overflow_pre_increment() {
        // ++x where x = i64::MAX should wrap to i64::MIN
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MAX);
        let (result, assigns) = ev_with_assigns("++x", &vars);
        assert_eq!(result, i64::MIN);
        assert_eq!(assigns.get("x"), Some(&i64::MIN));
    }

    #[test]
    fn test_overflow_pre_decrement() {
        // --x where x = i64::MIN should wrap to i64::MAX
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MIN);
        let (result, assigns) = ev_with_assigns("--x", &vars);
        assert_eq!(result, i64::MAX);
        assert_eq!(assigns.get("x"), Some(&i64::MAX));
    }

    #[test]
    fn test_overflow_post_increment() {
        // x++ where x = i64::MAX should assign i64::MIN
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MAX);
        let (result, assigns) = ev_with_assigns("x++", &vars);
        assert_eq!(result, i64::MAX); // returns old value
        assert_eq!(assigns.get("x"), Some(&i64::MIN));
    }

    #[test]
    fn test_overflow_post_decrement() {
        // x-- where x = i64::MIN should assign i64::MAX
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), i64::MIN);
        let (result, assigns) = ev_with_assigns("x--", &vars);
        assert_eq!(result, i64::MIN); // returns old value
        assert_eq!(assigns.get("x"), Some(&i64::MAX));
    }

    #[test]
    fn test_compound_assign_shift_wraps() {
        // x <<= 64 should wrap (equivalent to x <<= 0)
        let mut vars = HashMap::new();
        vars.insert("x".to_string(), 1i64);
        let (result, assigns) = ev_with_assigns("x <<= 64", &vars);
        assert_eq!(result, 1);
        assert_eq!(assigns.get("x"), Some(&1));
    }
}
