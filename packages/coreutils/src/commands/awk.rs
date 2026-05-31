use super::{write_stdout, write_stderr, read_stdin_all, read_file, append_file, write_file};
use std::collections::HashMap;

pub fn run(args: &[&str]) -> u8 {
    let mut fs = String::new();
    let mut prog_source = String::new();
    let mut vars: Vec<(String, String)> = Vec::new();
    let mut file_args: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-F" => {
                i += 1;
                if i < args.len() { fs = args[i].to_string(); }
            }
            a if a.starts_with("-F") => { fs = a[2..].to_string(); }
            "-v" => {
                i += 1;
                if i < args.len() { vars.push(parse_assignment(args[i])); }
            }
            a if a.starts_with("-v") => { vars.push(parse_assignment(&a[2..])); }
            "-f" => {
                i += 1;
                if i < args.len() {
                    match read_file(args[i]) {
                        Some(d) => prog_source.push_str(&String::from_utf8_lossy(&d)),
                        None => {
                            write_stderr(&format!("awk: can't open file '{}'\n", args[i]));
                            return 2;
                        }
                    }
                }
            }
            "--" => { i += 1; file_args.extend_from_slice(&args[i..]); break; }
            _ => {
                if prog_source.is_empty() && file_args.is_empty() {
                    prog_source = args[i].to_string();
                } else {
                    file_args.push(args[i]);
                }
            }
        }
        i += 1;
    }
    if prog_source.is_empty() {
        write_stderr("awk: no program given\n");
        return 1;
    }
    let tokens = match tokenize(&prog_source) {
        Ok(t) => t,
        Err(e) => { write_stderr(&format!("awk: {}\n", e)); return 2; }
    };
    let program = match parse(&tokens) {
        Ok(p) => p,
        Err(e) => { write_stderr(&format!("awk: {}\n", e)); return 2; }
    };
    let mut interp = Interpreter::new();
    if !fs.is_empty() { interp.set_global("FS", Value::Str(fs)); }
    for (k, v) in &vars { interp.set_global(k, Value::Str(v.clone())); }
    interp.set_global("ARGC", Value::Num((file_args.len() + 1) as f64));
    for (idx, &f) in file_args.iter().enumerate() {
        interp.set_array_elem("ARGV", &Value::Num((idx + 1) as f64), Value::Str(f.to_string()));
    }
    interp.set_array_elem("ARGV", &Value::Num(0.0), Value::Str("awk".to_string()));
    match interp.exec(&program, &file_args) {
        Ok(code) => code,
        Err(e) => { write_stderr(&format!("awk: {}\n", e)); 2 }
    }
}

fn parse_assignment(s: &str) -> (String, String) {
    if let Some(pos) = s.find('=') {
        (s[..pos].to_string(), s[pos+1..].to_string())
    } else {
        (s.to_string(), String::new())
    }
}

// === Tokens ===

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
enum Token {
    Num(f64), Str(String), Regex(String), Ident(String),
    // keywords
    Begin, End, If, Else, While, Do, For, In, Break, Continue, Next, Exit, Return,
    Delete, Function, Getline, Print, Printf,
    // operators
    Plus, Minus, Star, Slash, Percent, Caret, Assign,
    PlusAssign, MinusAssign, StarAssign, SlashAssign, PercentAssign, CaretAssign,
    Eq, Ne, Lt, Le, Gt, Ge, And, Or, Not, Match, NotMatch,
    Incr, Decr, Dollar, Question, Colon, Comma, Semi, Newline,
    LBrace, RBrace, LParen, RParen, LBracket, RBracket,
    Append, Pipe, PipeGetline,
    Ternary, Concat,
}

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = src.chars().collect();
    let len = chars.len();
    let mut tokens = Vec::new();
    let mut i = 0;
    let mut prev_token_type = PrevType::Op;

    while i < len {
        match chars[i] {
            ' ' | '\t' | '\r' => { i += 1; }
            '#' => { while i < len && chars[i] != '\n' { i += 1; } }
            '\n' => {
                if !tokens.is_empty() {
                    match prev_token_type {
                        PrevType::Value | PrevType::RBrace | PrevType::Incr => {
                            tokens.push(Token::Newline);
                            prev_token_type = PrevType::Op;
                        }
                        _ => {}
                    }
                }
                i += 1;
            }
            '\\' if i + 1 < len && chars[i+1] == '\n' => { i += 2; }
            '{' => { tokens.push(Token::LBrace); prev_token_type = PrevType::Op; i += 1; }
            '}' => { tokens.push(Token::RBrace); prev_token_type = PrevType::RBrace; i += 1; }
            '(' => { tokens.push(Token::LParen); prev_token_type = PrevType::Op; i += 1; }
            ')' => { tokens.push(Token::RParen); prev_token_type = PrevType::Value; i += 1; }
            '[' => { tokens.push(Token::LBracket); prev_token_type = PrevType::Op; i += 1; }
            ']' => { tokens.push(Token::RBracket); prev_token_type = PrevType::Value; i += 1; }
            ';' => { tokens.push(Token::Semi); prev_token_type = PrevType::Op; i += 1; }
            ',' => { tokens.push(Token::Comma); prev_token_type = PrevType::Op; i += 1; }
            '?' => { tokens.push(Token::Question); prev_token_type = PrevType::Op; i += 1; }
            ':' => { tokens.push(Token::Colon); prev_token_type = PrevType::Op; i += 1; }
            '$' => { tokens.push(Token::Dollar); prev_token_type = PrevType::Op; i += 1; }
            '+' => {
                if i+1 < len && chars[i+1] == '+' { tokens.push(Token::Incr); prev_token_type = PrevType::Incr; i += 2; }
                else if i+1 < len && chars[i+1] == '=' { tokens.push(Token::PlusAssign); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Plus); prev_token_type = PrevType::Op; i += 1; }
            }
            '-' => {
                if i+1 < len && chars[i+1] == '-' { tokens.push(Token::Decr); prev_token_type = PrevType::Incr; i += 2; }
                else if i+1 < len && chars[i+1] == '=' { tokens.push(Token::MinusAssign); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Minus); prev_token_type = PrevType::Op; i += 1; }
            }
            '*' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::StarAssign); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Star); prev_token_type = PrevType::Op; i += 1; }
            }
            '%' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::PercentAssign); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Percent); prev_token_type = PrevType::Op; i += 1; }
            }
            '^' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::CaretAssign); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Caret); prev_token_type = PrevType::Op; i += 1; }
            }
            '=' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::Eq); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Assign); prev_token_type = PrevType::Op; i += 1; }
            }
            '!' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::Ne); prev_token_type = PrevType::Op; i += 2; }
                else if i+1 < len && chars[i+1] == '~' { tokens.push(Token::NotMatch); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Not); prev_token_type = PrevType::Op; i += 1; }
            }
            '<' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::Le); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Lt); prev_token_type = PrevType::Op; i += 1; }
            }
            '>' => {
                if i+1 < len && chars[i+1] == '=' { tokens.push(Token::Ge); prev_token_type = PrevType::Op; i += 2; }
                else if i+1 < len && chars[i+1] == '>' { tokens.push(Token::Append); prev_token_type = PrevType::Op; i += 2; }
                else { tokens.push(Token::Gt); prev_token_type = PrevType::Op; i += 1; }
            }
            '&' => {
                if i+1 < len && chars[i+1] == '&' { tokens.push(Token::And); prev_token_type = PrevType::Op; i += 2; }
                else { i += 1; } // stray &
            }
            '|' => {
                if i+1 < len && chars[i+1] == '|' { tokens.push(Token::Or); prev_token_type = PrevType::Op; i += 2; }
                else {
                    // check if this is `| getline` -> PipeGetline vs output pipe
                    tokens.push(Token::Pipe);
                    prev_token_type = PrevType::Op;
                    i += 1;
                }
            }
            '~' => { tokens.push(Token::Match); prev_token_type = PrevType::Op; i += 1; }
            '"' => {
                let s = scan_string(&chars, &mut i)?;
                tokens.push(Token::Str(s));
                prev_token_type = PrevType::Value;
            }
            '/' => {
                if prev_token_type == PrevType::Op || prev_token_type == PrevType::RBrace {
                    let r = scan_regex(&chars, &mut i)?;
                    tokens.push(Token::Regex(r));
                    prev_token_type = PrevType::Value;
                } else if i+1 < len && chars[i+1] == '=' {
                    tokens.push(Token::SlashAssign);
                    prev_token_type = PrevType::Op;
                    i += 2;
                } else {
                    tokens.push(Token::Slash);
                    prev_token_type = PrevType::Op;
                    i += 1;
                }
            }
            c if c.is_ascii_digit() || (c == '.' && i+1 < len && chars[i+1].is_ascii_digit()) => {
                let n = scan_number(&chars, &mut i);
                tokens.push(Token::Num(n));
                prev_token_type = PrevType::Value;
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let id = scan_ident(&chars, &mut i);
                let tok = match id.as_str() {
                    "BEGIN" => Token::Begin,
                    "END" => Token::End,
                    "if" => Token::If,
                    "else" => Token::Else,
                    "while" => Token::While,
                    "do" => Token::Do,
                    "for" => Token::For,
                    "in" => Token::In,
                    "break" => Token::Break,
                    "continue" => Token::Continue,
                    "next" => Token::Next,
                    "exit" => Token::Exit,
                    "return" => Token::Return,
                    "delete" => Token::Delete,
                    "function" => Token::Function,
                    "getline" => Token::Getline,
                    "print" => Token::Print,
                    "printf" => Token::Printf,
                    _ => Token::Ident(id),
                };
                prev_token_type = match &tok {
                    Token::Ident(_) | Token::Getline => PrevType::Value,
                    _ => PrevType::Op,
                };
                tokens.push(tok);
            }
            _ => { i += 1; }
        }
    }
    Ok(tokens)
}

#[derive(Clone, Copy, PartialEq)]
enum PrevType { Op, Value, RBrace, Incr }

fn scan_string(chars: &[char], i: &mut usize) -> Result<String, String> {
    *i += 1; // skip opening "
    let mut s = String::new();
    while *i < chars.len() && chars[*i] != '"' {
        if chars[*i] == '\\' && *i + 1 < chars.len() {
            *i += 1;
            match chars[*i] {
                'n' => s.push('\n'),
                't' => s.push('\t'),
                'r' => s.push('\r'),
                '\\' => s.push('\\'),
                '"' => s.push('"'),
                'a' => s.push('\x07'),
                'b' => s.push('\x08'),
                'f' => s.push('\x0c'),
                'v' => s.push('\x0b'),
                '/' => s.push('/'),
                '0'..='7' => {
                    let mut val = (chars[*i] as u32) - ('0' as u32);
                    for _ in 0..2 {
                        if *i + 1 < chars.len() && chars[*i+1] >= '0' && chars[*i+1] <= '7' {
                            *i += 1;
                            val = val * 8 + (chars[*i] as u32 - '0' as u32);
                        } else { break; }
                    }
                    s.push(char::from_u32(val).unwrap_or('\0'));
                }
                c => { s.push('\\'); s.push(c); }
            }
        } else {
            s.push(chars[*i]);
        }
        *i += 1;
    }
    if *i < chars.len() { *i += 1; } // skip closing "
    Ok(s)
}

fn scan_regex(chars: &[char], i: &mut usize) -> Result<String, String> {
    *i += 1; // skip opening /
    let mut s = String::new();
    while *i < chars.len() && chars[*i] != '/' {
        if chars[*i] == '\\' && *i + 1 < chars.len() {
            *i += 1;
            match chars[*i] {
                '/' => s.push('/'),
                c => { s.push('\\'); s.push(c); }
            }
        } else {
            s.push(chars[*i]);
        }
        *i += 1;
    }
    if *i < chars.len() { *i += 1; } // skip closing /
    Ok(s)
}

fn scan_number(chars: &[char], i: &mut usize) -> f64 {
    let start = *i;
    if *i + 1 < chars.len() && chars[*i] == '0' && (chars[*i+1] == 'x' || chars[*i+1] == 'X') {
        *i += 2;
        while *i < chars.len() && chars[*i].is_ascii_hexdigit() { *i += 1; }
        let hex_str: String = chars[start+2..*i].iter().collect();
        return u64::from_str_radix(&hex_str, 16).unwrap_or(0) as f64;
    }
    while *i < chars.len() && chars[*i].is_ascii_digit() { *i += 1; }
    if *i < chars.len() && chars[*i] == '.' {
        *i += 1;
        while *i < chars.len() && chars[*i].is_ascii_digit() { *i += 1; }
    }
    if *i < chars.len() && (chars[*i] == 'e' || chars[*i] == 'E') {
        *i += 1;
        if *i < chars.len() && (chars[*i] == '+' || chars[*i] == '-') { *i += 1; }
        while *i < chars.len() && chars[*i].is_ascii_digit() { *i += 1; }
    }
    let s: String = chars[start..*i].iter().collect();
    s.parse::<f64>().unwrap_or(0.0)
}

fn scan_ident(chars: &[char], i: &mut usize) -> String {
    let start = *i;
    while *i < chars.len() && (chars[*i].is_ascii_alphanumeric() || chars[*i] == '_') { *i += 1; }
    chars[start..*i].iter().collect()
}

