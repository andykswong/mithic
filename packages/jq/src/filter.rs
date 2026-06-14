use crate::json::{JValue, FormatOpts, format_value};

#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    Identity,
    Recurse,
    Literal(JValue),
    Field(String, bool),
    Index(Box<Filter>),
    Slice(Option<Box<Filter>>, Option<Box<Filter>>),
    Iter(bool),
    Pipe(Box<Filter>, Box<Filter>),
    Comma(Box<Filter>, Box<Filter>),
    Array(Box<Filter>),
    Object(Vec<ObjEntry>),
    Try(Box<Filter>, Option<Box<Filter>>),
    Neg(Box<Filter>),
    Add(Box<Filter>, Box<Filter>),
    Sub(Box<Filter>, Box<Filter>),
    Mul(Box<Filter>, Box<Filter>),
    Div(Box<Filter>, Box<Filter>),
    Mod(Box<Filter>, Box<Filter>),
    Eq(Box<Filter>, Box<Filter>),
    Ne(Box<Filter>, Box<Filter>),
    Lt(Box<Filter>, Box<Filter>),
    Le(Box<Filter>, Box<Filter>),
    Gt(Box<Filter>, Box<Filter>),
    Ge(Box<Filter>, Box<Filter>),
    And(Box<Filter>, Box<Filter>),
    Or(Box<Filter>, Box<Filter>),
    Not,
    Alt(Box<Filter>, Box<Filter>),
    IfElse(Box<Filter>, Box<Filter>, Vec<(Filter, Filter)>, Option<Box<Filter>>),
    Reduce(Box<Filter>, Pattern, Box<Filter>),
    Foreach(Box<Filter>, Pattern, Box<Filter>, Option<Box<Filter>>),
    Label(String, Box<Filter>),
    Break(String),
    Binding(Box<Filter>, Pattern, Box<Filter>),
    FuncDef(String, Vec<String>, Box<Filter>, Box<Filter>),
    Call(String, Vec<Filter>),
    Var(String),
    Optional(Box<Filter>),
    StringInterp(Vec<StringPart>),
    Format(String, Option<Box<Filter>>),
    Path(Box<Filter>),
    GetPath(Box<Filter>),
    SetPath(Box<Filter>, Box<Filter>),
    DelPaths(Box<Filter>),
    Env,
    EnvVar,
    InputLine,
    Limit(Box<Filter>, Box<Filter>),
    First(Box<Filter>),
    Last(Box<Filter>),
    Nth(Box<Filter>, Box<Filter>),
    Until(Box<Filter>, Box<Filter>),
    While(Box<Filter>, Box<Filter>),
    Repeat(Box<Filter>),
    Recurse2(Box<Filter>),
    RecurseF(Box<Filter>, Option<Box<Filter>>),
    Walk(Box<Filter>),
    IsEmpty(Box<Filter>),
    AnyF(Box<Filter>),
    AllF(Box<Filter>),
    AnyG(Box<Filter>, Box<Filter>),
    AllG(Box<Filter>, Box<Filter>),
    Assign(Box<Filter>, Box<Filter>),
    UpdateAdd(Box<Filter>, Box<Filter>),
    UpdateSub(Box<Filter>, Box<Filter>),
    UpdateMul(Box<Filter>, Box<Filter>),
    UpdateDiv(Box<Filter>, Box<Filter>),
    UpdateMod(Box<Filter>, Box<Filter>),
    UpdateAlt(Box<Filter>, Box<Filter>),
    Debug(Option<Box<Filter>>),
    Error(Option<Box<Filter>>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Pattern {
    Var(String),
    Array(Vec<Pattern>),
    Object(Vec<(String, Pattern)>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ObjEntry {
    Fixed(String, Filter),
    Computed(Filter, Filter),
    Shorthand(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum StringPart {
    Literal(String),
    Interp(Filter),
}

#[derive(Debug, Clone, PartialEq)]
enum FTok {
    Dot,
    DotDot,
    DotField(String),
    Pipe,
    Comma,
    Semicolon,
    Colon,
    Question,
    LParen,
    RParen,
    LBracket,
    RBracket,
    LBrace,
    RBrace,
    At,
    Dollar,
    Hash,
    Eq,
    Ne,
    Le,
    Ge,
    Lt,
    Gt,
    Assign,
    AltAssign,
    PipeAssign,
    AddAssign,
    SubAssign,
    MulAssign,
    DivAssign,
    ModAssign,
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Alt,
    And,
    Or,
    Not,
    If,
    Then,
    Else,
    Elif,
    End,
    Try,
    Catch,
    Reduce,
    Foreach,
    As,
    Def,
    Label,
    Break,
    Recurse,
    Null,
    True,
    False,
    Ident(String),
    Var(String),
    Label2(String),
    Num(f64),
    Str(Vec<StringPart>),
    Format(String),
    Eof,
}

struct FLexer<'a> {
    src: &'a str,
    pos: usize,
    tokens: Vec<(FTok, usize)>,
}

impl<'a> FLexer<'a> {
    fn new(src: &'a str) -> Self {
        FLexer { src, pos: 0, tokens: Vec::new() }
    }

    fn peek_char(&self) -> Option<char> {
        self.src[self.pos..].chars().next()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.src[self.pos..].chars().next()?;
        self.pos += c.len_utf8();
        Some(c)
    }

    fn skip_ws(&mut self) {
        loop {
            match self.peek_char() {
                Some(' ') | Some('\t') | Some('\n') | Some('\r') => { self.advance(); }
                Some('#') => {
                    while self.peek_char().map_or(false, |c| c != '\n') { self.advance(); }
                }
                _ => break,
            }
        }
    }

    fn tokenize(&mut self) -> Result<Vec<FTok>, String> {
        let mut result = Vec::new();
        loop {
            self.skip_ws();
            if self.pos >= self.src.len() {
                result.push(FTok::Eof);
                break;
            }
            let tok = self.next_token()?;
            result.push(tok);
        }
        Ok(result)
    }

    fn next_token(&mut self) -> Result<FTok, String> {
        let c = match self.peek_char() {
            Some(c) => c,
            None => return Ok(FTok::Eof),
        };
        match c {
            '|' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::PipeAssign) }
                else { Ok(FTok::Pipe) }
            }
            ',' => { self.advance(); Ok(FTok::Comma) }
            ';' => { self.advance(); Ok(FTok::Semicolon) }
            ':' => { self.advance(); Ok(FTok::Colon) }
            '?' => { self.advance(); Ok(FTok::Question) }
            '(' => { self.advance(); Ok(FTok::LParen) }
            ')' => { self.advance(); Ok(FTok::RParen) }
            '[' => { self.advance(); Ok(FTok::LBracket) }
            ']' => { self.advance(); Ok(FTok::RBracket) }
            '{' => { self.advance(); Ok(FTok::LBrace) }
            '}' => { self.advance(); Ok(FTok::RBrace) }
            '+' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::AddAssign) }
                else { Ok(FTok::Plus) }
            }
            '-' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::SubAssign) }
                else { Ok(FTok::Minus) }
            }
            '*' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::MulAssign) }
                else { Ok(FTok::Star) }
            }
            '/' => {
                self.advance();
                if self.peek_char() == Some('/') {
                    self.advance();
                    if self.peek_char() == Some('=') { self.advance(); Ok(FTok::AltAssign) }
                    else { Ok(FTok::Alt) }
                } else if self.peek_char() == Some('=') { self.advance(); Ok(FTok::DivAssign) }
                else { Ok(FTok::Slash) }
            }
            '%' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::ModAssign) }
                else { Ok(FTok::Percent) }
            }
            '=' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::Eq) }
                else { Ok(FTok::Assign) }
            }
            '!' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::Ne) }
                else { Err(format!("unexpected '!'")) }
            }
            '<' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::Le) }
                else { Ok(FTok::Lt) }
            }
            '>' => {
                self.advance();
                if self.peek_char() == Some('=') { self.advance(); Ok(FTok::Ge) }
                else { Ok(FTok::Gt) }
            }
            '.' => {
                self.advance();
                if self.peek_char() == Some('.') {
                    self.advance();
                    return Ok(FTok::DotDot);
                }
                if self.peek_char().map_or(false, |c| c.is_alphabetic() || c == '_') {
                    let mut name = String::new();
                    while self.peek_char().map_or(false, |c| c.is_alphanumeric() || c == '_') {
                        name.push(self.advance().unwrap());
                    }
                    Ok(FTok::DotField(name))
                } else {
                    Ok(FTok::Dot)
                }
            }
            '$' => {
                self.advance();
                let mut name = String::new();
                while self.peek_char().map_or(false, |c| c.is_alphanumeric() || c == '_') {
                    name.push(self.advance().unwrap());
                }
                Ok(FTok::Var(name))
            }
            '@' => {
                self.advance();
                let mut name = String::new();
                while self.peek_char().map_or(false, |c| c.is_alphanumeric() || c == '_') {
                    name.push(self.advance().unwrap());
                }
                Ok(FTok::Format(name))
            }
            '"' => self.lex_string(),
            '0'..='9' => self.lex_number(),
            c if c.is_alphabetic() || c == '_' => {
                let mut name = String::new();
                while self.peek_char().map_or(false, |c| c.is_alphanumeric() || c == '_') {
                    name.push(self.advance().unwrap());
                }
                let tok = match name.as_str() {
                    "null" => FTok::Null,
                    "true" => FTok::True,
                    "false" => FTok::False,
                    "and" => FTok::And,
                    "or" => FTok::Or,
                    "not" => FTok::Not,
                    "if" => FTok::If,
                    "then" => FTok::Then,
                    "else" => FTok::Else,
                    "elif" => FTok::Elif,
                    "end" => FTok::End,
                    "try" => FTok::Try,
                    "catch" => FTok::Catch,
                    "reduce" => FTok::Reduce,
                    "foreach" => FTok::Foreach,
                    "as" => FTok::As,
                    "def" => FTok::Def,
                    "label" => FTok::Label,
                    "break" => FTok::Break,
                    _ => FTok::Ident(name),
                };
                Ok(tok)
            }
            c => Err(format!("unexpected character: '{}'", c)),
        }
    }

    fn lex_number(&mut self) -> Result<FTok, String> {
        let start = self.pos;
        while self.peek_char().map_or(false, |c| c.is_ascii_digit()) { self.advance(); }
        if self.peek_char() == Some('.') {
            let next2 = self.src[self.pos+1..].chars().next();
            if next2.map_or(false, |c| c.is_ascii_digit()) {
                self.advance();
                while self.peek_char().map_or(false, |c| c.is_ascii_digit()) { self.advance(); }
            }
        }
        if self.peek_char().map_or(false, |c| c == 'e' || c == 'E') {
            self.advance();
            if self.peek_char().map_or(false, |c| c == '+' || c == '-') { self.advance(); }
            while self.peek_char().map_or(false, |c| c.is_ascii_digit()) { self.advance(); }
        }
        let s = &self.src[start..self.pos];
        let n: f64 = s.parse().map_err(|_| format!("invalid number: {}", s))?;
        Ok(FTok::Num(n))
    }

    fn lex_string(&mut self) -> Result<FTok, String> {
        debug_assert_eq!(self.peek_char(), Some('"'));
        self.advance();
        let mut parts: Vec<StringPart> = Vec::new();
        let mut current = String::new();
        loop {
            match self.peek_char() {
                None => return Err("unterminated string".to_string()),
                Some('"') => {
                    self.advance();
                    if !current.is_empty() {
                        parts.push(StringPart::Literal(current));
                    }
                    if parts.len() == 1 {
                        if let StringPart::Literal(s) = &parts[0] {
                            let s = s.clone();
                            return Ok(FTok::Str(vec![StringPart::Literal(s)]));
                        }
                    }
                    return Ok(FTok::Str(parts));
                }
                Some('\\') => {
                    self.advance();
                    match self.peek_char() {
                        None => return Err("unterminated escape".to_string()),
                        Some('(') => {
                            self.advance();
                            if !current.is_empty() {
                                parts.push(StringPart::Literal(std::mem::take(&mut current)));
                            }
                            let expr = self.lex_interp()?;
                            parts.push(StringPart::Interp(expr));
                        }
                        Some('"') => { self.advance(); current.push('"'); }
                        Some('\\') => { self.advance(); current.push('\\'); }
                        Some('/') => { self.advance(); current.push('/'); }
                        Some('b') => { self.advance(); current.push('\x08'); }
                        Some('f') => { self.advance(); current.push('\x0c'); }
                        Some('n') => { self.advance(); current.push('\n'); }
                        Some('r') => { self.advance(); current.push('\r'); }
                        Some('t') => { self.advance(); current.push('\t'); }
                        Some('u') => {
                            self.advance();
                            let mut hex = String::new();
                            for _ in 0..4 {
                                match self.peek_char() {
                                    Some(c) if c.is_ascii_hexdigit() => { hex.push(c); self.advance(); }
                                    _ => return Err("invalid unicode escape".to_string()),
                                }
                            }
                            let code = u32::from_str_radix(&hex, 16).unwrap();
                            current.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                        }
                        Some(c) => return Err(format!("invalid escape \\{}", c)),
                    }
                }
                Some(c) => {
                    current.push(c);
                    self.advance();
                }
            }
        }
    }

    fn lex_interp(&mut self) -> Result<Filter, String> {
        let mut depth = 1;
        let chars: Vec<char> = self.src[self.pos..].chars().collect();
        let mut ci = 0;
        while ci < chars.len() {
            match chars[ci] {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 { break; }
                }
                '"' => {
                    ci += 1;
                    while ci < chars.len() && chars[ci] != '"' {
                        if chars[ci] == '\\' { ci += 1; }
                        ci += 1;
                    }
                }
                _ => {}
            }
            ci += 1;
        }
        let substr: String = chars[..ci].iter().collect();
        self.pos += substr.len();
        if self.peek_char() == Some(')') { self.advance(); }
        parse_filter(&substr)
    }
}