// === AST ===

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum Expr {
    Num(f64),
    Str(String),
    Regex(String),
    Var(String),
    Field(Box<Expr>),
    Array(String, Vec<Expr>),
    Assign(Box<Expr>, Box<Expr>),
    OpAssign(String, Box<Expr>, Box<Expr>),
    Binop(String, Box<Expr>, Box<Expr>),
    Unary(String, Box<Expr>),
    Not(Box<Expr>),
    PreIncr(Box<Expr>),
    PreDecr(Box<Expr>),
    PostIncr(Box<Expr>),
    PostDecr(Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    MatchOp(Box<Expr>, Box<Expr>),
    NotMatchOp(Box<Expr>, Box<Expr>),
    In(Box<Expr>, String),
    Concat(Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    Getline(Option<Box<Expr>>, Option<Box<Expr>>), // var, file
    GetlinePipe(Box<Expr>, Option<Box<Expr>>),     // cmd, var
    Sprintf(Vec<Expr>),
}

#[derive(Debug, Clone)]
enum Stmt {
    Expr(Expr),
    Print(Vec<Expr>, Option<OutputDest>),
    Printf(Vec<Expr>, Option<OutputDest>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    While(Expr, Box<Stmt>),
    DoWhile(Box<Stmt>, Expr),
    For(Option<Box<Stmt>>, Option<Expr>, Option<Box<Stmt>>, Box<Stmt>),
    ForIn(String, String, Box<Stmt>),
    Block(Vec<Stmt>),
    Break,
    Continue,
    Next,
    Exit(Option<Expr>),
    Return(Option<Expr>),
    Delete(String, Vec<Expr>),
    DeleteAll(String),
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum OutputDest {
    File(Expr),
    Append(Expr),
    Pipe(Expr),
}

#[derive(Debug, Clone)]
enum Pattern {
    Begin,
    End,
    Expr(Expr),
    Range(Expr, Expr),
}

#[derive(Debug, Clone)]
struct Rule {
    pattern: Option<Pattern>,
    action: Vec<Stmt>,
}

#[derive(Debug, Clone)]
struct FuncDef {
    name: String,
    params: Vec<String>,
    body: Vec<Stmt>,
}

#[derive(Debug, Clone)]
struct Program {
    rules: Vec<Rule>,
    functions: Vec<FuncDef>,
}

// === Parser ===

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    in_print: bool,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self { Self { tokens, pos: 0, in_print: false } }

    fn peek(&self) -> Option<&Token> { self.tokens.get(self.pos) }

    fn advance(&mut self) -> Option<Token> {
        if self.pos < self.tokens.len() {
            let t = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(t)
        } else { None }
    }

    fn expect(&mut self, tok: &Token) -> Result<(), String> {
        if self.peek() == Some(tok) { self.advance(); Ok(()) }
        else { Err(format!("expected {:?}, got {:?}", tok, self.peek())) }
    }

    fn skip_terminators(&mut self) {
        while matches!(self.peek(), Some(Token::Newline) | Some(Token::Semi)) { self.advance(); }
    }

    fn at_end(&self) -> bool { self.pos >= self.tokens.len() }

    fn parse_program(&mut self) -> Result<Program, String> {
        let mut rules = Vec::new();
        let mut functions = Vec::new();
        self.skip_terminators();
        while !self.at_end() {
            if self.peek() == Some(&Token::Function) {
                functions.push(self.parse_func_def()?);
            } else {
                rules.push(self.parse_rule()?);
            }
            self.skip_terminators();
        }
        Ok(Program { rules, functions })
    }

    fn parse_func_def(&mut self) -> Result<FuncDef, String> {
        self.advance(); // consume 'function'
        let name = match self.advance() {
            Some(Token::Ident(n)) => n,
            _ => return Err("expected function name".into()),
        };
        self.expect(&Token::LParen)?;
        let mut params = Vec::new();
        while self.peek() != Some(&Token::RParen) {
            match self.advance() {
                Some(Token::Ident(p)) => params.push(p),
                _ => return Err("expected parameter name".into()),
            }
            if self.peek() == Some(&Token::Comma) { self.advance(); }
        }
        self.expect(&Token::RParen)?;
        self.skip_terminators();
        let body = self.parse_block()?;
        Ok(FuncDef { name, params, body })
    }

    fn parse_rule(&mut self) -> Result<Rule, String> {
        let pattern = match self.peek() {
            Some(Token::Begin) => { self.advance(); Some(Pattern::Begin) }
            Some(Token::End) => { self.advance(); Some(Pattern::End) }
            Some(Token::LBrace) => None,
            _ => {
                let p = self.parse_expr()?;
                if self.peek() == Some(&Token::Comma) {
                    self.advance();
                    self.skip_terminators();
                    let p2 = self.parse_expr()?;
                    Some(Pattern::Range(p, p2))
                } else {
                    Some(Pattern::Expr(p))
                }
            }
        };
        self.skip_terminators();
        let action = if self.peek() == Some(&Token::LBrace) {
            self.parse_block()?
        } else {
            if pattern.is_some() {
                vec![Stmt::Print(vec![Expr::Field(Box::new(Expr::Num(0.0)))], None)]
            } else {
                return Err("expected { after pattern".into());
            }
        };
        Ok(Rule { pattern, action })
    }

    fn parse_block(&mut self) -> Result<Vec<Stmt>, String> {
        self.expect(&Token::LBrace)?;
        self.skip_terminators();
        let mut stmts = Vec::new();
        while self.peek() != Some(&Token::RBrace) && !self.at_end() {
            stmts.push(self.parse_stmt()?);
            self.skip_terminators();
        }
        self.expect(&Token::RBrace)?;
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, String> {
        match self.peek() {
            Some(Token::If) => self.parse_if(),
            Some(Token::While) => self.parse_while(),
            Some(Token::Do) => self.parse_do_while(),
            Some(Token::For) => self.parse_for(),
            Some(Token::LBrace) => {
                let stmts = self.parse_block()?;
                Ok(Stmt::Block(stmts))
            }
            Some(Token::Break) => { self.advance(); self.skip_opt_semi(); Ok(Stmt::Break) }
            Some(Token::Continue) => { self.advance(); self.skip_opt_semi(); Ok(Stmt::Continue) }
            Some(Token::Next) => { self.advance(); self.skip_opt_semi(); Ok(Stmt::Next) }
            Some(Token::Exit) => {
                self.advance();
                let e = if self.is_expr_start() { Some(self.parse_expr()?) } else { None };
                self.skip_opt_semi();
                Ok(Stmt::Exit(e))
            }
            Some(Token::Return) => {
                self.advance();
                let e = if self.is_expr_start() { Some(self.parse_expr()?) } else { None };
                self.skip_opt_semi();
                Ok(Stmt::Return(e))
            }
            Some(Token::Delete) => self.parse_delete(),
            Some(Token::Print) => self.parse_print(),
            Some(Token::Printf) => self.parse_printf(),
            _ => {
                let e = self.parse_expr()?;
                self.skip_opt_semi();
                Ok(Stmt::Expr(e))
            }
        }
    }

    fn skip_opt_semi(&mut self) {
        if matches!(self.peek(), Some(Token::Semi) | Some(Token::Newline)) { self.advance(); }
    }

    fn is_expr_start(&self) -> bool {
        matches!(self.peek(), Some(Token::Num(_)) | Some(Token::Str(_)) | Some(Token::Regex(_))
            | Some(Token::Ident(_)) | Some(Token::Dollar) | Some(Token::LParen)
            | Some(Token::Not) | Some(Token::Minus) | Some(Token::Plus)
            | Some(Token::Incr) | Some(Token::Decr) | Some(Token::Getline))
    }

    fn parse_if(&mut self) -> Result<Stmt, String> {
        self.advance(); // if
        self.expect(&Token::LParen)?;
        let cond = self.parse_expr()?;
        self.expect(&Token::RParen)?;
        self.skip_terminators();
        let body = self.parse_stmt()?;
        self.skip_terminators();
        let else_body = if self.peek() == Some(&Token::Else) {
            self.advance();
            self.skip_terminators();
            Some(Box::new(self.parse_stmt()?))
        } else { None };
        Ok(Stmt::If(cond, Box::new(body), else_body))
    }

    fn parse_while(&mut self) -> Result<Stmt, String> {
        self.advance(); // while
        self.expect(&Token::LParen)?;
        let cond = self.parse_expr()?;
        self.expect(&Token::RParen)?;
        self.skip_terminators();
        let body = self.parse_stmt()?;
        Ok(Stmt::While(cond, Box::new(body)))
    }

    fn parse_do_while(&mut self) -> Result<Stmt, String> {
        self.advance(); // do
        self.skip_terminators();
        let body = self.parse_stmt()?;
        self.skip_terminators();
        self.expect(&Token::While)?;
        self.expect(&Token::LParen)?;
        let cond = self.parse_expr()?;
        self.expect(&Token::RParen)?;
        self.skip_opt_semi();
        Ok(Stmt::DoWhile(Box::new(body), cond))
    }

    fn parse_for(&mut self) -> Result<Stmt, String> {
        self.advance(); // for
        self.expect(&Token::LParen)?;
        // Check for for-in: for (var in array)
        let save = self.pos;
        if let Some(Token::Ident(var)) = self.peek().cloned() {
            self.advance();
            if self.peek() == Some(&Token::In) {
                self.advance();
                if let Some(Token::Ident(arr)) = self.advance() {
                    self.expect(&Token::RParen)?;
                    self.skip_terminators();
                    let body = self.parse_stmt()?;
                    return Ok(Stmt::ForIn(var, arr, Box::new(body)));
                }
            }
        }
        self.pos = save;
        // Regular for
        let init = if self.peek() != Some(&Token::Semi) {
            let e = self.parse_expr()?;
            Some(Box::new(Stmt::Expr(e)))
        } else { None };
        self.expect(&Token::Semi)?;
        let cond = if self.peek() != Some(&Token::Semi) {
            Some(self.parse_expr()?)
        } else { None };
        self.expect(&Token::Semi)?;
        let incr = if self.peek() != Some(&Token::RParen) {
            let e = self.parse_expr()?;
            Some(Box::new(Stmt::Expr(e)))
        } else { None };
        self.expect(&Token::RParen)?;
        self.skip_terminators();
        let body = self.parse_stmt()?;
        Ok(Stmt::For(init, cond, incr, Box::new(body)))
    }

    fn parse_delete(&mut self) -> Result<Stmt, String> {
        self.advance(); // delete
        let name = match self.advance() {
            Some(Token::Ident(n)) => n,
            _ => return Err("expected array name after delete".into()),
        };
        if self.peek() == Some(&Token::LBracket) {
            self.advance();
            let mut subs = Vec::new();
            if self.peek() != Some(&Token::RBracket) {
                subs.push(self.parse_expr()?);
                while self.peek() == Some(&Token::Comma) {
                    self.advance();
                    subs.push(self.parse_expr()?);
                }
            }
            self.expect(&Token::RBracket)?;
            self.skip_opt_semi();
            if subs.is_empty() {
                Ok(Stmt::DeleteAll(name))
            } else {
                Ok(Stmt::Delete(name, subs))
            }
        } else {
            self.skip_opt_semi();
            Ok(Stmt::DeleteAll(name))
        }
    }

    fn parse_print(&mut self) -> Result<Stmt, String> {
        self.advance(); // print
        self.in_print = true;
        let mut exprs = Vec::new();
        if self.is_expr_start() {
            exprs.push(self.parse_non_assign_expr()?);
            while self.peek() == Some(&Token::Comma) {
                self.advance();
                exprs.push(self.parse_non_assign_expr()?);
            }
        }
        self.in_print = false;
        let dest = self.parse_output_dest()?;
        if exprs.is_empty() {
            exprs.push(Expr::Field(Box::new(Expr::Num(0.0))));
        }
        self.skip_opt_semi();
        Ok(Stmt::Print(exprs, dest))
    }

    fn parse_printf(&mut self) -> Result<Stmt, String> {
        self.advance(); // printf
        self.in_print = true;
        let mut exprs = Vec::new();
        if self.is_expr_start() {
            exprs.push(self.parse_non_assign_expr()?);
            while self.peek() == Some(&Token::Comma) {
                self.advance();
                exprs.push(self.parse_non_assign_expr()?);
            }
        }
        self.in_print = false;
        let dest = self.parse_output_dest()?;
        self.skip_opt_semi();
        Ok(Stmt::Printf(exprs, dest))
    }

    fn parse_output_dest(&mut self) -> Result<Option<OutputDest>, String> {
        match self.peek() {
            Some(Token::Gt) => {
                self.advance();
                let e = self.parse_primary()?;
                Ok(Some(OutputDest::File(e)))
            }
            Some(Token::Append) => {
                self.advance();
                let e = self.parse_primary()?;
                Ok(Some(OutputDest::Append(e)))
            }
            Some(Token::Pipe) => {
                self.advance();
                let e = self.parse_primary()?;
                Ok(Some(OutputDest::Pipe(e)))
            }
            _ => Ok(None),
        }
    }

    // Expression parsing with precedence climbing
    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_assign()
    }

    fn parse_non_assign_expr(&mut self) -> Result<Expr, String> {
        self.parse_ternary()
    }

    fn parse_assign(&mut self) -> Result<Expr, String> {
        let lhs = self.parse_ternary()?;
        match self.peek() {
            Some(Token::Assign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::Assign(Box::new(lhs), Box::new(rhs))) }
            Some(Token::PlusAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("+".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::MinusAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("-".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::StarAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("*".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::SlashAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("/".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::PercentAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("%".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::CaretAssign) => { self.advance(); let rhs = self.parse_assign()?; Ok(Expr::OpAssign("^".into(), Box::new(lhs), Box::new(rhs))) }
            _ => Ok(lhs),
        }
    }

    fn parse_ternary(&mut self) -> Result<Expr, String> {
        let cond = self.parse_or()?;
        if self.peek() == Some(&Token::Question) {
            self.advance();
            let t = self.parse_assign()?;
            self.expect(&Token::Colon)?;
            let f = self.parse_assign()?;
            Ok(Expr::Ternary(Box::new(cond), Box::new(t), Box::new(f)))
        } else { Ok(cond) }
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_and()?;
        while self.peek() == Some(&Token::Or) {
            self.advance();
            let rhs = self.parse_and()?;
            lhs = Expr::Binop("||".into(), Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_in_expr()?;
        while self.peek() == Some(&Token::And) {
            self.advance();
            let rhs = self.parse_in_expr()?;
            lhs = Expr::Binop("&&".into(), Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn parse_in_expr(&mut self) -> Result<Expr, String> {
        let lhs = self.parse_match()?;
        if self.peek() == Some(&Token::In) {
            self.advance();
            if let Some(Token::Ident(arr)) = self.advance() {
                return Ok(Expr::In(Box::new(lhs), arr));
            }
            return Err("expected array name after 'in'".into());
        }
        // Check for (expr, expr, ...) in arr — multi-dimensional in
        // This is handled at the primary level when parenthesized tuple is parsed
        Ok(lhs)
    }

    fn parse_paren_in(&mut self) -> Option<Result<Expr, String>> {
        // Called when we see ( in expression context — check if it's (e1,e2) in arr
        let save = self.pos;
        let saved_print = self.in_print;
        self.in_print = false;
        self.advance(); // consume (
        let mut exprs = vec![];
        match self.parse_expr() {
            Ok(e) => exprs.push(e),
            Err(_) => { self.pos = save; self.in_print = saved_print; return None; }
        }
        if self.peek() != Some(&Token::Comma) {
            self.pos = save; self.in_print = saved_print;
            return None;
        }
        while self.peek() == Some(&Token::Comma) {
            self.advance();
            match self.parse_expr() {
                Ok(e) => exprs.push(e),
                Err(_) => { self.pos = save; self.in_print = saved_print; return None; }
            }
        }
        if self.peek() != Some(&Token::RParen) {
            self.pos = save; self.in_print = saved_print;
            return None;
        }
        self.advance(); // consume )
        if self.peek() != Some(&Token::In) {
            self.pos = save; self.in_print = saved_print;
            return None;
        }
        self.in_print = saved_print;
        self.advance(); // consume in
        match self.advance() {
            Some(Token::Ident(arr)) => {
                // Build SUBSEP-concatenated key expression
                let key = if exprs.len() == 1 {
                    exprs.into_iter().next().unwrap()
                } else {
                    // Concatenate with SUBSEP: expr1 SUBSEP expr2 SUBSEP expr3...
                    let mut iter = exprs.into_iter();
                    let mut combined = iter.next().unwrap();
                    for e in iter {
                        combined = Expr::Concat(
                            Box::new(Expr::Concat(
                                Box::new(combined),
                                Box::new(Expr::Var("SUBSEP".to_string())),
                            )),
                            Box::new(e),
                        );
                    }
                    combined
                };
                Some(Ok(Expr::In(Box::new(key), arr)))
            }
            _ => { self.pos = save; self.in_print = saved_print; None }
        }
    }

    fn parse_match(&mut self) -> Result<Expr, String> {
        let lhs = self.parse_comparison()?;
        match self.peek() {
            Some(Token::Match) => {
                self.advance();
                let rhs = self.parse_primary()?;
                Ok(Expr::MatchOp(Box::new(lhs), Box::new(rhs)))
            }
            Some(Token::NotMatch) => {
                self.advance();
                let rhs = self.parse_primary()?;
                Ok(Expr::NotMatchOp(Box::new(lhs), Box::new(rhs)))
            }
            _ => Ok(lhs),
        }
    }

    fn parse_comparison(&mut self) -> Result<Expr, String> {
        let lhs = self.parse_concat()?;
        match self.peek() {
            Some(Token::Lt) => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop("<".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::Le) => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop("<=".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::Gt) if !self.in_print => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop(">".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::Ge) if !self.in_print => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop(">=".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::Eq) => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop("==".into(), Box::new(lhs), Box::new(rhs))) }
            Some(Token::Ne) => { self.advance(); let rhs = self.parse_concat()?; Ok(Expr::Binop("!=".into(), Box::new(lhs), Box::new(rhs))) }
            _ => Ok(lhs),
        }
    }

    fn parse_concat(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_addition()?;
        while self.is_concat_start() {
            let rhs = self.parse_addition()?;
            lhs = Expr::Concat(Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }

    fn is_concat_start(&self) -> bool {
        matches!(self.peek(), Some(Token::Num(_)) | Some(Token::Str(_))
            | Some(Token::Ident(_)) | Some(Token::Dollar) | Some(Token::LParen)
            | Some(Token::Not) | Some(Token::Incr) | Some(Token::Decr))
    }

    fn parse_addition(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_multiplication()?;
        loop {
            match self.peek() {
                Some(Token::Plus) => { self.advance(); let rhs = self.parse_multiplication()?; lhs = Expr::Binop("+".into(), Box::new(lhs), Box::new(rhs)); }
                Some(Token::Minus) => { self.advance(); let rhs = self.parse_multiplication()?; lhs = Expr::Binop("-".into(), Box::new(lhs), Box::new(rhs)); }
                _ => break,
            }
        }
        Ok(lhs)
    }

    fn parse_multiplication(&mut self) -> Result<Expr, String> {
        let mut lhs = self.parse_power()?;
        loop {
            match self.peek() {
                Some(Token::Star) => { self.advance(); let rhs = self.parse_power()?; lhs = Expr::Binop("*".into(), Box::new(lhs), Box::new(rhs)); }
                Some(Token::Slash) => { self.advance(); let rhs = self.parse_power()?; lhs = Expr::Binop("/".into(), Box::new(lhs), Box::new(rhs)); }
                Some(Token::Percent) => { self.advance(); let rhs = self.parse_power()?; lhs = Expr::Binop("%".into(), Box::new(lhs), Box::new(rhs)); }
                _ => break,
            }
        }
        Ok(lhs)
    }

    fn parse_power(&mut self) -> Result<Expr, String> {
        let base = self.parse_unary()?;
        if self.peek() == Some(&Token::Caret) {
            self.advance();
            let exp = self.parse_unary()?;
            Ok(Expr::Binop("^".into(), Box::new(base), Box::new(exp)))
        } else { Ok(base) }
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        match self.peek() {
            Some(Token::Not) => { self.advance(); let e = self.parse_unary()?; Ok(Expr::Not(Box::new(e))) }
            Some(Token::Minus) => { self.advance(); let e = self.parse_unary()?; Ok(Expr::Unary("-".into(), Box::new(e))) }
            Some(Token::Plus) => { self.advance(); self.parse_unary() }
            Some(Token::Incr) => { self.advance(); let e = self.parse_unary()?; Ok(Expr::PreIncr(Box::new(e))) }
            Some(Token::Decr) => { self.advance(); let e = self.parse_unary()?; Ok(Expr::PreDecr(Box::new(e))) }
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.parse_primary()?;
        loop {
            match self.peek() {
                Some(Token::Incr) => { self.advance(); e = Expr::PostIncr(Box::new(e)); }
                Some(Token::Decr) => { self.advance(); e = Expr::PostDecr(Box::new(e)); }
                Some(Token::LBracket) => {
                    if let Expr::Var(name) = e {
                        self.advance();
                        let mut subs = vec![self.parse_expr()?];
                        while self.peek() == Some(&Token::Comma) {
                            self.advance();
                            subs.push(self.parse_expr()?);
                        }
                        self.expect(&Token::RBracket)?;
                        e = Expr::Array(name, subs);
                    } else { break; }
                }
                _ => break,
            }
        }
        Ok(e)
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.peek().cloned() {
            Some(Token::Num(n)) => { self.advance(); Ok(Expr::Num(n)) }
            Some(Token::Str(s)) => { self.advance(); Ok(Expr::Str(s)) }
            Some(Token::Regex(r)) => { self.advance(); Ok(Expr::Regex(r)) }
            Some(Token::Dollar) => {
                self.advance();
                let e = self.parse_primary()?;
                Ok(Expr::Field(Box::new(e)))
            }
            Some(Token::LParen) => {
                // Try multi-dimensional (i,j) in arr first
                if let Some(result) = self.parse_paren_in() {
                    return result;
                }
                self.advance();
                let saved = self.in_print;
                self.in_print = false;
                let e = self.parse_expr()?;
                self.in_print = saved;
                self.expect(&Token::RParen)?;
                Ok(e)
            }
            Some(Token::Getline) => {
                self.advance();
                let var = if let Some(Token::Ident(_)) = self.peek() {
                    if self.peek() != Some(&Token::In) {
                        Some(Box::new(self.parse_primary()?))
                    } else { None }
                } else { None };
                let file = if self.peek() == Some(&Token::Lt) {
                    self.advance();
                    Some(Box::new(self.parse_primary()?))
                } else { None };
                Ok(Expr::Getline(var, file))
            }
            Some(Token::Ident(name)) => {
                self.advance();
                if self.peek() == Some(&Token::LParen) {
                    // function call
                    self.advance();
                    let mut call_args = Vec::new();
                    while self.peek() != Some(&Token::RParen) && !self.at_end() {
                        call_args.push(self.parse_expr()?);
                        if self.peek() == Some(&Token::Comma) { self.advance(); }
                    }
                    self.expect(&Token::RParen)?;
                    if name == "sprintf" {
                        Ok(Expr::Sprintf(call_args))
                    } else {
                        Ok(Expr::Call(name, call_args))
                    }
                } else if self.peek() == Some(&Token::LBracket) {
                    self.advance();
                    let mut subs = vec![self.parse_expr()?];
                    while self.peek() == Some(&Token::Comma) {
                        self.advance();
                        subs.push(self.parse_expr()?);
                    }
                    self.expect(&Token::RBracket)?;
                    Ok(Expr::Array(name, subs))
                } else {
                    Ok(Expr::Var(name))
                }
            }
            _ => Err(format!("unexpected token: {:?}", self.peek())),
        }
    }
}

fn parse(tokens: &[Token]) -> Result<Program, String> {
    let mut parser = Parser::new(tokens.to_vec());
    parser.parse_program()
}

// === Values and Interpreter ===

#[derive(Debug, Clone)]
enum Value {
    Num(f64),
    Str(String),
    Uninit,
}

impl Value {
    fn to_num(&self) -> f64 {
        match self {
            Value::Num(n) => *n,
            Value::Str(s) => parse_num_str(s),
            Value::Uninit => 0.0,
        }
    }

    fn to_str(&self, ofmt: &str) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Num(n) => format_num(*n, ofmt),
            Value::Uninit => String::new(),
        }
    }

    fn to_bool(&self) -> bool {
        match self {
            Value::Num(n) => *n != 0.0,
            Value::Str(s) => !s.is_empty(),
            Value::Uninit => false,
        }
    }

    fn is_numeric_string(&self) -> bool {
        match self {
            Value::Num(_) => true,
            Value::Str(s) => {
                let t = s.trim();
                !t.is_empty() && t.parse::<f64>().is_ok()
            }
            Value::Uninit => true,
        }
    }
}

fn parse_num_str(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() { return 0.0; }
    // Handle hex
    if t.starts_with("0x") || t.starts_with("0X") {
        if let Ok(v) = u64::from_str_radix(&t[2..], 16) { return v as f64; }
    }
    // Parse as much as possible as a number (leading numeric prefix)
    let mut end = 0;
    let chars: Vec<char> = t.chars().collect();
    if !chars.is_empty() && (chars[0] == '-' || chars[0] == '+') { end += 1; }
    while end < chars.len() && chars[end].is_ascii_digit() { end += 1; }
    if end < chars.len() && chars[end] == '.' { end += 1; while end < chars.len() && chars[end].is_ascii_digit() { end += 1; } }
    if end < chars.len() && (chars[end] == 'e' || chars[end] == 'E') {
        end += 1;
        if end < chars.len() && (chars[end] == '+' || chars[end] == '-') { end += 1; }
        while end < chars.len() && chars[end].is_ascii_digit() { end += 1; }
    }
    let num_part: String = chars[..end].iter().collect();
    num_part.parse::<f64>().unwrap_or(0.0)
}

fn format_num(n: f64, ofmt: &str) -> String {
    if n == n.floor() && n.abs() < 1e16 && !ofmt.contains('e') && !ofmt.contains('E') {
        format!("{}", n as i64)
    } else {
        sprintf_single(ofmt, &Value::Num(n))
    }
}

enum Signal {
    None,
    Break,
    Continue,
    Next,
    Exit(u8),
    Return(Value),
}

struct Interpreter {
    globals: HashMap<String, Value>,
    arrays: HashMap<String, HashMap<String, Value>>,
    fields: Vec<String>,
    record: String,
    nr: usize,
    fnr: usize,
    filename: String,
    functions: HashMap<String, FuncDef>,
    rng_state: u64,
    file_cache: HashMap<String, Vec<String>>,
    file_line_idx: HashMap<String, usize>,
    output_files: HashMap<String, bool>,
    input_records: Vec<String>,
    input_pos: usize,
    range_active: Vec<bool>,
    ofmt: String,
    convfmt: String,
}

impl Interpreter {
    fn new() -> Self {
        Self {
            globals: HashMap::new(),
            arrays: HashMap::new(),
            fields: Vec::new(),
            record: String::new(),
            nr: 0,
            fnr: 0,
            filename: String::new(),
            functions: HashMap::new(),
            rng_state: 12345,
            file_cache: HashMap::new(),
            file_line_idx: HashMap::new(),
            output_files: HashMap::new(),
            input_records: Vec::new(),
            input_pos: usize::MAX,
            range_active: Vec::new(),
            ofmt: "%.6g".to_string(),
            convfmt: "%.6g".to_string(),
        }
    }

    fn set_global(&mut self, name: &str, val: Value) {
        self.globals.insert(name.to_string(), val);
    }

    fn set_array_elem(&mut self, arr: &str, key: &Value, val: Value) {
        let k = key.to_str(&self.ofmt);
        self.arrays.entry(arr.to_string()).or_default().insert(k, val);
    }

    fn get_var(&self, name: &str) -> Value {
        match name {
            "NR" => Value::Num(self.nr as f64),
            "NF" => Value::Num(self.fields.len() as f64),
            "FNR" => Value::Num(self.fnr as f64),
            "FS" => self.globals.get("FS").cloned().unwrap_or(Value::Str(" ".to_string())),
            "OFS" => self.globals.get("OFS").cloned().unwrap_or(Value::Str(" ".to_string())),
            "RS" => self.globals.get("RS").cloned().unwrap_or(Value::Str("\n".to_string())),
            "ORS" => self.globals.get("ORS").cloned().unwrap_or(Value::Str("\n".to_string())),
            "FILENAME" => Value::Str(self.filename.clone()),
            "SUBSEP" => self.globals.get("SUBSEP").cloned().unwrap_or(Value::Str("\x1c".to_string())),
            "RSTART" => self.globals.get("RSTART").cloned().unwrap_or(Value::Num(0.0)),
            "RLENGTH" => self.globals.get("RLENGTH").cloned().unwrap_or(Value::Num(-1.0)),
            "OFMT" => Value::Str(self.ofmt.clone()),
            "CONVFMT" => Value::Str(self.convfmt.clone()),
            _ => self.globals.get(name).cloned().unwrap_or(Value::Uninit),
        }
    }

    fn set_var(&mut self, name: &str, val: Value) {
        match name {
            "NR" => self.nr = val.to_num() as usize,
            "NF" => {
                let n = val.to_num() as usize;
                self.fields.resize(n, String::new());
                self.rebuild_record();
            }
            "FNR" => self.fnr = val.to_num() as usize,
            "FS" | "OFS" | "RS" | "ORS" | "SUBSEP" | "RSTART" | "RLENGTH" | "ARGC" => {
                self.globals.insert(name.to_string(), val);
            }
            "OFMT" => { self.ofmt = val.to_str(&self.ofmt); }
            "CONVFMT" => { self.convfmt = val.to_str(&self.ofmt); }
            "$0" => unreachable!(),
            _ => { self.globals.insert(name.to_string(), val); }
        }
    }

    fn get_field(&self, idx: usize) -> Value {
        if idx == 0 {
            Value::Str(self.record.clone())
        } else if idx <= self.fields.len() {
            Value::Str(self.fields[idx - 1].clone())
        } else {
            Value::Str(String::new())
        }
    }

    fn set_field(&mut self, idx: usize, val: &str) {
        if idx == 0 {
            self.record = val.to_string();
            self.split_record();
        } else {
            while self.fields.len() < idx {
                self.fields.push(String::new());
            }
            self.fields[idx - 1] = val.to_string();
            self.rebuild_record();
        }
    }

    fn rebuild_record(&mut self) {
        let ofs = match self.globals.get("OFS") {
            Some(Value::Str(s)) => s.clone(),
            _ => " ".to_string(),
        };
        self.record = self.fields.join(&ofs);
    }

    fn split_record(&mut self) {
        let fs = match self.globals.get("FS") {
            Some(Value::Str(s)) => s.clone(),
            _ => " ".to_string(),
        };
        self.fields = split_by_fs(&self.record, &fs);
    }

    fn set_record(&mut self, rec: &str) {
        self.record = rec.to_string();
        self.split_record();
    }

    fn exec(&mut self, program: &Program, file_args: &[&str]) -> Result<u8, String> {
        for f in &program.functions {
            self.functions.insert(f.name.clone(), f.clone());
        }
        self.range_active = vec![false; program.rules.len()];

        // Run BEGIN rules
        for rule in &program.rules {
            if matches!(&rule.pattern, Some(Pattern::Begin)) {
                match self.exec_stmts(&rule.action, &mut HashMap::new())? {
                    Signal::Exit(c) => return Ok(c),
                    _ => {}
                }
            }
        }

        // Process input — skip only if purely BEGIN-only (no main rules AND no END rules)
        let has_main_rules = program.rules.iter().any(|r| !matches!(&r.pattern, Some(Pattern::Begin) | Some(Pattern::End)));
        let has_end_rules = program.rules.iter().any(|r| matches!(&r.pattern, Some(Pattern::End)));
        if !has_main_rules && !has_end_rules && file_args.is_empty() {
            // Only BEGIN rules, no END, no files — don't read stdin
        } else if file_args.is_empty() {
            let data = read_stdin_all();
            let text = String::from_utf8_lossy(&data).to_string();
            self.filename = String::new();
            self.fnr = 0;
            self.input_records = split_records(&text, &self.get_rs());
            self.input_pos = 0;
            while self.input_pos < self.input_records.len() {
                let rec = self.input_records[self.input_pos].clone();
                self.input_pos += 1;
                self.nr += 1;
                self.fnr += 1;
                self.set_record(&rec);
                match self.exec_rules(program)? {
                    Signal::Exit(c) => return Ok(c),
                    _ => {}
                }
            }
        } else {
            for &file in file_args {
                let data = if file == "-" {
                    read_stdin_all()
                } else {
                    match read_file(file) {
                        Some(d) => d,
                        None => {
                            write_stderr(&format!("awk: can't open file '{}'\n", file));
                            continue;
                        }
                    }
                };
                let text = String::from_utf8_lossy(&data).to_string();
                self.filename = file.to_string();
                self.fnr = 0;
                self.range_active = vec![false; program.rules.len()];
                self.input_records = split_records(&text, &self.get_rs());
                self.input_pos = 0;
                while self.input_pos < self.input_records.len() {
                    let rec = self.input_records[self.input_pos].clone();
                    self.input_pos += 1;
                    self.nr += 1;
                    self.fnr += 1;
                    self.set_record(&rec);
                    match self.exec_rules(program)? {
                        Signal::Exit(c) => return Ok(c),
                        _ => {}
                    }
                }
            }
        }

        // Run END rules
        for rule in &program.rules {
            if matches!(&rule.pattern, Some(Pattern::End)) {
                match self.exec_stmts(&rule.action, &mut HashMap::new())? {
                    Signal::Exit(c) => return Ok(c),
                    _ => {}
                }
            }
        }

        Ok(0)
    }

    fn get_rs(&self) -> String {
        match self.globals.get("RS") {
            Some(Value::Str(s)) => s.clone(),
            _ => "\n".to_string(),
        }
    }

    fn exec_rules(&mut self, program: &Program) -> Result<Signal, String> {
        for (i, rule) in program.rules.iter().enumerate() {
            let should_run = match &rule.pattern {
                None => true,
                Some(Pattern::Begin) | Some(Pattern::End) => false,
                Some(Pattern::Expr(e)) => {
                    let v = self.eval_expr(e, &mut HashMap::new())?;
                    self.value_is_true(&v, e)
                }
                Some(Pattern::Range(start, end)) => {
                    if !self.range_active[i] {
                        let v = self.eval_expr(start, &mut HashMap::new())?;
                        if self.value_is_true(&v, start) {
                            self.range_active[i] = true;
                            true
                        } else { false }
                    } else {
                        let v = self.eval_expr(end, &mut HashMap::new())?;
                        if self.value_is_true(&v, end) {
                            self.range_active[i] = false;
                        }
                        true
                    }
                }
            };
            if should_run {
                match self.exec_stmts(&rule.action, &mut HashMap::new())? {
                    Signal::Next => return Ok(Signal::None),
                    Signal::Exit(c) => return Ok(Signal::Exit(c)),
                    _ => {}
                }
            }
        }
        Ok(Signal::None)
    }

    fn value_is_true(&self, v: &Value, expr: &Expr) -> bool {
        match expr {
            Expr::Regex(r) => {
                regex_match(r, &self.record)
            }
            _ => v.to_bool(),
        }
    }

    fn exec_stmts(&mut self, stmts: &[Stmt], locals: &mut HashMap<String, Value>) -> Result<Signal, String> {
        for stmt in stmts {
            match self.exec_stmt(stmt, locals)? {
                Signal::None => {}
                s => return Ok(s),
            }
        }
        Ok(Signal::None)
    }

    fn exec_stmt(&mut self, stmt: &Stmt, locals: &mut HashMap<String, Value>) -> Result<Signal, String> {
        match stmt {
            Stmt::Expr(e) => { self.eval_expr(e, locals)?; Ok(Signal::None) }
            Stmt::Print(exprs, dest) => { self.exec_print(exprs, dest, locals)?; Ok(Signal::None) }
            Stmt::Printf(exprs, dest) => { self.exec_printf(exprs, dest, locals)?; Ok(Signal::None) }
            Stmt::If(cond, body, else_body) => {
                let v = self.eval_expr(cond, locals)?;
                if v.to_bool() {
                    self.exec_stmt(body, locals)
                } else if let Some(eb) = else_body {
                    self.exec_stmt(eb, locals)
                } else { Ok(Signal::None) }
            }
            Stmt::While(cond, body) => {
                loop {
                    let v = self.eval_expr(cond, locals)?;
                    if !v.to_bool() { break; }
                    match self.exec_stmt(body, locals)? {
                        Signal::Break => break,
                        Signal::Continue => continue,
                        Signal::None => {}
                        s => return Ok(s),
                    }
                }
                Ok(Signal::None)
            }
            Stmt::DoWhile(body, cond) => {
                loop {
                    match self.exec_stmt(body, locals)? {
                        Signal::Break => break,
                        Signal::Continue => {}
                        Signal::None => {}
                        s => return Ok(s),
                    }
                    let v = self.eval_expr(cond, locals)?;
                    if !v.to_bool() { break; }
                }
                Ok(Signal::None)
            }
            Stmt::For(init, cond, incr, body) => {
                if let Some(i) = init { self.exec_stmt(i, locals)?; }
                loop {
                    if let Some(c) = cond {
                        let v = self.eval_expr(c, locals)?;
                        if !v.to_bool() { break; }
                    }
                    match self.exec_stmt(body, locals)? {
                        Signal::Break => break,
                        Signal::Continue => {}
                        Signal::None => {}
                        s => return Ok(s),
                    }
                    if let Some(inc) = incr { self.exec_stmt(inc, locals)?; }
                }
                Ok(Signal::None)
            }
            Stmt::ForIn(var, arr, body) => {
                let keys: Vec<String> = self.arrays.get(arr).map(|m| m.keys().cloned().collect()).unwrap_or_default();
                for k in keys {
                    self.set_var_local(var, Value::Str(k), locals);
                    match self.exec_stmt(body, locals)? {
                        Signal::Break => break,
                        Signal::Continue => continue,
                        Signal::None => {}
                        s => return Ok(s),
                    }
                }
                Ok(Signal::None)
            }
            Stmt::Block(stmts) => self.exec_stmts(stmts, locals),
            Stmt::Break => Ok(Signal::Break),
            Stmt::Continue => Ok(Signal::Continue),
            Stmt::Next => Ok(Signal::Next),
            Stmt::Exit(e) => {
                let code = if let Some(expr) = e {
                    self.eval_expr(expr, locals)?.to_num() as u8
                } else { 0 };
                Ok(Signal::Exit(code))
            }
            Stmt::Return(e) => {
                let val = if let Some(expr) = e {
                    self.eval_expr(expr, locals)?
                } else { Value::Uninit };
                Ok(Signal::Return(val))
            }
            Stmt::Delete(arr, subs) => {
                let key = self.build_array_key(subs, locals)?;
                if let Some(m) = self.arrays.get_mut(arr) { m.remove(&key); }
                Ok(Signal::None)
            }
            Stmt::DeleteAll(arr) => {
                self.arrays.remove(arr);
                Ok(Signal::None)
            }
        }
    }

    fn exec_print(&mut self, exprs: &[Expr], dest: &Option<OutputDest>, locals: &mut HashMap<String, Value>) -> Result<(), String> {
        let ofs = self.get_var("OFS").to_str(&self.ofmt);
        let ors = self.get_var("ORS").to_str(&self.ofmt);
        let parts: Vec<String> = exprs.iter().map(|e| {
            self.eval_expr(e, locals).map(|v| v.to_str(&self.ofmt))
        }).collect::<Result<Vec<_>, _>>()?;
        let output = format!("{}{}", parts.join(&ofs), ors);
        self.output_string(&output, dest, locals)
    }

    fn exec_printf(&mut self, exprs: &[Expr], dest: &Option<OutputDest>, locals: &mut HashMap<String, Value>) -> Result<(), String> {
        if exprs.is_empty() { return Ok(()); }
        let vals: Vec<Value> = exprs.iter().map(|e| self.eval_expr(e, locals)).collect::<Result<Vec<_>, _>>()?;
        let fmt_str = vals[0].to_str(&self.ofmt);
        let output = sprintf_format(&fmt_str, &vals[1..]);
        self.output_string(&output, dest, locals)
    }

    fn output_string(&mut self, s: &str, dest: &Option<OutputDest>, locals: &mut HashMap<String, Value>) -> Result<(), String> {
        match dest {
            None => write_stdout(s),
            Some(OutputDest::File(e)) => {
                let path = self.eval_expr(e, locals)?.to_str(&self.ofmt);
                if !self.output_files.contains_key(&path) {
                    write_file(&path, s.as_bytes());
                    self.output_files.insert(path, true);
                } else {
                    append_file(&path, s.as_bytes());
                }
            }
            Some(OutputDest::Append(e)) => {
                let path = self.eval_expr(e, locals)?.to_str(&self.ofmt);
                append_file(&path, s.as_bytes());
                self.output_files.insert(path, true);
            }
            Some(OutputDest::Pipe(_)) => {
                write_stderr("awk: pipes not supported in this environment\n");
            }
        }
        Ok(())
    }

    fn eval_expr(&mut self, expr: &Expr, locals: &mut HashMap<String, Value>) -> Result<Value, String> {
        match expr {
            Expr::Num(n) => Ok(Value::Num(*n)),
            Expr::Str(s) => Ok(Value::Str(s.clone())),
            Expr::Regex(r) => {
                // When regex appears as expr (not pattern), match against $0
                Ok(Value::Num(if regex_match(r, &self.record) { 1.0 } else { 0.0 }))
            }
            Expr::Var(name) => Ok(self.get_var_local(name, locals)),
            Expr::Field(e) => {
                let idx = self.eval_expr(e, locals)?.to_num() as usize;
                Ok(self.get_field(idx))
            }
            Expr::Array(name, subs) => {
                let key = self.build_array_key(subs, locals)?;
                let val = self.arrays.get(name).and_then(|m| m.get(&key)).cloned().unwrap_or(Value::Uninit);
                Ok(val)
            }
            Expr::Assign(lhs, rhs) => {
                let val = self.eval_expr(rhs, locals)?;
                self.assign_to(lhs, val.clone(), locals)?;
                Ok(val)
            }
            Expr::OpAssign(op, lhs, rhs) => {
                let left_val = self.eval_expr(lhs, locals)?;
                let right_val = self.eval_expr(rhs, locals)?;
                let result = self.apply_arith(op, &left_val, &right_val);
                self.assign_to(lhs, result.clone(), locals)?;
                Ok(result)
            }
            Expr::Binop(op, lhs, rhs) => {
                let l = self.eval_expr(lhs, locals)?;
                match op.as_str() {
                    "&&" => {
                        if !l.to_bool() { return Ok(Value::Num(0.0)); }
                        let r = self.eval_expr(rhs, locals)?;
                        Ok(Value::Num(if r.to_bool() { 1.0 } else { 0.0 }))
                    }
                    "||" => {
                        if l.to_bool() { return Ok(Value::Num(1.0)); }
                        let r = self.eval_expr(rhs, locals)?;
                        Ok(Value::Num(if r.to_bool() { 1.0 } else { 0.0 }))
                    }
                    "<" | "<=" | ">" | ">=" | "==" | "!=" => {
                        let r = self.eval_expr(rhs, locals)?;
                        Ok(Value::Num(if self.compare_values(op, &l, &r) { 1.0 } else { 0.0 }))
                    }
                    _ => {
                        let r = self.eval_expr(rhs, locals)?;
                        Ok(self.apply_arith(op, &l, &r))
                    }
                }
            }
            Expr::Unary(op, e) => {
                let v = self.eval_expr(e, locals)?;
                match op.as_str() {
                    "-" => Ok(Value::Num(-v.to_num())),
                    _ => Ok(v),
                }
            }
            Expr::Not(e) => {
                let v = self.eval_expr(e, locals)?;
                Ok(Value::Num(if v.to_bool() { 0.0 } else { 1.0 }))
            }
            Expr::PreIncr(e) => {
                let v = self.eval_expr(e, locals)?.to_num() + 1.0;
                let result = Value::Num(v);
                self.assign_to(e, result.clone(), locals)?;
                Ok(result)
            }
            Expr::PreDecr(e) => {
                let v = self.eval_expr(e, locals)?.to_num() - 1.0;
                let result = Value::Num(v);
                self.assign_to(e, result.clone(), locals)?;
                Ok(result)
            }
            Expr::PostIncr(e) => {
                let v = self.eval_expr(e, locals)?.to_num();
                self.assign_to(e, Value::Num(v + 1.0), locals)?;
                Ok(Value::Num(v))
            }
            Expr::PostDecr(e) => {
                let v = self.eval_expr(e, locals)?.to_num();
                self.assign_to(e, Value::Num(v - 1.0), locals)?;
                Ok(Value::Num(v))
            }
            Expr::Ternary(cond, t, f) => {
                let c = self.eval_expr(cond, locals)?;
                if c.to_bool() { self.eval_expr(t, locals) } else { self.eval_expr(f, locals) }
            }
            Expr::MatchOp(lhs, rhs) => {
                let s = self.eval_expr(lhs, locals)?.to_str(&self.ofmt);
                let pat = self.expr_to_regex(rhs, locals)?;
                Ok(Value::Num(if regex_match(&pat, &s) { 1.0 } else { 0.0 }))
            }
            Expr::NotMatchOp(lhs, rhs) => {
                let s = self.eval_expr(lhs, locals)?.to_str(&self.ofmt);
                let pat = self.expr_to_regex(rhs, locals)?;
                Ok(Value::Num(if regex_match(&pat, &s) { 0.0 } else { 1.0 }))
            }
            Expr::In(key_expr, arr) => {
                let key = self.eval_expr(key_expr, locals)?.to_str(&self.ofmt);
                let exists = self.arrays.get(arr).map(|m| m.contains_key(&key)).unwrap_or(false);
                Ok(Value::Num(if exists { 1.0 } else { 0.0 }))
            }
            Expr::Concat(lhs, rhs) => {
                let l = self.eval_expr(lhs, locals)?.to_str(&self.ofmt);
                let r = self.eval_expr(rhs, locals)?.to_str(&self.ofmt);
                Ok(Value::Str(format!("{}{}", l, r)))
            }
            Expr::Call(name, call_args) => self.call_func(name, call_args, locals),
            Expr::Getline(var, file) => self.exec_getline(var, file, locals),
            Expr::GetlinePipe(cmd, _var) => {
                let _ = self.eval_expr(cmd, locals)?;
                write_stderr("awk: pipes not supported in this environment\n");
                Ok(Value::Num(-1.0))
            }
            Expr::Sprintf(call_args) => {
                let vals: Vec<Value> = call_args.iter().map(|e| self.eval_expr(e, locals)).collect::<Result<Vec<_>, _>>()?;
                if vals.is_empty() { return Ok(Value::Str(String::new())); }
                let fmt = vals[0].to_str(&self.ofmt);
                Ok(Value::Str(sprintf_format(&fmt, &vals[1..])))
            }
        }
    }

    fn expr_to_regex(&mut self, expr: &Expr, locals: &mut HashMap<String, Value>) -> Result<String, String> {
        match expr {
            Expr::Regex(r) => Ok(r.clone()),
            _ => Ok(self.eval_expr(expr, locals)?.to_str(&self.ofmt)),
        }
    }

    fn compare_values(&self, op: &str, l: &Value, r: &Value) -> bool {
        if l.is_numeric_string() && r.is_numeric_string() {
            let ln = l.to_num();
            let rn = r.to_num();
            match op {
                "<" => ln < rn, "<=" => ln <= rn, ">" => ln > rn,
                ">=" => ln >= rn, "==" => ln == rn, "!=" => ln != rn,
                _ => false,
            }
        } else {
            let ls = l.to_str(&self.ofmt);
            let rs = r.to_str(&self.ofmt);
            match op {
                "<" => ls < rs, "<=" => ls <= rs, ">" => ls > rs,
                ">=" => ls >= rs, "==" => ls == rs, "!=" => ls != rs,
                _ => false,
            }
        }
    }

    fn apply_arith(&self, op: &str, l: &Value, r: &Value) -> Value {
        let ln = l.to_num();
        let rn = r.to_num();
        Value::Num(match op {
            "+" => ln + rn,
            "-" => ln - rn,
            "*" => ln * rn,
            "/" => if rn == 0.0 { write_stderr("awk: division by zero\n"); 0.0 } else { ln / rn },
            "%" => if rn == 0.0 { write_stderr("awk: division by zero\n"); 0.0 } else { ln % rn },
            "^" => ln.powf(rn),
            _ => 0.0,
        })
    }

    fn assign_to(&mut self, expr: &Expr, val: Value, locals: &mut HashMap<String, Value>) -> Result<(), String> {
        match expr {
            Expr::Var(name) => { self.set_var_local(name, val, locals); }
            Expr::Field(e) => {
                let idx = self.eval_expr(e, locals)?.to_num() as usize;
                self.set_field(idx, &val.to_str(&self.ofmt));
            }
            Expr::Array(name, subs) => {
                let key = self.build_array_key(subs, locals)?;
                self.arrays.entry(name.clone()).or_default().insert(key, val);
            }
            _ => {}
        }
        Ok(())
    }

    fn get_var_local(&self, name: &str, locals: &HashMap<String, Value>) -> Value {
        if let Some(v) = locals.get(name) { return v.clone(); }
        self.get_var(name)
    }

    fn set_var_local(&mut self, name: &str, val: Value, locals: &mut HashMap<String, Value>) {
        if locals.contains_key(name) {
            locals.insert(name.to_string(), val);
        } else {
            self.set_var(name, val);
        }
    }

    fn build_array_key(&mut self, subs: &[Expr], locals: &mut HashMap<String, Value>) -> Result<String, String> {
        let subsep = self.get_var("SUBSEP").to_str(&self.ofmt);
        let parts: Vec<String> = subs.iter().map(|e| {
            self.eval_expr(e, locals).map(|v| v.to_str(&self.ofmt))
        }).collect::<Result<Vec<_>, _>>()?;
        Ok(parts.join(&subsep))
    }

    fn exec_getline(&mut self, var: &Option<Box<Expr>>, file: &Option<Box<Expr>>, locals: &mut HashMap<String, Value>) -> Result<Value, String> {
        if let Some(file_expr) = file {
            let path = self.eval_expr(file_expr, locals)?.to_str(&self.ofmt);
            if !self.file_cache.contains_key(&path) {
                match read_file(&path) {
                    Some(data) => {
                        let text = String::from_utf8_lossy(&data).to_string();
                        let rs = self.get_rs();
                        let lines = split_records(&text, &rs);
                        self.file_cache.insert(path.clone(), lines);
                        self.file_line_idx.insert(path.clone(), 0);
                    }
                    None => return Ok(Value::Num(-1.0)),
                }
            }
            let idx = *self.file_line_idx.get(&path).unwrap_or(&0);
            let lines = self.file_cache.get(&path).unwrap();
            if idx >= lines.len() {
                return Ok(Value::Num(0.0));
            }
            let line = lines[idx].clone();
            self.file_line_idx.insert(path, idx + 1);
            if let Some(var_expr) = var {
                self.assign_to(var_expr, Value::Str(line), locals)?;
            } else {
                self.set_record(&line);
            }
            Ok(Value::Num(1.0))
        } else {
            // getline from current input stream — advance to next record
            if self.input_pos >= self.input_records.len() {
                return Ok(Value::Num(0.0));
            }
            let line = self.input_records[self.input_pos].clone();
            self.input_pos += 1;
            self.nr += 1;
            self.fnr += 1;
            if let Some(var_expr) = var {
                self.assign_to(var_expr, Value::Str(line), locals)?;
            } else {
                self.set_record(&line);
            }
            Ok(Value::Num(1.0))
        }
    }

    fn call_func(&mut self, name: &str, call_args: &[Expr], locals: &mut HashMap<String, Value>) -> Result<Value, String> {
        match name {
            "length" => {
                if call_args.is_empty() {
                    Ok(Value::Num(self.record.len() as f64))
                } else {
                    // Check if argument is array name
                    if let Expr::Var(arr_name) = &call_args[0] {
                        if self.arrays.contains_key(arr_name) {
                            return Ok(Value::Num(self.arrays[arr_name].len() as f64));
                        }
                    }
                    let v = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                    Ok(Value::Num(v.len() as f64))
                }
            }
            "substr" => {
                if call_args.len() < 2 { return Ok(Value::Str(String::new())); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                let start = (self.eval_expr(&call_args[1], locals)?.to_num() as isize).max(1) as usize - 1;
                if start >= s.len() { return Ok(Value::Str(String::new())); }
                let len = if call_args.len() > 2 {
                    self.eval_expr(&call_args[2], locals)?.to_num() as usize
                } else { s.len() - start };
                let end = (start + len).min(s.len());
                Ok(Value::Str(s[start..end].to_string()))
            }
            "index" => {
                if call_args.len() < 2 { return Ok(Value::Num(0.0)); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                let target = self.eval_expr(&call_args[1], locals)?.to_str(&self.ofmt);
                let pos = s.find(&target).map(|i| i + 1).unwrap_or(0);
                Ok(Value::Num(pos as f64))
            }
            "split" => {
                if call_args.len() < 2 { return Ok(Value::Num(0.0)); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                let arr_name = match &call_args[1] {
                    Expr::Var(n) | Expr::Array(n, _) => n.clone(),
                    _ => return Err("split: second arg must be array".into()),
                };
                let sep = if call_args.len() > 2 {
                    self.eval_expr(&call_args[2], locals)?.to_str(&self.ofmt)
                } else {
                    self.get_var("FS").to_str(&self.ofmt)
                };
                self.arrays.remove(&arr_name);
                let parts = split_by_fs(&s, &sep);
                let map = self.arrays.entry(arr_name).or_default();
                for (i, p) in parts.iter().enumerate() {
                    map.insert((i + 1).to_string(), Value::Str(p.clone()));
                }
                Ok(Value::Num(parts.len() as f64))
            }
            "sub" | "gsub" => {
                let global = name == "gsub";
                if call_args.len() < 2 { return Ok(Value::Num(0.0)); }
                let pat = self.expr_to_regex(&call_args[0], locals)?;
                let repl = self.eval_expr(&call_args[1], locals)?.to_str(&self.ofmt);
                let (target_str, target_expr) = if call_args.len() > 2 {
                    let s = self.eval_expr(&call_args[2], locals)?.to_str(&self.ofmt);
                    (s, Some(call_args[2].clone()))
                } else {
                    (self.record.clone(), None)
                };
                let (result, count) = regex_sub(&pat, &repl, &target_str, global);
                if let Some(te) = target_expr {
                    self.assign_to(&te, Value::Str(result), locals)?;
                } else {
                    self.set_field(0, &result);
                }
                Ok(Value::Num(count as f64))
            }
            "match" => {
                if call_args.len() < 2 { return Ok(Value::Num(0.0)); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                let pat = self.expr_to_regex(&call_args[1], locals)?;
                match regex_find(&pat, &s) {
                    Some((start, len)) => {
                        self.set_var("RSTART", Value::Num((start + 1) as f64));
                        self.set_var("RLENGTH", Value::Num(len as f64));
                        Ok(Value::Num((start + 1) as f64))
                    }
                    None => {
                        self.set_var("RSTART", Value::Num(0.0));
                        self.set_var("RLENGTH", Value::Num(-1.0));
                        Ok(Value::Num(0.0))
                    }
                }
            }
            "sprintf" => {
                let vals: Vec<Value> = call_args.iter().map(|e| self.eval_expr(e, locals)).collect::<Result<Vec<_>, _>>()?;
                if vals.is_empty() { return Ok(Value::Str(String::new())); }
                let fmt = vals[0].to_str(&self.ofmt);
                Ok(Value::Str(sprintf_format(&fmt, &vals[1..])))
            }
            "tolower" => {
                if call_args.is_empty() { return Ok(Value::Str(String::new())); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                Ok(Value::Str(s.to_lowercase()))
            }
            "toupper" => {
                if call_args.is_empty() { return Ok(Value::Str(String::new())); }
                let s = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                Ok(Value::Str(s.to_uppercase()))
            }
            "sin" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.sin())) }
            "cos" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.cos())) }
            "atan2" => {
                if call_args.len() < 2 { return Ok(Value::Num(0.0)); }
                let y = self.eval_expr(&call_args[0], locals)?.to_num();
                let x = self.eval_expr(&call_args[1], locals)?.to_num();
                Ok(Value::Num(y.atan2(x)))
            }
            "exp" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.exp())) }
            "log" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.ln())) }
            "sqrt" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.sqrt())) }
            "int" => { let v = self.eval_num_arg(call_args, locals)?; Ok(Value::Num(v.trunc())) }
            "rand" => {
                // xorshift64
                let mut x = self.rng_state;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                self.rng_state = x;
                Ok(Value::Num((x as f64) / (u64::MAX as f64)))
            }
            "srand" => {
                let old = self.rng_state;
                if !call_args.is_empty() {
                    let seed = self.eval_expr(&call_args[0], locals)?.to_num() as u64;
                    self.rng_state = if seed == 0 { 1 } else { seed };
                } else {
                    self.rng_state = self.nr as u64 + 1;
                }
                Ok(Value::Num(old as f64))
            }
            "system" => {
                if !call_args.is_empty() { self.eval_expr(&call_args[0], locals)?; }
                write_stderr("awk: system() not supported in this environment\n");
                Ok(Value::Num(-1.0))
            }
            "close" => {
                if !call_args.is_empty() {
                    let path = self.eval_expr(&call_args[0], locals)?.to_str(&self.ofmt);
                    self.file_cache.remove(&path);
                    self.file_line_idx.remove(&path);
                    self.output_files.remove(&path);
                }
                Ok(Value::Num(0.0))
            }
            _ => {
                // User-defined function
                let func = match self.functions.get(name) {
                    Some(f) => f.clone(),
                    None => return Err(format!("undefined function: {}", name)),
                };
                let mut new_locals: HashMap<String, Value> = HashMap::new();
                // Set up parameters including local variables (extra params)
                for (idx, param) in func.params.iter().enumerate() {
                    if idx < call_args.len() {
                        // Check if this is an array argument
                        if let Expr::Var(arr_name) = &call_args[idx] {
                            if self.arrays.contains_key(arr_name) {
                                // Pass array by reference: just use the same array name
                                // We'll map the param name to the caller's array name
                                let arr_data = self.arrays.get(arr_name).cloned().unwrap_or_default();
                                self.arrays.insert(param.clone(), arr_data);
                                new_locals.insert(param.clone(), Value::Uninit);
                                continue;
                            }
                        }
                        let val = self.eval_expr(&call_args[idx], locals)?;
                        new_locals.insert(param.clone(), val);
                    } else {
                        new_locals.insert(param.clone(), Value::Uninit);
                    }
                }
                match self.exec_stmts(&func.body, &mut new_locals)? {
                    Signal::Return(v) => Ok(v),
                    _ => Ok(Value::Uninit),
                }
            }
        }
    }

    fn eval_num_arg(&mut self, call_args: &[Expr], locals: &mut HashMap<String, Value>) -> Result<f64, String> {
        if call_args.is_empty() { return Ok(0.0); }
        Ok(self.eval_expr(&call_args[0], locals)?.to_num())
    }
}

// === Field / Record Splitting ===

fn split_by_fs(s: &str, fs: &str) -> Vec<String> {
    if s.is_empty() { return Vec::new(); }
    if fs == " " {
        // Default: split on runs of whitespace, trim leading/trailing
        s.split_whitespace().map(|p| p.to_string()).collect()
    } else if fs.len() == 1 {
        s.split(fs.chars().next().unwrap()).map(|p| p.to_string()).collect()
    } else {
        // Regex split
        regex_split(fs, s)
    }
}

fn split_records(text: &str, rs: &str) -> Vec<String> {
    if rs == "\n" {
        let mut records: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
        if records.last() == Some(&String::new()) { records.pop(); }
        records
    } else if rs.is_empty() {
        // Paragraph mode: split on blank lines
        let mut records = Vec::new();
        let mut current = String::new();
        for line in text.split('\n') {
            if line.is_empty() {
                if !current.is_empty() {
                    if current.ends_with('\n') { current.pop(); }
                    records.push(current);
                    current = String::new();
                }
            } else {
                if !current.is_empty() { current.push('\n'); }
                current.push_str(line);
            }
        }
        if !current.is_empty() {
            if current.ends_with('\n') { current.pop(); }
            records.push(current);
        }
        records
    } else if rs.len() == 1 {
        let sep = rs.chars().next().unwrap();
        let mut records: Vec<String> = text.split(sep).map(|s| s.to_string()).collect();
        if records.last() == Some(&String::new()) { records.pop(); }
        records
    } else {
        // Multi-char RS: use as regex
        let parts = regex_split(rs, text);
        let mut records: Vec<String> = parts;
        if records.last() == Some(&String::new()) { records.pop(); }
        records
    }
}

// === Regex Helpers ===

fn regex_match(pattern: &str, s: &str) -> bool {
    use regex::Regex;
    match Regex::new(pattern) {
        Ok(re) => re.is_match(s),
        Err(_) => false,
    }
}

fn regex_find(pattern: &str, s: &str) -> Option<(usize, usize)> {
    use regex::Regex;
    match Regex::new(pattern) {
        Ok(re) => re.find(s).map(|m| (m.start(), m.end() - m.start())),
        Err(_) => None,
    }
}

fn regex_sub(pattern: &str, replacement: &str, s: &str, global: bool) -> (String, usize) {
    use regex::Regex;
    let re = match Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => return (s.to_string(), 0),
    };
    let mut result = String::new();
    let mut count = 0;
    let mut last_end = 0;
    for mat in re.find_iter(s) {
        result.push_str(&s[last_end..mat.start()]);
        // Process replacement: & means matched text, \\ is literal backslash
        let matched = mat.as_str();
        let mut i = 0;
        let repl_chars: Vec<char> = replacement.chars().collect();
        while i < repl_chars.len() {
            if repl_chars[i] == '&' {
                result.push_str(matched);
            } else if repl_chars[i] == '\\' && i + 1 < repl_chars.len() {
                i += 1;
                if repl_chars[i] == '&' {
                    result.push('&');
                } else if repl_chars[i] == '\\' {
                    result.push('\\');
                } else {
                    result.push('\\');
                    result.push(repl_chars[i]);
                }
            } else {
                result.push(repl_chars[i]);
            }
            i += 1;
        }
        last_end = mat.end();
        count += 1;
        if !global { break; }
    }
    result.push_str(&s[last_end..]);
    (result, count)
}