struct FParser {
    tokens: Vec<FTok>,
    pos: usize,
}

impl FParser {
    fn new(tokens: Vec<FTok>) -> Self {
        FParser { tokens, pos: 0 }
    }

    fn peek(&self) -> &FTok {
        self.tokens.get(self.pos).unwrap_or(&FTok::Eof)
    }

    fn peek2(&self) -> &FTok {
        self.tokens.get(self.pos + 1).unwrap_or(&FTok::Eof)
    }

    fn advance(&mut self) -> FTok {
        let t = self.tokens.get(self.pos).cloned().unwrap_or(FTok::Eof);
        if self.pos < self.tokens.len() { self.pos += 1; }
        t
    }

    fn expect(&mut self, expected: &FTok) -> Result<(), String> {
        let t = self.advance();
        if &t == expected {
            Ok(())
        } else {
            Err(format!("expected {:?}, got {:?}", expected, t))
        }
    }

    fn parse(&mut self) -> Result<Filter, String> {
        self.parse_defs()
    }

    fn parse_defs(&mut self) -> Result<Filter, String> {
        if self.peek() == &FTok::Def {
            self.advance();
            let name = match self.advance() {
                FTok::Ident(n) => n,
                t => return Err(format!("expected function name, got {:?}", t)),
            };
            let mut params: Vec<String> = Vec::new();
            if self.peek() == &FTok::LParen {
                self.advance();
                loop {
                    match self.advance() {
                        FTok::Ident(n) => params.push(n),
                        FTok::Var(n) => params.push(format!("${}", n)),
                        t => return Err(format!("expected param, got {:?}", t)),
                    }
                    match self.peek() {
                        FTok::Semicolon => { self.advance(); }
                        FTok::RParen => { self.advance(); break; }
                        t => return Err(format!("expected ';' or ')', got {:?}", t)),
                    }
                }
            }
            self.expect(&FTok::Colon)?;
            let body = self.parse_pipe()?;
            self.expect(&FTok::Semicolon)?;
            let rest = self.parse_defs()?;
            return Ok(Filter::FuncDef(name, params, Box::new(body), Box::new(rest)));
        }
        self.parse_pipe()
    }