fn regex_split(pattern: &str, s: &str) -> Vec<String> {
    use regex::Regex;
    match Regex::new(pattern) {
        Ok(re) => re.split(s).map(|p| p.to_string()).collect(),
        Err(_) => vec![s.to_string()],
    }
}

// === Printf / Sprintf ===

fn sprintf_format(fmt: &str, args: &[Value]) -> String {
    let mut result = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let len = chars.len();
    let mut i = 0;
    let mut arg_idx = 0;

    while i < len {
        if chars[i] == '%' {
            i += 1;
            if i >= len { break; }
            if chars[i] == '%' { result.push('%'); i += 1; continue; }

            // Parse flags
            let mut left_align = false;
            let mut plus_sign = false;
            let mut space_sign = false;
            let mut zero_pad = false;
            loop {
                if i >= len { break; }
                match chars[i] {
                    '-' => { left_align = true; i += 1; }
                    '+' => { plus_sign = true; i += 1; }
                    ' ' => { space_sign = true; i += 1; }
                    '0' => { zero_pad = true; i += 1; }
                    '#' => { i += 1; } // ignore #
                    _ => break,
                }
            }

            // Parse width
            let mut width: usize = 0;
            let mut width_from_arg = false;
            if i < len && chars[i] == '*' {
                width_from_arg = true;
                i += 1;
                if arg_idx < args.len() {
                    width = args[arg_idx].to_num() as usize;
                    arg_idx += 1;
                }
            } else {
                while i < len && chars[i].is_ascii_digit() {
                    width = width * 10 + (chars[i] as usize - '0' as usize);
                    i += 1;
                }
            }
            let _ = width_from_arg;

            // Parse precision
            let mut precision: Option<usize> = None;
            if i < len && chars[i] == '.' {
                i += 1;
                let mut prec = 0usize;
                if i < len && chars[i] == '*' {
                    i += 1;
                    if arg_idx < args.len() {
                        prec = args[arg_idx].to_num() as usize;
                        arg_idx += 1;
                    }
                } else {
                    while i < len && chars[i].is_ascii_digit() {
                        prec = prec * 10 + (chars[i] as usize - '0' as usize);
                        i += 1;
                    }
                }
                precision = Some(prec);
            }

            if i >= len { break; }
            let spec = chars[i];
            i += 1;

            let arg_val = if arg_idx < args.len() { &args[arg_idx] } else { &Value::Uninit };
            arg_idx += 1;

            let formatted = match spec {
                'd' | 'i' => {
                    let n = arg_val.to_num() as i64;
                    let s = if plus_sign && n >= 0 { format!("+{}", n) }
                        else if space_sign && n >= 0 { format!(" {}", n) }
                        else { format!("{}", n) };
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'o' => {
                    let n = arg_val.to_num() as u64;
                    let s = format!("{:o}", n);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'x' => {
                    let n = arg_val.to_num() as u64;
                    let s = format!("{:x}", n);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'X' => {
                    let n = arg_val.to_num() as u64;
                    let s = format!("{:X}", n);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'f' => {
                    let n = arg_val.to_num();
                    let prec = precision.unwrap_or(6);
                    let s = format_float_f(n, prec, plus_sign, space_sign);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'e' | 'E' => {
                    let n = arg_val.to_num();
                    let prec = precision.unwrap_or(6);
                    let s = format_float_e(n, prec, spec == 'E', plus_sign, space_sign);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                'g' | 'G' => {
                    let n = arg_val.to_num();
                    let prec = precision.unwrap_or(6).max(1);
                    let s = format_float_g(n, prec, spec == 'G', plus_sign, space_sign);
                    pad_string(&s, width, left_align, if zero_pad && !left_align { '0' } else { ' ' })
                }
                's' => {
                    let s = arg_val.to_str(&"%.6g".to_string());
                    let s = if let Some(prec) = precision {
                        if prec < s.len() { s[..prec].to_string() } else { s }
                    } else { s };
                    pad_string(&s, width, left_align, ' ')
                }
                'c' => {
                    let ch = match arg_val {
                        Value::Num(n) => char::from_u32(*n as u32).unwrap_or('\0'),
                        Value::Str(s) => s.chars().next().unwrap_or('\0'),
                        Value::Uninit => '\0',
                    };
                    let s = ch.to_string();
                    pad_string(&s, width, left_align, ' ')
                }
                _ => format!("%{}", spec),
            };
            result.push_str(&formatted);
        } else if chars[i] == '\\' && i + 1 < len {
            i += 1;
            match chars[i] {
                'n' => result.push('\n'),
                't' => result.push('\t'),
                'r' => result.push('\r'),
                '\\' => result.push('\\'),
                '"' => result.push('"'),
                'a' => result.push('\x07'),
                'b' => result.push('\x08'),
                'f' => result.push('\x0c'),
                '/' => result.push('/'),
                c => { result.push('\\'); result.push(c); }
            }
            i += 1;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

fn sprintf_single(fmt: &str, val: &Value) -> String {
    sprintf_format(fmt, &[val.clone()])
}

fn pad_string(s: &str, width: usize, left_align: bool, pad_char: char) -> String {
    if s.len() >= width { return s.to_string(); }
    let padding = width - s.len();
    let pad: String = std::iter::repeat(pad_char).take(padding).collect();
    if left_align {
        format!("{}{}", s, " ".repeat(padding))
    } else {
        // For zero-padding with sign, keep sign before zeros
        if pad_char == '0' && !s.is_empty() && (s.starts_with('-') || s.starts_with('+') || s.starts_with(' ')) {
            let (sign, rest) = s.split_at(1);
            format!("{}{}{}", sign, pad, rest)
        } else {
            format!("{}{}", pad, s)
        }
    }
}

fn format_float_f(n: f64, prec: usize, plus: bool, space: bool) -> String {
    let s = format!("{:.prec$}", n, prec = prec);
    if plus && n >= 0.0 { format!("+{}", s) }
    else if space && n >= 0.0 { format!(" {}", s) }
    else { s }
}

fn format_float_e(n: f64, prec: usize, upper: bool, plus: bool, space: bool) -> String {
    let s = if upper {
        format!("{:.prec$E}", n, prec = prec)
    } else {
        format!("{:.prec$e}", n, prec = prec)
    };
    // Ensure exponent has at least 2 digits
    let s = fix_exponent(&s);
    if plus && n >= 0.0 { format!("+{}", s) }
    else if space && n >= 0.0 { format!(" {}", s) }
    else { s }
}

fn fix_exponent(s: &str) -> String {
    // Rust may produce e1 instead of e+01; normalize to match POSIX
    if let Some(epos) = s.rfind('e').or_else(|| s.rfind('E')) {
        let (base, exp_part) = s.split_at(epos);
        let e_char = &exp_part[..1];
        let rest = &exp_part[1..];
        let (sign, digits) = if rest.starts_with('+') || rest.starts_with('-') {
            (&rest[..1], &rest[1..])
        } else {
            ("+", rest)
        };
        let padded = if digits.len() < 2 { format!("0{}", digits) } else { digits.to_string() };
        format!("{}{}{}{}", base, e_char, sign, padded)
    } else { s.to_string() }
}

fn format_float_g(n: f64, prec: usize, upper: bool, plus: bool, space: bool) -> String {
    if n == 0.0 {
        let s = if prec <= 1 { "0".to_string() } else { "0".to_string() };
        if plus { format!("+{}", s) }
        else if space { format!(" {}", s) }
        else { s }
    } else {
        let exp = n.abs().log10().floor() as i32;
        let s = if exp >= -(1 as i32) && exp < (prec as i32) {
            let dec_places = (prec as i32 - 1 - exp).max(0) as usize;
            let formatted = format!("{:.prec$}", n, prec = dec_places);
            // Trim trailing zeros after decimal point for %g
            trim_trailing_zeros(&formatted)
        } else {
            let ep = prec - 1;
            let formatted = if upper {
                format!("{:.prec$E}", n, prec = ep)
            } else {
                format!("{:.prec$e}", n, prec = ep)
            };
            let formatted = fix_exponent(&formatted);
            // Trim trailing zeros in mantissa
            if let Some(epos) = formatted.rfind('e').or_else(|| formatted.rfind('E')) {
                let (mantissa, exp_part) = formatted.split_at(epos);
                let trimmed = trim_trailing_zeros(mantissa);
                format!("{}{}", trimmed, exp_part)
            } else {
                trim_trailing_zeros(&formatted)
            }
        };
        if plus && n >= 0.0 { format!("+{}", s) }
        else if space && n >= 0.0 { format!(" {}", s) }
        else { s }
    }
}

fn trim_trailing_zeros(s: &str) -> String {
    if s.contains('.') {
        let trimmed = s.trim_end_matches('0');
        let trimmed = trimmed.trim_end_matches('.');
        trimmed.to_string()
    } else { s.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ===== Lexer / Tokenizer Tests =====

    #[test]
    fn tokenize_empty() {
        let toks = tokenize("").unwrap();
        assert!(toks.is_empty());
    }

    #[test]
    fn tokenize_number_integer() {
        let toks = tokenize("42").unwrap();
        assert_eq!(toks, vec![Token::Num(42.0)]);
    }

    #[test]
    fn tokenize_number_float() {
        let toks = tokenize("3.14").unwrap();
        assert_eq!(toks, vec![Token::Num(3.14)]);
    }

    #[test]
    fn tokenize_string_literal() {
        let toks = tokenize(r#""hello""#).unwrap();
        assert_eq!(toks, vec![Token::Str("hello".to_string())]);
    }

    #[test]
    fn tokenize_string_escape_sequences() {
        let toks = tokenize(r#""\n\t\\""#).unwrap();
        assert_eq!(toks, vec![Token::Str("\n\t\\".to_string())]);
    }

    #[test]
    fn tokenize_regex_literal() {
        let toks = tokenize("/hello/").unwrap();
        assert_eq!(toks, vec![Token::Regex("hello".to_string())]);
    }

    #[test]
    fn tokenize_keywords() {
        let toks = tokenize("BEGIN END if else while for print").unwrap();
        assert_eq!(toks, vec![
            Token::Begin, Token::End,
            Token::If, Token::Else,
            Token::While, Token::For,
            Token::Print,
        ]);
    }

    #[test]
    fn tokenize_keywords_do_in_break_continue() {
        let toks = tokenize("do in break continue next exit return").unwrap();
        assert_eq!(toks, vec![
            Token::Do, Token::In,
            Token::Break, Token::Continue,
            Token::Next, Token::Exit, Token::Return,
        ]);
    }

    #[test]
    fn tokenize_keywords_delete_function_getline() {
        let toks = tokenize("delete function getline printf").unwrap();
        assert_eq!(toks, vec![
            Token::Delete, Token::Function, Token::Getline, Token::Printf,
        ]);
    }

    #[test]
    fn tokenize_arithmetic_operators() {
        // Test each operator individually to avoid the tokenizer treating /
        // as the start of a regex literal when it follows another operator.
        assert_eq!(tokenize("+").unwrap(), vec![Token::Plus]);
        assert_eq!(tokenize("-").unwrap(), vec![Token::Minus]);
        assert_eq!(tokenize("*").unwrap(), vec![Token::Star]);
        assert_eq!(tokenize("%").unwrap(), vec![Token::Percent]);
        assert_eq!(tokenize("^").unwrap(), vec![Token::Caret]);
    }

    #[test]
    fn tokenize_slash_after_value() {
        // / is treated as division (Slash) only when preceded by a value token
        let toks = tokenize("a/b").unwrap();
        assert_eq!(toks, vec![
            Token::Ident("a".to_string()),
            Token::Slash,
            Token::Ident("b".to_string()),
        ]);
    }

    #[test]
    fn tokenize_compound_assign_operators() {
        // Test each compound-assign operator individually to avoid / triggering regex parsing.
        // /= must follow a value token so the tokenizer treats / as division, not regex start.
        assert_eq!(tokenize("+=").unwrap(), vec![Token::PlusAssign]);
        assert_eq!(tokenize("-=").unwrap(), vec![Token::MinusAssign]);
        assert_eq!(tokenize("*=").unwrap(), vec![Token::StarAssign]);
        assert_eq!(tokenize("a/=").unwrap(), vec![Token::Ident("a".to_string()), Token::SlashAssign]);
        assert_eq!(tokenize("%=").unwrap(), vec![Token::PercentAssign]);
    }

    #[test]
    fn tokenize_caret_assign() {
        let toks = tokenize("^=").unwrap();
        assert_eq!(toks, vec![Token::CaretAssign]);
    }

    #[test]
    fn tokenize_comparison_operators() {
        let toks = tokenize("== != < <= > >=").unwrap();
        assert_eq!(toks, vec![
            Token::Eq, Token::Ne,
            Token::Lt, Token::Le,
            Token::Gt, Token::Ge,
        ]);
    }

    #[test]
    fn tokenize_logical_operators() {
        let toks = tokenize("&& ||").unwrap();
        assert_eq!(toks, vec![Token::And, Token::Or]);
    }

    #[test]
    fn tokenize_match_operators() {
        let toks = tokenize("~ !~").unwrap();
        assert_eq!(toks, vec![Token::Match, Token::NotMatch]);
    }

    #[test]
    fn tokenize_incr_decr() {
        let toks = tokenize("++ --").unwrap();
        assert_eq!(toks, vec![Token::Incr, Token::Decr]);
    }

    #[test]
    fn tokenize_punctuation() {
        let toks = tokenize("{ } ( ) [ ] ; ,").unwrap();
        assert_eq!(toks, vec![
            Token::LBrace, Token::RBrace,
            Token::LParen, Token::RParen,
            Token::LBracket, Token::RBracket,
            Token::Semi, Token::Comma,
        ]);
    }

    #[test]
    fn tokenize_dollar_field() {
        let toks = tokenize("$1").unwrap();
        assert_eq!(toks, vec![Token::Dollar, Token::Num(1.0)]);
    }

    #[test]
    fn tokenize_ident() {
        let toks = tokenize("myvar _foo123").unwrap();
        assert_eq!(toks, vec![
            Token::Ident("myvar".to_string()),
            Token::Ident("_foo123".to_string()),
        ]);
    }

    #[test]
    fn tokenize_comment_ignored() {
        let toks = tokenize("42 # this is a comment").unwrap();
        assert_eq!(toks, vec![Token::Num(42.0)]);
    }

    #[test]
    fn tokenize_newline_after_value() {
        // newline after a value token should produce Token::Newline
        let toks = tokenize("42\n").unwrap();
        assert_eq!(toks, vec![Token::Num(42.0), Token::Newline]);
    }

    #[test]
    fn tokenize_newline_after_rbrace() {
        let toks = tokenize("{}\n").unwrap();
        assert_eq!(toks, vec![Token::LBrace, Token::RBrace, Token::Newline]);
    }

    #[test]
    fn tokenize_hex_number() {
        let toks = tokenize("0xFF").unwrap();
        assert_eq!(toks, vec![Token::Num(255.0)]);
    }

    #[test]
    fn tokenize_scientific_notation() {
        let toks = tokenize("1e3").unwrap();
        assert_eq!(toks, vec![Token::Num(1000.0)]);
    }

    #[test]
    fn tokenize_append_operator() {
        let toks = tokenize(">>").unwrap();
        assert_eq!(toks, vec![Token::Append]);
    }

    #[test]
    fn tokenize_pipe() {
        let toks = tokenize("|").unwrap();
        assert_eq!(toks, vec![Token::Pipe]);
    }

    #[test]
    fn tokenize_ternary_colon() {
        let toks = tokenize("? :").unwrap();
        assert_eq!(toks, vec![Token::Question, Token::Colon]);
    }

    #[test]
    fn tokenize_assign() {
        let toks = tokenize("=").unwrap();
        assert_eq!(toks, vec![Token::Assign]);
    }

    #[test]
    fn tokenize_not() {
        let toks = tokenize("!").unwrap();
        assert_eq!(toks, vec![Token::Not]);
    }

    #[test]
    fn tokenize_regex_with_escape() {
        let toks = tokenize(r"/a\/b/").unwrap();
        assert_eq!(toks, vec![Token::Regex("a/b".to_string())]);
    }

    // ===== Field Splitting Tests =====

    #[test]
    fn split_default_fs_basic() {
        assert_eq!(split_by_fs("hello world", " "), vec!["hello", "world"]);
    }

    #[test]
    fn split_default_fs_leading_trailing_whitespace() {
        assert_eq!(split_by_fs("  hello   world  ", " "), vec!["hello", "world"]);
    }

    #[test]
    fn split_default_fs_tabs() {
        assert_eq!(split_by_fs("\thello\t\tworld\t", " "), vec!["hello", "world"]);
    }

    #[test]
    fn split_default_fs_single_word() {
        assert_eq!(split_by_fs("word", " "), vec!["word"]);
    }

    #[test]
    fn split_default_fs_empty_string() {
        let result = split_by_fs("", " ");
        assert!(result.is_empty());
    }

    #[test]
    fn split_default_fs_only_whitespace() {
        let result = split_by_fs("   ", " ");
        assert!(result.is_empty());
    }

    #[test]
    fn split_single_char_fs_colon() {
        assert_eq!(split_by_fs("a:b:c", ":"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_single_char_fs_empty_fields() {
        assert_eq!(split_by_fs("a::b", ":"), vec!["a", "", "b"]);
    }

    #[test]
    fn split_single_char_fs_leading_sep() {
        assert_eq!(split_by_fs(":a:b", ":"), vec!["", "a", "b"]);
    }

    #[test]
    fn split_single_char_fs_trailing_sep() {
        assert_eq!(split_by_fs("a:b:", ":"), vec!["a", "b", ""]);
    }

    #[test]
    fn split_single_char_fs_tab() {
        assert_eq!(split_by_fs("x\ty\tz", "\t"), vec!["x", "y", "z"]);
    }

    #[test]
    fn split_regex_fs() {
        // Multi-char FS treated as regex
        assert_eq!(split_by_fs("a12b34c", "[0-9]+"), vec!["a", "b", "c"]);
    }

    #[test]
    fn split_regex_fs_alternation() {
        assert_eq!(split_by_fs("one,two;three", "[,;]"), vec!["one", "two", "three"]);
    }

    #[test]
    fn split_empty_string_any_fs() {
        assert!(split_by_fs("", ":").is_empty());
    }

    #[test]
    fn split_no_separator_present() {
        assert_eq!(split_by_fs("hello", ":"), vec!["hello"]);
    }

    // ===== Record Splitting Tests =====

    #[test]
    fn split_records_newline_rs() {
        let result = split_records("a\nb\nc", "\n");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_records_newline_rs_trailing_newline() {
        let result = split_records("a\nb\nc\n", "\n");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_records_newline_rs_empty_lines() {
        let result = split_records("a\n\nb\n", "\n");
        assert_eq!(result, vec!["a", "", "b"]);
    }

    #[test]
    fn split_records_single_char_rs() {
        let result = split_records("a:b:c", ":");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_records_single_char_rs_trailing() {
        let result = split_records("a:b:c:", ":");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn split_records_paragraph_mode_basic() {
        let text = "line1\nline2\n\nline3\nline4";
        let result = split_records(text, "");
        assert_eq!(result, vec!["line1\nline2", "line3\nline4"]);
    }

    #[test]
    fn split_records_paragraph_mode_multiple_blank_lines() {
        let text = "a\n\n\n\nb";
        let result = split_records(text, "");
        assert_eq!(result, vec!["a", "b"]);
    }

    #[test]
    fn split_records_paragraph_mode_leading_blanks() {
        let text = "\n\nfoo\nbar";
        let result = split_records(text, "");
        assert_eq!(result, vec!["foo\nbar"]);
    }

    #[test]
    fn split_records_paragraph_mode_empty_input() {
        let result = split_records("", "");
        assert!(result.is_empty());
    }

    #[test]
    fn split_records_empty_input_newline_rs() {
        let result = split_records("", "\n");
        assert!(result.is_empty());
    }

    #[test]
    fn split_records_single_record_no_terminator() {
        let result = split_records("hello", "\n");
        assert_eq!(result, vec!["hello"]);
    }

    // ===== Regex Helper Tests =====

    #[test]
    fn regex_match_basic() {
        assert!(regex_match("hello", "hello world"));
    }

    #[test]
    fn regex_match_no_match() {
        assert!(!regex_match("xyz", "hello world"));
    }

    #[test]
    fn regex_match_anchored_start() {
        assert!(regex_match("^hello", "hello world"));
        assert!(!regex_match("^world", "hello world"));
    }

    #[test]
    fn regex_match_anchored_end() {
        assert!(regex_match("world$", "hello world"));
        assert!(!regex_match("hello$", "hello world"));
    }

    #[test]
    fn regex_match_dot() {
        assert!(regex_match("h.llo", "hello"));
    }

    #[test]
    fn regex_match_star() {
        assert!(regex_match("ab*c", "ac"));
        assert!(regex_match("ab*c", "abbbbc"));
    }

    #[test]
    fn regex_match_plus() {
        assert!(regex_match("ab+c", "abbc"));
        assert!(!regex_match("ab+c", "ac"));
    }

    #[test]
    fn regex_match_character_class() {
        assert!(regex_match("[0-9]+", "abc123def"));
        assert!(!regex_match("^[0-9]+$", "abc"));
    }

    #[test]
    fn regex_match_empty_pattern_matches_all() {
        assert!(regex_match("", "anything"));
        assert!(regex_match("", ""));
    }

    #[test]
    fn regex_find_basic() {
        let result = regex_find("world", "hello world");
        assert_eq!(result, Some((6, 5)));
    }

    #[test]
    fn regex_find_no_match() {
        assert_eq!(regex_find("xyz", "hello"), None);
    }

    #[test]
    fn regex_find_start_of_string() {
        let result = regex_find("^hello", "hello world");
        assert_eq!(result, Some((0, 5)));
    }

    #[test]
    fn regex_find_digit_run() {
        let result = regex_find("[0-9]+", "abc123def");
        assert_eq!(result, Some((3, 3)));
    }

    #[test]
    fn regex_find_empty_string() {
        assert_eq!(regex_find("abc", ""), None);
    }

    #[test]
    fn regex_sub_basic_non_global() {
        let (result, count) = regex_sub("o", "0", "foo bar boo", false);
        assert_eq!(result, "f0o bar boo");
        assert_eq!(count, 1);
    }

    #[test]
    fn regex_sub_global() {
        let (result, count) = regex_sub("o", "0", "foo bar boo", true);
        assert_eq!(result, "f00 bar b00");
        assert_eq!(count, 4);
    }

    #[test]
    fn regex_sub_ampersand_replacement() {
        // & in replacement expands to matched text
        let (result, count) = regex_sub("wor", "[&]", "hello world", false);
        assert_eq!(result, "hello [wor]ld");
        assert_eq!(count, 1);
    }

    #[test]
    fn regex_sub_escaped_ampersand() {
        // \& in replacement is a literal &
        let (result, count) = regex_sub("o", r"\&", "foo", false);
        assert_eq!(result, "f&o");
        assert_eq!(count, 1);
    }

    #[test]
    fn regex_sub_no_match() {
        let (result, count) = regex_sub("xyz", "ZZZ", "hello world", false);
        assert_eq!(result, "hello world");
        assert_eq!(count, 0);
    }

    #[test]
    fn regex_sub_empty_input() {
        let (result, count) = regex_sub("a", "b", "", false);
        assert_eq!(result, "");
        assert_eq!(count, 0);
    }

    #[test]
    fn regex_sub_global_all_chars() {
        let (result, count) = regex_sub("a", "x", "banana", true);
        assert_eq!(result, "bxnxnx");
        assert_eq!(count, 3);
    }

    #[test]
    fn regex_sub_anchored() {
        let (result, count) = regex_sub("^hello", "hi", "hello world", false);
        assert_eq!(result, "hi world");
        assert_eq!(count, 1);
    }

    #[test]
    fn regex_split_basic() {
        let result = regex_split(",", "a,b,c");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn regex_split_regex_pattern() {
        let result = regex_split("[,;]", "a,b;c");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn regex_split_no_match() {
        let result = regex_split(",", "abc");
        assert_eq!(result, vec!["abc"]);
    }

    #[test]
    fn regex_split_empty_string() {
        let result = regex_split(",", "");
        assert_eq!(result, vec![""]);
    }

    #[test]
    fn regex_split_multiple_chars_pattern() {
        let result = regex_split("[0-9]+", "a1b22c333d");
        assert_eq!(result, vec!["a", "b", "c", "d"]);
    }

    // ===== sprintf / Printf Tests =====

    #[test]
    fn sprintf_percent_d_basic() {
        let result = sprintf_format("%d", &[Value::Num(42.0)]);
        assert_eq!(result, "42");
    }

    #[test]
    fn sprintf_percent_d_negative() {
        let result = sprintf_format("%d", &[Value::Num(-7.0)]);
        assert_eq!(result, "-7");
    }

    #[test]
    fn sprintf_percent_d_zero() {
        let result = sprintf_format("%d", &[Value::Num(0.0)]);
        assert_eq!(result, "0");
    }

    #[test]
    fn sprintf_percent_s_basic() {
        let result = sprintf_format("%s", &[Value::Str("hello".to_string())]);
        assert_eq!(result, "hello");
    }

    #[test]
    fn sprintf_percent_s_empty() {
        let result = sprintf_format("%s", &[Value::Str(String::new())]);
        assert_eq!(result, "");
    }

    #[test]
    fn sprintf_percent_f_default_precision() {
        let result = sprintf_format("%f", &[Value::Num(3.14)]);
        assert_eq!(result, "3.140000");
    }

    #[test]
    fn sprintf_percent_f_precision_2() {
        let result = sprintf_format("%.2f", &[Value::Num(3.14159)]);
        assert_eq!(result, "3.14");
    }

    #[test]
    fn sprintf_percent_f_zero() {
        let result = sprintf_format("%.2f", &[Value::Num(0.0)]);
        assert_eq!(result, "0.00");
    }

    #[test]
    fn sprintf_percent_f_negative() {
        let result = sprintf_format("%.2f", &[Value::Num(-1.5)]);
        assert_eq!(result, "-1.50");
    }

    #[test]
    fn sprintf_percent_e_default() {
        let result = sprintf_format("%e", &[Value::Num(12345.0)]);
        assert_eq!(result, "1.234500e+04");
    }

    #[test]
    fn sprintf_percent_e_precision() {
        let result = sprintf_format("%.2e", &[Value::Num(12345.0)]);
        assert_eq!(result, "1.23e+04");
    }

    #[test]
    fn sprintf_percent_e_uppercase() {
        let result = sprintf_format("%E", &[Value::Num(12345.0)]);
        assert_eq!(result, "1.234500E+04");
    }

    #[test]
    fn sprintf_percent_g_small_number() {
        // 0.0001 has exponent -4 which is below the %g threshold (-1),
        // so it renders in scientific notation
        let result = sprintf_format("%g", &[Value::Num(0.0001)]);
        assert_eq!(result, "1e-04");
    }

    #[test]
    fn sprintf_percent_g_borderline_small() {
        // 0.1 has exponent -1, which satisfies exp >= -1, so uses fixed notation
        let result = sprintf_format("%g", &[Value::Num(0.1)]);
        assert_eq!(result, "0.1");
    }

    #[test]
    fn sprintf_percent_g_large_number() {
        let result = sprintf_format("%g", &[Value::Num(123456789.0)]);
        assert_eq!(result, "1.23457e+08");
    }

    #[test]
    fn sprintf_percent_g_integer_value() {
        let result = sprintf_format("%g", &[Value::Num(100.0)]);
        assert_eq!(result, "100");
    }

    #[test]
    fn sprintf_percent_o_octal() {
        let result = sprintf_format("%o", &[Value::Num(8.0)]);
        assert_eq!(result, "10");
    }

    #[test]
    fn sprintf_percent_o_zero() {
        let result = sprintf_format("%o", &[Value::Num(0.0)]);
        assert_eq!(result, "0");
    }

    #[test]
    fn sprintf_percent_x_hex_lower() {
        let result = sprintf_format("%x", &[Value::Num(255.0)]);
        assert_eq!(result, "ff");
    }

    #[test]
    fn sprintf_percent_x_hex_upper() {
        let result = sprintf_format("%X", &[Value::Num(255.0)]);
        assert_eq!(result, "FF");
    }

    #[test]
    fn sprintf_percent_c_from_num() {
        let result = sprintf_format("%c", &[Value::Num(65.0)]);
        assert_eq!(result, "A");
    }

    #[test]
    fn sprintf_percent_c_from_str() {
        let result = sprintf_format("%c", &[Value::Str("hello".to_string())]);
        assert_eq!(result, "h");
    }

    #[test]
    fn sprintf_percent_percent_literal() {
        let result = sprintf_format("100%%", &[]);
        assert_eq!(result, "100%");
    }

    #[test]
    fn sprintf_width_right_align() {
        let result = sprintf_format("%5d", &[Value::Num(42.0)]);
        assert_eq!(result, "   42");
    }

    #[test]
    fn sprintf_width_left_align() {
        let result = sprintf_format("%-5d", &[Value::Num(42.0)]);
        assert_eq!(result, "42   ");
    }

    #[test]
    fn sprintf_width_zero_pad() {
        let result = sprintf_format("%05d", &[Value::Num(42.0)]);
        assert_eq!(result, "00042");
    }

    #[test]
    fn sprintf_plus_sign_positive() {
        let result = sprintf_format("%+d", &[Value::Num(42.0)]);
        assert_eq!(result, "+42");
    }

    #[test]
    fn sprintf_plus_sign_negative() {
        let result = sprintf_format("%+d", &[Value::Num(-42.0)]);
        assert_eq!(result, "-42");
    }

    #[test]
    fn sprintf_space_sign_positive() {
        let result = sprintf_format("% d", &[Value::Num(42.0)]);
        assert_eq!(result, " 42");
    }

    #[test]
    fn sprintf_space_sign_negative() {
        let result = sprintf_format("% d", &[Value::Num(-42.0)]);
        assert_eq!(result, "-42");
    }

    #[test]
    fn sprintf_s_with_precision_truncate() {
        let result = sprintf_format("%.3s", &[Value::Str("hello".to_string())]);
        assert_eq!(result, "hel");
    }

    #[test]
    fn sprintf_s_with_width_right_align() {
        let result = sprintf_format("%8s", &[Value::Str("hi".to_string())]);
        assert_eq!(result, "      hi");
    }

    #[test]
    fn sprintf_s_with_width_left_align() {
        let result = sprintf_format("%-8s", &[Value::Str("hi".to_string())]);
        assert_eq!(result, "hi      ");
    }

    #[test]
    fn sprintf_multiple_args() {
        let result = sprintf_format("%s is %d years old", &[
            Value::Str("Alice".to_string()),
            Value::Num(30.0),
        ]);
        assert_eq!(result, "Alice is 30 years old");
    }

    #[test]
    fn sprintf_escape_newline() {
        let result = sprintf_format("line1\nline2", &[]);
        assert_eq!(result, "line1\nline2");
    }

    #[test]
    fn sprintf_escape_tab() {
        let result = sprintf_format("col1\tcol2", &[]);
        assert_eq!(result, "col1\tcol2");
    }

    #[test]
    fn sprintf_zero_width_no_padding() {
        let result = sprintf_format("%0d", &[Value::Num(5.0)]);
        assert_eq!(result, "5");
    }

    #[test]
    fn sprintf_f_plus_sign() {
        let result = sprintf_format("%+.1f", &[Value::Num(3.7)]);
        assert_eq!(result, "+3.7");
    }

    #[test]
    fn sprintf_e_zero() {
        let result = sprintf_format("%.2e", &[Value::Num(0.0)]);
        assert_eq!(result, "0.00e+00");
    }

    // ===== pad_string Tests =====

    #[test]
    fn pad_string_right_align_spaces() {
        assert_eq!(pad_string("hi", 5, false, ' '), "   hi");
    }

    #[test]
    fn pad_string_left_align() {
        assert_eq!(pad_string("hi", 5, true, ' '), "hi   ");
    }

    #[test]
    fn pad_string_zero_pad_positive() {
        assert_eq!(pad_string("42", 5, false, '0'), "00042");
    }

    #[test]
    fn pad_string_zero_pad_with_negative_sign() {
        assert_eq!(pad_string("-7", 5, false, '0'), "-0007");
    }

    #[test]
    fn pad_string_zero_pad_with_plus_sign() {
        assert_eq!(pad_string("+7", 5, false, '0'), "+0007");
    }

    #[test]
    fn pad_string_no_padding_needed() {
        assert_eq!(pad_string("hello", 3, false, ' '), "hello");
    }

    #[test]
    fn pad_string_exact_width() {
        assert_eq!(pad_string("hi", 2, false, ' '), "hi");
    }

    #[test]
    fn pad_string_zero_width() {
        assert_eq!(pad_string("hi", 0, false, ' '), "hi");
    }

    #[test]
    fn pad_string_left_align_ignores_pad_char() {
        // left-align always pads with spaces regardless of pad_char
        assert_eq!(pad_string("x", 4, true, '0'), "x   ");
    }

    #[test]
    fn pad_string_space_sign_zero_pad() {
        // space prefix should be preserved in front of zeros
        assert_eq!(pad_string(" 5", 5, false, '0'), " 0005");
    }

    // ===== Float Formatting Tests =====

    #[test]
    fn format_float_f_basic() {
        assert_eq!(format_float_f(3.14, 2, false, false), "3.14");
    }

    #[test]
    fn format_float_f_zero() {
        assert_eq!(format_float_f(0.0, 2, false, false), "0.00");
    }

    #[test]
    fn format_float_f_negative() {
        assert_eq!(format_float_f(-2.5, 1, false, false), "-2.5");
    }

    #[test]
    fn format_float_f_plus_sign() {
        assert_eq!(format_float_f(1.0, 1, true, false), "+1.0");
    }

    #[test]
    fn format_float_f_space_sign() {
        assert_eq!(format_float_f(1.0, 1, false, true), " 1.0");
    }

    #[test]
    fn format_float_f_negative_ignores_space_sign() {
        // negative numbers don't get the space prefix
        assert_eq!(format_float_f(-1.0, 1, false, true), "-1.0");
    }

    #[test]
    fn format_float_e_basic() {
        let s = format_float_e(12345.0, 2, false, false, false);
        assert_eq!(s, "1.23e+04");
    }

    #[test]
    fn format_float_e_uppercase() {
        let s = format_float_e(12345.0, 2, true, false, false);
        assert_eq!(s, "1.23E+04");
    }

    #[test]
    fn format_float_e_negative_exponent() {
        let s = format_float_e(0.001, 2, false, false, false);
        assert_eq!(s, "1.00e-03");
    }

    #[test]
    fn format_float_e_plus_flag() {
        let s = format_float_e(1.0, 2, false, true, false);
        assert_eq!(s, "+1.00e+00");
    }

    #[test]
    fn format_float_e_space_flag() {
        let s = format_float_e(1.0, 2, false, false, true);
        assert_eq!(s, " 1.00e+00");
    }

    #[test]
    fn format_float_g_zero() {
        let s = format_float_g(0.0, 6, false, false, false);
        assert_eq!(s, "0");
    }

    #[test]
    fn format_float_g_integer_no_trailing_dot() {
        let s = format_float_g(100.0, 6, false, false, false);
        assert_eq!(s, "100");
    }

    #[test]
    fn format_float_g_uses_e_for_large() {
        let s = format_float_g(1234567.0, 6, false, false, false);
        assert!(s.contains('e'), "expected scientific notation, got: {}", s);
    }

    #[test]
    fn format_float_g_plus_sign_zero() {
        let s = format_float_g(0.0, 6, false, true, false);
        assert_eq!(s, "+0");
    }

    #[test]
    fn format_float_g_uppercase() {
        let s = format_float_g(1234567.0, 6, true, false, false);
        assert!(s.contains('E'), "expected uppercase E, got: {}", s);
    }

    #[test]
    fn trim_trailing_zeros_with_decimal() {
        assert_eq!(trim_trailing_zeros("3.14000"), "3.14");
    }

    #[test]
    fn trim_trailing_zeros_all_zeros_after_dot() {
        assert_eq!(trim_trailing_zeros("3.00"), "3");
    }

    #[test]
    fn trim_trailing_zeros_no_decimal() {
        assert_eq!(trim_trailing_zeros("42"), "42");
    }

    #[test]
    fn trim_trailing_zeros_empty() {
        assert_eq!(trim_trailing_zeros(""), "");
    }

    #[test]
    fn trim_trailing_zeros_preserves_significant() {
        assert_eq!(trim_trailing_zeros("1.500"), "1.5");
    }

    #[test]
    fn fix_exponent_pads_single_digit() {
        let s = fix_exponent("1.0e5");
        assert_eq!(s, "1.0e+05");
    }

    #[test]
    fn fix_exponent_already_two_digits() {
        let s = fix_exponent("1.0e+05");
        assert_eq!(s, "1.0e+05");
    }

    #[test]
    fn fix_exponent_negative_exp() {
        let s = fix_exponent("1.0e-3");
        assert_eq!(s, "1.0e-03");
    }

    #[test]
    fn fix_exponent_uppercase_e() {
        let s = fix_exponent("1.0E5");
        assert_eq!(s, "1.0E+05");
    }

    #[test]
    fn fix_exponent_no_exponent() {
        let s = fix_exponent("3.14");
        assert_eq!(s, "3.14");
    }

    // ===== Print > Redirect vs Comparison Ambiguity Tests =====

    fn parse_program_str(src: &str) -> Program {
        let tokens = tokenize(src).unwrap();
        parse(&tokens).unwrap()
    }

    #[test]
    fn parse_print_redirect_to_file() {
        // print "hello" > "/tmp/out.txt" should parse as redirect, not comparison
        let prog = parse_program_str(r#"{ print "hello" > "/tmp/out.txt" }"#);
        assert_eq!(prog.rules.len(), 1);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, dest) => {
                assert_eq!(exprs.len(), 1);
                assert!(matches!(&exprs[0], Expr::Str(s) if s == "hello"));
                assert!(matches!(dest, Some(OutputDest::File(_))));
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_print_append_to_file() {
        // print "hello" >> "/tmp/out.txt" should parse as append redirect
        let prog = parse_program_str(r#"{ print "hello" >> "/tmp/out.txt" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(_, dest) => {
                assert!(matches!(dest, Some(OutputDest::Append(_))));
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_print_pipe() {
        // print "hello" | "sort" should parse as pipe redirect
        let prog = parse_program_str(r#"{ print "hello" | "sort" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(_, dest) => {
                assert!(matches!(dest, Some(OutputDest::Pipe(_))));
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_print_multiple_fields_redirect() {
        // print $1, $2 > "file" — redirect applies to the whole print, not just $2
        let prog = parse_program_str(r#"{ print $1, $2 > "file" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, dest) => {
                assert_eq!(exprs.len(), 2);
                assert!(matches!(dest, Some(OutputDest::File(_))));
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_comparison_gt_outside_print() {
        // if ($1 > 5) — > is comparison, not redirect
        let prog = parse_program_str(r#"{ if ($1 > 5) print "big" }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(cond, _, _) => {
                assert!(matches!(cond, Expr::Binop(op, _, _) if op == ">"));
            }
            _ => panic!("expected If statement"),
        }
    }

    #[test]
    fn parse_comparison_ge_outside_print() {
        // while (x >= 10) — >= is comparison
        let prog = parse_program_str(r#"{ while (x >= 10) x-- }"#);
        match &prog.rules[0].action[0] {
            Stmt::While(cond, _) => {
                assert!(matches!(cond, Expr::Binop(op, _, _) if op == ">="));
            }
            _ => panic!("expected While statement"),
        }
    }

    #[test]
    fn parse_printf_redirect() {
        // printf "%s\n", "hi" > "file" — redirect in printf
        let prog = parse_program_str(r#"{ printf "%s\n", "hi" > "file" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Printf(exprs, dest) => {
                assert_eq!(exprs.len(), 2);
                assert!(matches!(dest, Some(OutputDest::File(_))));
            }
            _ => panic!("expected Printf statement"),
        }
    }

    #[test]
    fn parse_print_no_redirect() {
        // print $0 — no redirect
        let prog = parse_program_str(r#"{ print $0 }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(_, dest) => {
                assert!(dest.is_none());
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_comparison_in_pattern_not_affected() {
        // /pattern/ with > in a non-print expression context
        let prog = parse_program_str(r#"$1 > 5 { print }"#);
        match &prog.rules[0].pattern {
            Some(Pattern::Expr(Expr::Binop(op, _, _))) => {
                assert_eq!(op, ">");
            }
            _ => panic!("expected expression pattern with > comparison"),
        }
    }

    #[test]
    fn parse_print_var_redirect() {
        // print x > "file" — single variable redirected
        let prog = parse_program_str(r#"{ print x > "out" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, dest) => {
                assert_eq!(exprs.len(), 1);
                assert!(matches!(&exprs[0], Expr::Var(v) if v == "x"));
                assert!(matches!(dest, Some(OutputDest::File(_))));
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_parenthesized_comparison_in_print() {
        // print (a > b) — parenthesized comparison inside print is fine
        let prog = parse_program_str(r#"{ print (a > b) }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, dest) => {
                // The (a > b) is parsed as a comparison inside parens
                assert_eq!(exprs.len(), 1);
                assert!(matches!(&exprs[0], Expr::Binop(op, _, _) if op == ">"));
                assert!(dest.is_none());
            }
            _ => panic!("expected Print statement"),
        }
    }

    #[test]
    fn parse_print_lt_still_works_as_comparison() {
        // print (a < b) — < is always comparison (not ambiguous)
        let prog = parse_program_str(r#"{ print (a < b) }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, _) => {
                assert!(matches!(&exprs[0], Expr::Binop(op, _, _) if op == "<"));
            }
            _ => panic!("expected Print statement"),
        }
    }

    // ===== Multi-dimensional Array Tests =====

    #[test]
    fn parse_multidim_array_subscript_two_keys() {
        // a[1,2] — two subscripts stored as Expr::Array with two elements
        let prog = parse_program_str(r#"{ x = a[1,2] }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(_, rhs)) => {
                match rhs.as_ref() {
                    Expr::Array(name, subs) => {
                        assert_eq!(name, "a");
                        assert_eq!(subs.len(), 2);
                        assert!(matches!(&subs[0], Expr::Num(n) if *n == 1.0));
                        assert!(matches!(&subs[1], Expr::Num(n) if *n == 2.0));
                    }
                    _ => panic!("expected Array expression"),
                }
            }
            _ => panic!("expected Assign statement"),
        }
    }

    #[test]
    fn parse_multidim_array_subscript_three_keys() {
        // a[i,j,k] — three subscripts
        let prog = parse_program_str(r#"{ a[i,j,k] = 1 }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(lhs, _)) => {
                match lhs.as_ref() {
                    Expr::Array(name, subs) => {
                        assert_eq!(name, "a");
                        assert_eq!(subs.len(), 3);
                    }
                    _ => panic!("expected Array lhs"),
                }
            }
            _ => panic!("expected Assign statement"),
        }
    }

    // ===== Multi-dimensional `in` operator =====

    #[test]
    fn parse_multidim_in_operator() {
        // (i,j) in arr — parses as In with SUBSEP-concatenated key
        let prog = parse_program_str(r#"{ if ((i,j) in arr) print }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(cond, _, _) => {
                match cond {
                    Expr::In(key, arr_name) => {
                        assert_eq!(arr_name, "arr");
                        // The key should be a Concat tree (i SUBSEP j)
                        assert!(matches!(key.as_ref(), Expr::Concat(_, _)));
                    }
                    _ => panic!("expected In expression"),
                }
            }
            _ => panic!("expected If statement"),
        }
    }

    #[test]
    fn parse_multidim_in_subsep_structure() {
        // (i,j) in arr — the inner Concat contains a SUBSEP Var
        let prog = parse_program_str(r#"{ if ((i,j) in arr) print }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(Expr::In(key, _), _, _) => {
                // key = Concat(Concat(i, SUBSEP), j)
                match key.as_ref() {
                    Expr::Concat(inner, rhs) => {
                        assert!(matches!(rhs.as_ref(), Expr::Var(v) if v == "j"));
                        match inner.as_ref() {
                            Expr::Concat(lhs, sep) => {
                                assert!(matches!(lhs.as_ref(), Expr::Var(v) if v == "i"));
                                assert!(matches!(sep.as_ref(), Expr::Var(v) if v == "SUBSEP"));
                            }
                            _ => panic!("expected inner Concat"),
                        }
                    }
                    _ => panic!("expected Concat key"),
                }
            }
            _ => panic!("expected If(In(...))"),
        }
    }

    // ===== Empty action block =====

    #[test]
    fn parse_empty_action_block_produces_no_stmts() {
        // /pattern/ { } — action list is empty
        let prog = parse_program_str(r#"/hello/ { }"#);
        assert_eq!(prog.rules.len(), 1);
        assert!(prog.rules[0].action.is_empty());
    }

    #[test]
    fn parse_pattern_without_action_inserts_default_print() {
        // /pattern/ with no braces — parser inserts a default `print $0` action
        let prog = parse_program_str(r#"/hello/"#);
        assert_eq!(prog.rules.len(), 1);
        // Pattern should be a regex expression
        match &prog.rules[0].pattern {
            Some(Pattern::Expr(Expr::Regex(r))) => assert_eq!(r, "hello"),
            _ => panic!("expected regex pattern"),
        }
        // Action should be the default print $0
        assert_eq!(prog.rules[0].action.len(), 1);
        match &prog.rules[0].action[0] {
            Stmt::Print(exprs, dest) => {
                assert!(dest.is_none());
                assert_eq!(exprs.len(), 1);
                assert!(matches!(&exprs[0],
                    Expr::Field(inner) if matches!(inner.as_ref(), Expr::Num(n) if *n == 0.0)
                ));
            }
            _ => panic!("expected default Print($0) action"),
        }
    }

    // ===== BEGIN-only program has_main_rules logic =====

    #[test]
    fn parse_begin_only_program_no_main_rules() {
        let prog = parse_program_str(r#"BEGIN { x = 1 }"#);
        let has_main = prog.rules.iter().any(|r|
            !matches!(&r.pattern, Some(Pattern::Begin) | Some(Pattern::End))
        );
        assert!(!has_main, "BEGIN-only program should have no main rules");
    }

    #[test]
    fn parse_end_only_program_no_main_rules() {
        let prog = parse_program_str(r#"END { print x }"#);
        let has_main = prog.rules.iter().any(|r|
            !matches!(&r.pattern, Some(Pattern::Begin) | Some(Pattern::End))
        );
        assert!(!has_main, "END-only program should have no main rules");
    }

    #[test]
    fn parse_begin_and_main_rule_has_main() {
        let prog = parse_program_str(r#"BEGIN { } { print } END { }"#);
        let has_main = prog.rules.iter().any(|r|
            !matches!(&r.pattern, Some(Pattern::Begin) | Some(Pattern::End))
        );
        assert!(has_main, "program with main rule should report has_main_rules=true");
    }

    // ===== Print redirect / append parsing =====

    #[test]
    fn parse_two_print_redirects_to_same_file() {
        // Both print statements redirect to the same file name expression
        let prog = parse_program_str(r#"{ print "a" > "f"; print "b" > "f" }"#);
        assert_eq!(prog.rules[0].action.len(), 2);
        for stmt in &prog.rules[0].action {
            match stmt {
                Stmt::Print(_, dest) => {
                    assert!(matches!(dest, Some(OutputDest::File(Expr::Str(s))) if s == "f"));
                }
                _ => panic!("expected Print"),
            }
        }
    }

    #[test]
    fn parse_print_append_operator_is_append_dest() {
        // print "x" >> "f" — must be Append, not File
        let prog = parse_program_str(r#"{ print "x" >> "f" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Print(_, dest) => {
                assert!(matches!(dest, Some(OutputDest::Append(_))));
            }
            _ => panic!("expected Print"),
        }
    }

    // ===== Unary plus =====

    #[test]
    fn parse_unary_plus_num_literal() {
        // +5 — unary plus is a no-op; the parser folds it, inner expression is Num(5)
        let prog = parse_program_str(r#"{ x = +5 }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(_, rhs)) => {
                // parse_unary with Token::Plus just recurses without wrapping
                assert!(matches!(rhs.as_ref(), Expr::Num(n) if *n == 5.0));
            }
            _ => panic!("expected Assign"),
        }
    }

    #[test]
    fn parse_unary_plus_variable() {
        // +x — parser folds unary plus; result is just the variable
        let prog = parse_program_str(r#"{ y = +x }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(_, rhs)) => {
                assert!(matches!(rhs.as_ref(), Expr::Var(v) if v == "x"));
            }
            _ => panic!("expected Assign with Var rhs"),
        }
    }

    // ===== Concatenation precedence =====

    #[test]
    fn parse_concat_precedence_over_comparison() {
        // In a non-print context: a b > c should be (a b) > c
        // i.e., Binop(">", Concat(a, b), c)
        let prog = parse_program_str(r#"{ if (a b > c) print }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(cond, _, _) => {
                match cond {
                    Expr::Binop(op, lhs, rhs) => {
                        assert_eq!(op, ">");
                        assert!(matches!(lhs.as_ref(), Expr::Concat(_, _)));
                        assert!(matches!(rhs.as_ref(), Expr::Var(v) if v == "c"));
                    }
                    _ => panic!("expected Binop > with Concat lhs"),
                }
            }
            _ => panic!("expected If"),
        }
    }

    // ===== Regex as standalone expression =====

    #[test]
    fn parse_regex_standalone_in_if_condition() {
        // if (/pat/) — regex literal used as a condition expression (evaluates against $0)
        let prog = parse_program_str(r#"{ if (/pat/) print }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(cond, _, _) => {
                assert!(matches!(cond, Expr::Regex(r) if r == "pat"));
            }
            _ => panic!("expected If"),
        }
    }

    #[test]
    fn parse_regex_standalone_in_while_condition() {
        // while (/abc/) — regex literal in while condition
        let prog = parse_program_str(r#"{ while (/abc/) { next } }"#);
        match &prog.rules[0].action[0] {
            Stmt::While(cond, _) => {
                assert!(matches!(cond, Expr::Regex(r) if r == "abc"));
            }
            _ => panic!("expected While"),
        }
    }

    // ===== split() call parsing =====

    #[test]
    fn parse_split_call_with_regex_separator() {
        // split("a1b2c", arr, "[0-9]") — three-arg call
        let prog = parse_program_str(r#"{ n = split("a1b2c", arr, "[0-9]") }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(_, rhs)) => {
                match rhs.as_ref() {
                    Expr::Call(name, args) => {
                        assert_eq!(name, "split");
                        assert_eq!(args.len(), 3);
                        assert!(matches!(&args[0], Expr::Str(s) if s == "a1b2c"));
                        assert!(matches!(&args[1], Expr::Var(v) if v == "arr"));
                        assert!(matches!(&args[2], Expr::Str(s) if s == "[0-9]"));
                    }
                    _ => panic!("expected Call(split, ...)"),
                }
            }
            _ => panic!("expected Assign"),
        }
    }

    #[test]
    fn parse_split_call_two_args() {
        // split(s, arr) — two-arg form uses FS
        let prog = parse_program_str(r#"{ split(s, arr) }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Call(name, args)) => {
                assert_eq!(name, "split");
                assert_eq!(args.len(), 2);
            }
            _ => panic!("expected Call(split)"),
        }
    }

    // ===== regex_split with digit class separator =====

    #[test]
    fn regex_split_digit_class() {
        // [0-9] separates "a1b2c" into ["a", "b", "c"]
        let result = regex_split("[0-9]", "a1b2c");
        assert_eq!(result, vec!["a", "b", "c"]);
    }

    #[test]
    fn regex_split_leading_separator() {
        let result = regex_split(",", ",a,b");
        assert_eq!(result, vec!["", "a", "b"]);
    }

    #[test]
    fn regex_split_trailing_separator() {
        let result = regex_split(",", "a,b,");
        assert_eq!(result, vec!["a", "b", ""]);
    }

    // ===== String comparison (lexicographic) =====

    #[test]
    fn parse_string_comparison_gt() {
        // "10" > "9" — both string literals; > comparison is lexicographic
        let prog = parse_program_str(r#"{ if ("10" > "9") print "yes" }"#);
        match &prog.rules[0].action[0] {
            Stmt::If(cond, _, _) => {
                match cond {
                    Expr::Binop(op, lhs, rhs) => {
                        assert_eq!(op, ">");
                        assert!(matches!(lhs.as_ref(), Expr::Str(s) if s == "10"));
                        assert!(matches!(rhs.as_ref(), Expr::Str(s) if s == "9"));
                    }
                    _ => panic!("expected Binop >"),
                }
            }
            _ => panic!("expected If"),
        }
    }

    // ===== NF assignment =====

    #[test]
    fn parse_nf_assignment() {
        // NF = 3 — assign to NF variable
        let prog = parse_program_str(r#"{ NF = 3 }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(lhs, rhs)) => {
                assert!(matches!(lhs.as_ref(), Expr::Var(v) if v == "NF"));
                assert!(matches!(rhs.as_ref(), Expr::Num(n) if *n == 3.0));
            }
            _ => panic!("expected Assign NF = 3"),
        }
    }

    // ===== $0 assignment =====

    #[test]
    fn parse_dollar_zero_assignment() {
        // $0 = "a b c" — assign to field 0
        let prog = parse_program_str(r#"{ $0 = "a b c" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(lhs, rhs)) => {
                assert!(matches!(
                    lhs.as_ref(),
                    Expr::Field(inner) if matches!(inner.as_ref(), Expr::Num(n) if *n == 0.0)
                ));
                assert!(matches!(rhs.as_ref(), Expr::Str(s) if s == "a b c"));
            }
            _ => panic!("expected $0 = ... assignment"),
        }
    }

    // ===== for-in iteration =====

    #[test]
    fn parse_for_in_basic() {
        // for (k in arr) print k
        let prog = parse_program_str(r#"{ for (k in arr) print k }"#);
        match &prog.rules[0].action[0] {
            Stmt::ForIn(var, arr, _) => {
                assert_eq!(var, "k");
                assert_eq!(arr, "arr");
            }
            _ => panic!("expected ForIn statement"),
        }
    }

    #[test]
    fn parse_for_in_with_block_body() {
        // for (k in arr) { print k }
        let prog = parse_program_str(r#"{ for (k in arr) { print k } }"#);
        match &prog.rules[0].action[0] {
            Stmt::ForIn(var, arr, body) => {
                assert_eq!(var, "k");
                assert_eq!(arr, "arr");
                assert!(matches!(body.as_ref(), Stmt::Block(_)));
            }
            _ => panic!("expected ForIn with Block body"),
        }
    }

    // ===== delete entire array =====

    #[test]
    fn parse_delete_entire_array_no_brackets() {
        // delete arr — deletes the whole array (no brackets)
        let prog = parse_program_str(r#"{ delete arr }"#);
        match &prog.rules[0].action[0] {
            Stmt::DeleteAll(name) => assert_eq!(name, "arr"),
            _ => panic!("expected DeleteAll"),
        }
    }

    #[test]
    fn parse_delete_entire_array_empty_brackets() {
        // delete arr[] — also deletes the whole array
        let prog = parse_program_str(r#"{ delete arr[] }"#);
        match &prog.rules[0].action[0] {
            Stmt::DeleteAll(name) => assert_eq!(name, "arr"),
            _ => panic!("expected DeleteAll"),
        }
    }

    #[test]
    fn parse_delete_single_element() {
        // delete arr[k] — deletes one element
        let prog = parse_program_str(r#"{ delete arr[k] }"#);
        match &prog.rules[0].action[0] {
            Stmt::Delete(name, subs) => {
                assert_eq!(name, "arr");
                assert_eq!(subs.len(), 1);
                assert!(matches!(&subs[0], Expr::Var(v) if v == "k"));
            }
            _ => panic!("expected Delete with subscript"),
        }
    }

    // ===== Negative array indices =====

    #[test]
    fn parse_negative_array_index() {
        // a[-1] = "neg" — subscript is Unary("-", Num(1))
        let prog = parse_program_str(r#"{ a[-1] = "neg" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(lhs, _)) => {
                match lhs.as_ref() {
                    Expr::Array(name, subs) => {
                        assert_eq!(name, "a");
                        assert_eq!(subs.len(), 1);
                        assert!(matches!(
                            &subs[0],
                            Expr::Unary(op, inner)
                                if op == "-" && matches!(inner.as_ref(), Expr::Num(n) if *n == 1.0)
                        ));
                    }
                    _ => panic!("expected Array lhs"),
                }
            }
            _ => panic!("expected Assign"),
        }
    }

    // ===== sub/gsub `&` replacement via regex_sub helper =====

    #[test]
    fn regex_sub_ampersand_expands_to_match() {
        // & in replacement expands to matched text
        let (result, count) = regex_sub("world", "&!", "hello world", false);
        assert_eq!(result, "hello world!");
        assert_eq!(count, 1);
    }

    #[test]
    fn regex_sub_escaped_ampersand_is_literal() {
        // \& in replacement string becomes a literal &
        let (result, _) = regex_sub("foo", r"\&", "foo bar", false);
        assert_eq!(result, "& bar");
    }

    #[test]
    fn regex_sub_global_ampersand() {
        // gsub with & expands the matched text for every replacement
        let (result, count) = regex_sub("[aeiou]", "[&]", "hello", true);
        assert_eq!(result, "h[e]ll[o]");
        assert_eq!(count, 2);
    }

    // ===== Leading whitespace numeric conversion via sprintf =====

    #[test]
    fn sprintf_numeric_string_with_leading_spaces() {
        // "  42" formatted as %d should strip leading whitespace and yield 42
        let result = sprintf_format("%d", &[Value::Str("  42".to_string())]);
        assert_eq!(result, "42");
    }

    #[test]
    fn sprintf_numeric_string_with_tabs() {
        let result = sprintf_format("%d", &[Value::Str("\t7".to_string())]);
        assert_eq!(result, "7");
    }

    // ===== OFMT / number-to-string via sprintf =====

    #[test]
    fn sprintf_integer_value_prints_without_decimal() {
        // An integer stored as f64 should format cleanly with %g
        let result = sprintf_format("%g", &[Value::Num(42.0)]);
        assert_eq!(result, "42");
    }

    #[test]
    fn sprintf_float_value_uses_precision() {
        let result = sprintf_format("%.2f", &[Value::Num(3.14159)]);
        assert_eq!(result, "3.14");
    }

    // ===== BEGIN + END rules — pattern classification =====

    #[test]
    fn parse_begin_pattern_recognized() {
        let prog = parse_program_str(r#"BEGIN { x = 0 }"#);
        assert_eq!(prog.rules.len(), 1);
        assert!(matches!(&prog.rules[0].pattern, Some(Pattern::Begin)));
    }

    #[test]
    fn parse_end_pattern_recognized() {
        let prog = parse_program_str(r#"END { print x }"#);
        assert_eq!(prog.rules.len(), 1);
        assert!(matches!(&prog.rules[0].pattern, Some(Pattern::End)));
    }

    // ===== Range pattern =====

    #[test]
    fn parse_range_pattern() {
        // /start/,/end/ { } — range pattern
        let prog = parse_program_str(r#"/start/,/end/ { print }"#);
        assert_eq!(prog.rules.len(), 1);
        match &prog.rules[0].pattern {
            Some(Pattern::Range(from, to)) => {
                assert!(matches!(from, Expr::Regex(r) if r == "start"));
                assert!(matches!(to, Expr::Regex(r) if r == "end"));
            }
            _ => panic!("expected Range pattern"),
        }
    }

    // ===== Ternary expression =====

    #[test]
    fn parse_ternary_expression() {
        // x = (a > b) ? a : b
        let prog = parse_program_str(r#"{ x = (a > b) ? a : b }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Assign(_, rhs)) => {
                assert!(matches!(rhs.as_ref(), Expr::Ternary(_, _, _)));
            }
            _ => panic!("expected Assign with Ternary rhs"),
        }
    }

    // ===== Function definition parsing =====

    #[test]
    fn parse_function_definition() {
        let prog = parse_program_str(r#"function add(a, b) { return a + b }"#);
        assert_eq!(prog.functions.len(), 1);
        assert_eq!(prog.functions[0].name, "add");
        assert_eq!(prog.functions[0].params, vec!["a", "b"]);
        assert_eq!(prog.functions[0].body.len(), 1);
        assert!(matches!(&prog.functions[0].body[0], Stmt::Return(Some(_))));
    }

    // ===== Getline expression parsing =====

    #[test]
    fn parse_getline_from_file() {
        // getline < "file" — reads from file into $0
        let prog = parse_program_str(r#"{ getline < "input.txt" }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Getline(var, file)) => {
                assert!(var.is_none());
                assert!(matches!(
                    file.as_ref().map(|f| f.as_ref()),
                    Some(Expr::Str(s)) if s == "input.txt"
                ));
            }
            _ => panic!("expected Getline expression"),
        }
    }

    #[test]
    fn parse_getline_into_var() {
        // getline line — reads next record into variable `line`
        let prog = parse_program_str(r#"{ getline line }"#);
        match &prog.rules[0].action[0] {
            Stmt::Expr(Expr::Getline(var, file)) => {
                assert!(matches!(
                    var.as_ref().map(|v| v.as_ref()),
                    Some(Expr::Var(n)) if n == "line"
                ));
                assert!(file.is_none());
            }
            _ => panic!("expected Getline with var"),
        }
    }
}