    fn parse_pipe(&mut self) -> Result<Filter, String> {
        let left = self.parse_comma()?;
        if self.peek() == &FTok::Pipe {
            self.advance();
            let right = self.parse_pipe()?;
            Ok(Filter::Pipe(Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_comma(&mut self) -> Result<Filter, String> {
        let left = self.parse_as()?;
        if self.peek() == &FTok::Comma {
            self.advance();
            let right = self.parse_comma()?;
            Ok(Filter::Comma(Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_as(&mut self) -> Result<Filter, String> {
        let expr = self.parse_assign()?;
        if self.peek() == &FTok::As {
            self.advance();
            let pat = self.parse_pattern()?;
            self.expect(&FTok::Pipe)?;
            let body = self.parse_as()?;
            Ok(Filter::Binding(Box::new(expr), pat, Box::new(body)))
        } else {
            Ok(expr)
        }
    }

    fn parse_assign(&mut self) -> Result<Filter, String> {
        let left = self.parse_alt()?;
        match self.peek().clone() {
            FTok::Assign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::Assign(Box::new(left), Box::new(r))) }
            FTok::PipeAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::Assign(Box::new(left), Box::new(r))) }
            FTok::AddAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateAdd(Box::new(left), Box::new(r))) }
            FTok::SubAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateSub(Box::new(left), Box::new(r))) }
            FTok::MulAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateMul(Box::new(left), Box::new(r))) }
            FTok::DivAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateDiv(Box::new(left), Box::new(r))) }
            FTok::ModAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateMod(Box::new(left), Box::new(r))) }
            FTok::AltAssign => { self.advance(); let r = self.parse_alt()?; Ok(Filter::UpdateAlt(Box::new(left), Box::new(r))) }
            _ => Ok(left),
        }
    }

    fn parse_alt(&mut self) -> Result<Filter, String> {
        let left = self.parse_or()?;
        if self.peek() == &FTok::Alt {
            self.advance();
            let right = self.parse_alt()?;
            Ok(Filter::Alt(Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_or(&mut self) -> Result<Filter, String> {
        let left = self.parse_and()?;
        if self.peek() == &FTok::Or {
            self.advance();
            let right = self.parse_or()?;
            Ok(Filter::Or(Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_and(&mut self) -> Result<Filter, String> {
        let left = self.parse_not()?;
        if self.peek() == &FTok::And {
            self.advance();
            let right = self.parse_and()?;
            Ok(Filter::And(Box::new(left), Box::new(right)))
        } else {
            Ok(left)
        }
    }

    fn parse_not(&mut self) -> Result<Filter, String> {
        if self.peek() == &FTok::Not {
            self.advance();
            let inner = self.parse_not()?;
            Ok(Filter::Pipe(Box::new(inner), Box::new(Filter::Not)))
        } else {
            self.parse_cmp()
        }
    }

    fn parse_cmp(&mut self) -> Result<Filter, String> {
        let left = self.parse_add()?;
        match self.peek().clone() {
            FTok::Eq => { self.advance(); let r = self.parse_add()?; Ok(Filter::Eq(Box::new(left), Box::new(r))) }
            FTok::Ne => { self.advance(); let r = self.parse_add()?; Ok(Filter::Ne(Box::new(left), Box::new(r))) }
            FTok::Lt => { self.advance(); let r = self.parse_add()?; Ok(Filter::Lt(Box::new(left), Box::new(r))) }
            FTok::Le => { self.advance(); let r = self.parse_add()?; Ok(Filter::Le(Box::new(left), Box::new(r))) }
            FTok::Gt => { self.advance(); let r = self.parse_add()?; Ok(Filter::Gt(Box::new(left), Box::new(r))) }
            FTok::Ge => { self.advance(); let r = self.parse_add()?; Ok(Filter::Ge(Box::new(left), Box::new(r))) }
            _ => Ok(left),
        }
    }

    fn parse_add(&mut self) -> Result<Filter, String> {
        let mut left = self.parse_mul()?;
        loop {
            match self.peek() {
                FTok::Plus => { self.advance(); let r = self.parse_mul()?; left = Filter::Add(Box::new(left), Box::new(r)); }
                FTok::Minus => { self.advance(); let r = self.parse_mul()?; left = Filter::Sub(Box::new(left), Box::new(r)); }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Filter, String> {
        let mut left = self.parse_unary()?;
        loop {
            match self.peek() {
                FTok::Star => { self.advance(); let r = self.parse_unary()?; left = Filter::Mul(Box::new(left), Box::new(r)); }
                FTok::Slash => { self.advance(); let r = self.parse_unary()?; left = Filter::Div(Box::new(left), Box::new(r)); }
                FTok::Percent => { self.advance(); let r = self.parse_unary()?; left = Filter::Mod(Box::new(left), Box::new(r)); }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Filter, String> {
        if self.peek() == &FTok::Minus {
            self.advance();
            let inner = self.parse_postfix()?;
            Ok(Filter::Neg(Box::new(inner)))
        } else {
            self.parse_postfix()
        }
    }

    fn parse_postfix(&mut self) -> Result<Filter, String> {
        let mut base = self.parse_primary()?;
        loop {
            match self.peek().clone() {
                FTok::Dot => {
                    self.advance();
                    match self.peek().clone() {
                        FTok::Ident(f) => {
                            self.advance();
                            let opt = self.peek() == &FTok::Question;
                            if opt { self.advance(); }
                            base = Filter::Pipe(Box::new(base), Box::new(Filter::Field(f, opt)));
                        }
                        FTok::LBracket => {
                            self.advance();
                            base = self.parse_index_or_iter(base, false)?;
                        }
                        FTok::DotField(f) => {
                            self.advance();
                            base = Filter::Pipe(Box::new(base), Box::new(Filter::Field(f, false)));
                        }
                        _ => break,
                    }
                }
                FTok::DotField(f) => {
                    self.advance();
                    let opt = self.peek() == &FTok::Question;
                    if opt { self.advance(); }
                    base = Filter::Pipe(Box::new(base), Box::new(Filter::Field(f, opt)));
                }
                FTok::LBracket => {
                    self.advance();
                    base = self.parse_index_or_iter(base, false)?;
                }
                FTok::Question => {
                    self.advance();
                    base = Filter::Optional(Box::new(base));
                }
                _ => break,
            }
        }
        Ok(base)
    }

    fn parse_index_or_iter(&mut self, base: Filter, _opt: bool) -> Result<Filter, String> {
        if self.peek() == &FTok::RBracket {
            self.advance();
            let opt = self.peek() == &FTok::Question;
            if opt { self.advance(); }
            return Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Iter(opt))));
        }
        if self.peek() == &FTok::Colon {
            self.advance();
            if self.peek() == &FTok::RBracket {
                self.advance();
                return Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Slice(None, None))));
            }
            let to = self.parse_pipe()?;
            self.expect(&FTok::RBracket)?;
            return Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Slice(None, Some(Box::new(to))))));
        }
        let from = self.parse_pipe()?;
        if self.peek() == &FTok::Colon {
            self.advance();
            if self.peek() == &FTok::RBracket {
                self.advance();
                return Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Slice(Some(Box::new(from)), None))));
            }
            let to = self.parse_pipe()?;
            self.expect(&FTok::RBracket)?;
            return Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Slice(Some(Box::new(from)), Some(Box::new(to))))));
        }
        self.expect(&FTok::RBracket)?;
        let opt = self.peek() == &FTok::Question;
        if opt { self.advance(); }
        Ok(Filter::Pipe(Box::new(base), Box::new(Filter::Index(Box::new(from)))))
    }

    fn parse_primary(&mut self) -> Result<Filter, String> {
        match self.peek().clone() {
            FTok::Dot => {
                self.advance();
                match self.peek().clone() {
                    FTok::DotField(f) => {
                        self.advance();
                        let opt = self.peek() == &FTok::Question;
                        if opt { self.advance(); }
                        Ok(Filter::Field(f, opt))
                    }
                    FTok::Ident(f) => {
                        self.advance();
                        let opt = self.peek() == &FTok::Question;
                        if opt { self.advance(); }
                        Ok(Filter::Field(f, opt))
                    }
                    FTok::LBracket => {
                        self.advance();
                        self.parse_index_or_iter(Filter::Identity, false)
                    }
                    _ => Ok(Filter::Identity),
                }
            }
            FTok::DotField(f) => {
                self.advance();
                let opt = self.peek() == &FTok::Question;
                if opt { self.advance(); }
                Ok(Filter::Field(f, opt))
            }
            FTok::DotDot => {
                self.advance();
                Ok(Filter::Recurse)
            }
            FTok::Null => { self.advance(); Ok(Filter::Literal(JValue::Null)) }
            FTok::True => { self.advance(); Ok(Filter::Literal(JValue::Bool(true))) }
            FTok::False => { self.advance(); Ok(Filter::Literal(JValue::Bool(false))) }
            FTok::Num(n) => { let n = n; self.advance(); Ok(Filter::Literal(JValue::Number(n))) }
            FTok::Str(parts) => {
                self.advance();
                if parts.len() == 1 {
                    if let StringPart::Literal(s) = &parts[0] {
                        return Ok(Filter::Literal(JValue::String(s.clone())));
                    }
                }
                Ok(Filter::StringInterp(parts))
            }
            FTok::Minus => {
                self.advance();
                let inner = self.parse_primary()?;
                Ok(Filter::Neg(Box::new(inner)))
            }
            FTok::LParen => {
                self.advance();
                let f = self.parse_pipe()?;
                self.expect(&FTok::RParen)?;
                Ok(f)
            }
            FTok::LBracket => {
                self.advance();
                if self.peek() == &FTok::RBracket {
                    self.advance();
                    return Ok(Filter::Array(Box::new(Filter::Literal(JValue::Null))));
                }
                let inner = self.parse_pipe()?;
                self.expect(&FTok::RBracket)?;
                Ok(Filter::Array(Box::new(inner)))
            }
            FTok::LBrace => self.parse_object_construct(),
            FTok::If => self.parse_if(),
            FTok::Try => {
                self.advance();
                let body = self.parse_postfix()?;
                if self.peek() == &FTok::Catch {
                    self.advance();
                    let handler = self.parse_postfix()?;
                    Ok(Filter::Try(Box::new(body), Some(Box::new(handler))))
                } else {
                    Ok(Filter::Try(Box::new(body), None))
                }
            }
            FTok::Reduce => {
                self.advance();
                let generator = self.parse_postfix()?;
                self.expect(&FTok::As)?;
                let pat = self.parse_pattern()?;
                self.expect(&FTok::LParen)?;
                let init = self.parse_pipe()?;
                self.expect(&FTok::Semicolon)?;
                let update = self.parse_pipe()?;
                self.expect(&FTok::RParen)?;
                Ok(Filter::Reduce(Box::new(generator), pat, Box::new(Filter::Pipe(Box::new(init), Box::new(update)))))
            }
            FTok::Foreach => {
                self.advance();
                let generator = self.parse_postfix()?;
                self.expect(&FTok::As)?;
                let pat = self.parse_pattern()?;
                self.expect(&FTok::LParen)?;
                let init = self.parse_pipe()?;
                self.expect(&FTok::Semicolon)?;
                let update = self.parse_pipe()?;
                let extract = if self.peek() == &FTok::Semicolon {
                    self.advance();
                    Some(Box::new(self.parse_pipe()?))
                } else { None };
                self.expect(&FTok::RParen)?;
                Ok(Filter::Foreach(Box::new(generator), pat, Box::new(Filter::Pipe(Box::new(init), Box::new(update))), extract))
            }
            FTok::Label => {
                self.advance();
                let name = match self.advance() {
                    FTok::Var(n) => n,
                    t => return Err(format!("expected $label, got {:?}", t)),
                };
                self.expect(&FTok::Pipe)?;
                let body = self.parse_pipe()?;
                Ok(Filter::Label(name, Box::new(body)))
            }
            FTok::Break => {
                self.advance();
                let name = match self.advance() {
                    FTok::Var(n) => n,
                    t => return Err(format!("expected $label, got {:?}", t)),
                };
                Ok(Filter::Break(name))
            }
            FTok::Var(n) => {
                self.advance();
                Ok(Filter::Var(n))
            }
            FTok::Format(fmt) => {
                self.advance();
                if matches!(self.peek(), FTok::Str(_)) {
                    if let FTok::Str(parts) = self.advance() {
                        let inner = if parts.len() == 1 {
                            if let StringPart::Literal(s) = &parts[0] {
                                Filter::Literal(JValue::String(s.clone()))
                            } else { Filter::StringInterp(parts) }
                        } else { Filter::StringInterp(parts) };
                        Ok(Filter::Format(fmt, Some(Box::new(inner))))
                    } else { unreachable!() }
                } else {
                    Ok(Filter::Format(fmt, None))
                }
            }
            FTok::Not => {
                self.advance();
                Ok(Filter::Not)
            }
            FTok::Ident(name) => {
                self.advance();
                if self.peek() == &FTok::LParen {
                    self.advance();
                    let mut args = Vec::new();
                    if self.peek() != &FTok::RParen {
                        args.push(self.parse_pipe()?);
                        while self.peek() == &FTok::Semicolon {
                            self.advance();
                            args.push(self.parse_pipe()?);
                        }
                    }
                    self.expect(&FTok::RParen)?;
                    Ok(Filter::Call(name, args))
                } else {
                    Ok(Filter::Call(name, vec![]))
                }
            }
            t => Err(format!("unexpected token: {:?}", t)),
        }
    }

    fn parse_if(&mut self) -> Result<Filter, String> {
        self.expect(&FTok::If)?;
        let cond = self.parse_pipe()?;
        self.expect(&FTok::Then)?;
        let then = self.parse_pipe()?;
        let mut elif_branches: Vec<(Filter, Filter)> = Vec::new();
        let mut else_branch: Option<Box<Filter>> = None;
        loop {
            match self.peek() {
                FTok::Elif => {
                    self.advance();
                    let ec = self.parse_pipe()?;
                    self.expect(&FTok::Then)?;
                    let et = self.parse_pipe()?;
                    elif_branches.push((ec, et));
                }
                FTok::Else => {
                    self.advance();
                    else_branch = Some(Box::new(self.parse_pipe()?));
                    self.expect(&FTok::End)?;
                    break;
                }
                FTok::End => {
                    self.advance();
                    break;
                }
                t => return Err(format!("expected elif/else/end, got {:?}", t)),
            }
        }
        Ok(Filter::IfElse(Box::new(cond), Box::new(then), elif_branches, else_branch))
    }

    fn parse_object_construct(&mut self) -> Result<Filter, String> {
        self.expect(&FTok::LBrace)?;
        let mut entries: Vec<ObjEntry> = Vec::new();
        if self.peek() == &FTok::RBrace {
            self.advance();
            return Ok(Filter::Object(entries));
        }
        loop {
            let entry = match self.peek().clone() {
                FTok::Ident(k) => {
                    self.advance();
                    if self.peek() == &FTok::Colon {
                        self.advance();
                        let val = self.parse_alt()?;
                        ObjEntry::Fixed(k, val)
                    } else {
                        ObjEntry::Shorthand(k)
                    }
                }
                FTok::Str(parts) => {
                    self.advance();
                    let key = if parts.len() == 1 {
                        if let StringPart::Literal(s) = &parts[0] { s.clone() }
                        else { return Err("interpolated key not supported here".to_string()); }
                    } else { return Err("interpolated key not supported here".to_string()); };
                    self.expect(&FTok::Colon)?;
                    let val = self.parse_alt()?;
                    ObjEntry::Fixed(key, val)
                }
                FTok::LParen => {
                    self.advance();
                    let key_expr = self.parse_pipe()?;
                    self.expect(&FTok::RParen)?;
                    self.expect(&FTok::Colon)?;
                    let val = self.parse_alt()?;
                    ObjEntry::Computed(key_expr, val)
                }
                t => return Err(format!("unexpected token in object: {:?}", t)),
            };
            entries.push(entry);
            match self.peek() {
                FTok::Comma => { self.advance(); }
                FTok::RBrace => { self.advance(); break; }
                t => return Err(format!("expected ',' or '}}', got {:?}", t)),
            }
        }
        Ok(Filter::Object(entries))
    }

    fn parse_pattern(&mut self) -> Result<Pattern, String> {
        match self.peek().clone() {
            FTok::Var(n) => {
                self.advance();
                Ok(Pattern::Var(n))
            }
            FTok::LBracket => {
                self.advance();
                let mut items = Vec::new();
                while self.peek() != &FTok::RBracket && self.peek() != &FTok::Eof {
                    items.push(self.parse_pattern()?);
                    if self.peek() == &FTok::Comma { self.advance(); }
                }
                self.expect(&FTok::RBracket)?;
                Ok(Pattern::Array(items))
            }
            FTok::LBrace => {
                self.advance();
                let mut fields = Vec::new();
                while self.peek() != &FTok::RBrace && self.peek() != &FTok::Eof {
                    let key = match self.advance() {
                        FTok::Ident(k) => k,
                        FTok::Str(parts) => {
                            if let Some(StringPart::Literal(s)) = parts.into_iter().next() { s }
                            else { return Err("invalid pattern key".to_string()); }
                        }
                        t => return Err(format!("expected key in pattern, got {:?}", t)),
                    };
                    self.expect(&FTok::Colon)?;
                    let pat = self.parse_pattern()?;
                    fields.push((key, pat));
                    if self.peek() == &FTok::Comma { self.advance(); }
                }
                self.expect(&FTok::RBrace)?;
                Ok(Pattern::Object(fields))
            }
            t => Err(format!("expected pattern, got {:?}", t)),
        }
    }
}

pub fn parse_filter(src: &str) -> Result<Filter, String> {
    let mut lexer = FLexer::new(src);
    let tokens = lexer.tokenize()?;
    let mut parser = FParser::new(tokens);
    let f = parser.parse()?;
    if parser.peek() != &FTok::Eof {
        return Err(format!("unexpected token: {:?}", parser.peek()));
    }
    Ok(f)
}
