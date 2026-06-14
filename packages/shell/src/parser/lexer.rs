use crate::parser::ast::{Span, WordPart};

/// Tokens produced by the lexer.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    /// A word (bare, single-quoted, double-quoted, or any adjacent mix).
    /// Single-quoted content becomes `Literal`; double-quoted content keeps
    /// `Var`/`CmdSub`/`BraceVar` parts. Adjacent quoting is merged here so
    /// the parser never needs to stitch tokens together.
    Word(Vec<WordPart>),
    /// `|`
    Pipe,
    /// `&`
    Amp,
    /// `&&`
    AmpAmp,
    /// `|&`
    PipeAmp,
    /// `||`
    PipePipe,
    /// `;`
    Semi,
    /// Newline
    Newline,
    /// `>`
    Gt,
    /// `>|`
    GtPipe,
    /// `>>`
    GtGt,
    /// `<`
    Lt,
    /// `2>`
    Fd2Gt,
    /// `2>>`
    Fd2GtGt,
    /// `2>&1`
    Fd2GtAmp1,
    /// `&>`
    AmpGt,
    /// `<<<`
    HereString,
    /// `<<DELIM` ... `DELIM` — heredoc content. Bool is true if variable expansion should occur.
    HereDoc(String, bool),
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `(( expr ))` — arithmetic command (raw expression content)
    ArithCommand(String),
    /// `[[`
    DoubleBracketOpen,
    /// `]]`
    DoubleBracketClose,
    /// `N>` where N is a file descriptor number (> 2)
    FdNGt(u32),
    /// `N>>` where N is a file descriptor number (> 2)
    FdNGtGt(u32),
    /// `N>&M` — duplicate fd M to fd N
    FdNGtAmp(u32, u32),
    /// `N>&-` — close fd N
    FdNGtClose(u32),
    /// `N<` where N is a file descriptor number (> 0)
    FdNLt(u32),
    /// `N<>` where N is a file descriptor number — bidirectional open
    FdNLtGt(u32),
    /// End of input
    Eof,
}

pub struct Lexer {
    chars: Vec<char>,
    pos: usize,
    line: u32,
    col: u32,
    pub extglob: bool,
}

impl Lexer {
    pub fn new(input: &str) -> Self {
        Lexer { chars: input.chars().collect(), pos: 0, line: 1, col: 1, extglob: false }
    }

    pub fn span(&self) -> Span {
        Span { line: self.line, col: self.col }
    }

    pub fn tokenize(&mut self) -> Vec<Token> {
        self.tokenize_with_spans().0
    }

    pub fn tokenize_with_spans(&mut self) -> (Vec<Token>, Vec<Span>) {
        let mut tokens = Vec::new();
        let mut spans = Vec::new();
        loop {
            let span = self.span();
            let tok = self.next_token();
            let done = tok == Token::Eof;
            spans.push(span);
            tokens.push(tok);
            if done { break; }
        }
        (tokens, spans)
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if let Some(ch) = c {
            self.pos += 1;
            if ch == '\n' {
                self.line += 1;
                self.col = 1;
            } else {
                self.col += 1;
            }
        }
        c
    }

    fn next_token(&mut self) -> Token {
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.advance();
        }

        if self.peek() == Some('#') {
            while !matches!(self.peek(), Some('\n') | None) {
                self.advance();
            }
        }

        match self.peek() {
            None => Token::Eof,
            Some('\n') => { self.advance(); Token::Newline }
            Some(';') => { self.advance(); Token::Semi }
            Some('|') => {
                self.advance();
                if self.peek() == Some('|') { self.advance(); Token::PipePipe }
                else if self.peek() == Some('&') { self.advance(); Token::PipeAmp }
                else { Token::Pipe }
            }
            Some('&') => {
                self.advance();
                if self.peek() == Some('&') { self.advance(); Token::AmpAmp }
                else if self.peek() == Some('>') { self.advance(); Token::AmpGt }
                else { Token::Amp }
            }
            Some('>') => {
                if self.peek2() == Some('(') {
                    self.advance(); // consume '>'
                    self.advance(); // consume '('
                    let raw = self.read_until_close_paren();
                    Token::Word(vec![WordPart::ProcSubOut(raw)])
                } else {
                    self.advance();
                    if self.peek() == Some('>') { self.advance(); Token::GtGt }
                    else if self.peek() == Some('|') { self.advance(); Token::GtPipe }
                    else if self.peek() == Some('&') {
                        // >&N (dup fd N to stdout) or >&- (close stdout)
                        let after_amp = self.chars.get(self.pos + 1).copied();
                        if after_amp == Some('-') {
                            self.advance(); // consume '&'
                            self.advance(); // consume '-'
                            Token::FdNGtClose(1)
                        } else if after_amp.map_or(false, |c| c.is_ascii_digit()) {
                            self.advance(); // consume '&'
                            let mut target = String::new();
                            while let Some(c) = self.peek() {
                                if c.is_ascii_digit() { target.push(c); self.advance(); }
                                else { break; }
                            }
                            let target_fd: u32 = target.parse().unwrap_or(1);
                            Token::FdNGtAmp(1, target_fd)
                        } else {
                            Token::Gt
                        }
                    }
                    else { Token::Gt }
                }
            }
            Some('<') => {
                if self.peek2() == Some('(') {
                    self.advance(); // consume '<'
                    self.advance(); // consume '('
                    let raw = self.read_until_close_paren();
                    Token::Word(vec![WordPart::ProcSubIn(raw)])
                } else {
                    self.advance(); // consume first '<'
                    if self.peek() == Some('<') {
                        self.advance(); // consume second '<'
                        if self.peek() == Some('<') {
                            self.advance(); // consume third '<'
                            Token::HereString
                        } else {
                            // heredoc: <<
                            self.read_heredoc()
                        }
                    } else {
                        Token::Lt
                    }
                }
            }
            Some(d @ '0'..='9') if self.peek2() == Some('>') => {
                let fd = (d as u32) - ('0' as u32);
                self.advance(); // digit
                self.advance(); // '>'
                if self.peek() == Some('>') {
                    self.advance();
                    if fd == 2 { Token::Fd2GtGt } else { Token::FdNGtGt(fd) }
                } else if self.peek() == Some('&') {
                    self.advance(); // consume '&'
                    if self.peek() == Some('-') {
                        self.advance(); // consume '-'
                        if fd == 2 {
                            // 2>&- treat as close; use FdNGtClose
                            Token::FdNGtClose(2)
                        } else {
                            Token::FdNGtClose(fd)
                        }
                    } else {
                        // Read the target fd number
                        let mut target = String::new();
                        while let Some(c) = self.peek() {
                            if c.is_ascii_digit() { target.push(c); self.advance(); }
                            else { break; }
                        }
                        let target_fd: u32 = target.parse().unwrap_or(1);
                        if fd == 2 && target_fd == 1 {
                            Token::Fd2GtAmp1
                        } else {
                            Token::FdNGtAmp(fd, target_fd)
                        }
                    }
                } else {
                    if fd == 2 { Token::Fd2Gt } else { Token::FdNGt(fd) }
                }
            }
            Some(d @ '0'..='9') if self.peek2() == Some('<') && {
                // Only match N< if not followed by ( which would be process substitution
                let after = self.chars.get(self.pos + 2).copied();
                after != Some('(')
            } => {
                let fd = (d as u32) - ('0' as u32);
                self.advance(); // digit
                self.advance(); // '<'
                if self.peek() == Some('>') {
                    self.advance(); // '>'
                    Token::FdNLtGt(fd)
                } else {
                    Token::FdNLt(fd)
                }
            }
            Some('(') => {
                if self.peek2() == Some('(') {
                    self.advance(); self.advance(); // consume ((
                    let expr = self.read_until_double_close_paren();
                    Token::ArithCommand(expr)
                } else {
                    self.advance();
                    Token::LParen
                }
            }
            Some(')') => { self.advance(); Token::RParen }
            Some('[') if self.peek2() == Some('[') => {
                // Only emit DoubleBracketOpen if what follows the [[ is whitespace/EOF
                let after = self.chars.get(self.pos + 2).copied();
                if matches!(after, Some(' ') | Some('\t') | Some('\n') | None) {
                    self.advance(); self.advance();
                    Token::DoubleBracketOpen
                } else {
                    self.read_word()
                }
            }
            Some(']') if self.peek2() == Some(']') => {
                self.advance(); self.advance();
                Token::DoubleBracketClose
            }
            // Quotes and word chars all enter read_word.
            // Adjacent quoting ('foo'"bar"baz) is merged inside read_word.
            _ => self.read_word(),
        }
    }

    fn read_heredoc(&mut self) -> Token {
        let strip_tabs = self.peek() == Some('-');
        if strip_tabs { self.advance(); }

        // Skip optional whitespace (but not newline) before delimiter
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.advance();
        }

        // Read delimiter (may be quoted)
        let mut expand = true;
        let delim = match self.peek() {
            Some('\'') => {
                expand = false;
                self.advance();
                let mut d = String::new();
                while let Some(c) = self.peek() {
                    if c == '\'' { self.advance(); break; }
                    d.push(c);
                    self.advance();
                }
                d
            }
            Some('"') => {
                expand = false;
                self.advance();
                let mut d = String::new();
                while let Some(c) = self.peek() {
                    if c == '"' { self.advance(); break; }
                    d.push(c);
                    self.advance();
                }
                d
            }
            _ => {
                let mut d = String::new();
                while let Some(c) = self.peek() {
                    if matches!(c, '\n' | ' ' | '\t' | ';') { break; }
                    d.push(c);
                    self.advance();
                }
                d
            }
        };

        // Save remaining text on this line (e.g., "> /tmp/file") for tokenization after heredoc body.
        // In bash, `cat << EOF > file` means the `> file` is part of the command's redirect list.
        let mut trailing: Vec<char> = Vec::new();
        while self.peek() != Some('\n') && self.peek().is_some() {
            trailing.push(self.chars[self.pos]);
            self.pos += 1;
            self.col += 1;
        }
        if self.peek() == Some('\n') {
            self.advance(); // consume the newline before heredoc body
        }

        // Read content lines until a line matches the delimiter exactly
        let mut content = String::new();
        loop {
            let mut line = String::new();
            loop {
                match self.peek() {
                    None => break,
                    Some('\n') => { self.advance(); break; }
                    Some(c) => { line.push(c); self.advance(); }
                }
            }

            let check_line = if strip_tabs {
                line.trim_start_matches('\t').to_string()
            } else {
                line.clone()
            };

            if check_line == delim {
                break;
            }

            let content_line = if strip_tabs { check_line } else { line };
            content.push_str(&content_line);
            content.push('\n');

            if self.peek().is_none() {
                break; // EOF before delimiter found
            }
        }

        // Re-inject trailing text (e.g., " > /tmp/file") back into the input stream
        // so it gets tokenized as part of the same command (redirects following the heredoc).
        // Append a newline to terminate the logical command line.
        if !trailing.is_empty() {
            let mut inject: Vec<char> = trailing;
            inject.push('\n');
            let insert_pos = self.pos;
            self.chars.splice(insert_pos..insert_pos, inject);
        }

        Token::HereDoc(content, expand)
    }

    fn read_word(&mut self) -> Token {
        let mut parts: Vec<WordPart> = Vec::new();
        let mut buf = String::new();

        loop {
            match self.peek() {
                None => break,
                // Extglob: ?(, *(, +(, @(, !( — consume the entire extglob expression as literal
                Some(c) if self.extglob && matches!(c, '?' | '*' | '+' | '@' | '!') && self.peek2() == Some('(') => {
                    buf.push(c);
                    self.advance(); // consume operator char
                    buf.push('(');
                    self.advance(); // consume '('
                    let mut depth = 1u32;
                    while depth > 0 {
                        match self.peek() {
                            None => break,
                            Some('(') => { buf.push('('); self.advance(); depth += 1; }
                            Some(')') => {
                                depth -= 1;
                                if depth > 0 { buf.push(')'); }
                                self.advance();
                            }
                            Some('\\') => {
                                self.advance();
                                buf.push('\\');
                                if let Some(c2) = self.peek() { buf.push(c2); self.advance(); }
                            }
                            Some(ch) => { buf.push(ch); self.advance(); }
                        }
                    }
                    buf.push(')');
                }
                // Hard delimiters — end word
                Some(c) if matches!(c, ' ' | '\t' | '\n' | '|' | '&' | ';' | '(' | ')') => break,
                // Redirect operators — end word (special: digit followed by '>' or '<' is handled
                // in next_token, so here we stop if the buf is a single digit and parts is empty)
                Some('>') | Some('<') => {
                    if buf.is_empty() && parts.is_empty() { break; }
                    if buf.len() == 1 && buf.as_bytes()[0].is_ascii_digit() && parts.is_empty() { break; }
                    break;
                }
                Some('#') if buf.is_empty() && parts.is_empty() => break,
                Some('#') => { buf.push('#'); self.advance(); }
                Some('\\') => {
                    self.advance();
                    if let Some(c) = self.advance() {
                        if c != '\n' { buf.push(c); }
                    }
                }
                Some('$') => {
                    self.read_dollar(&mut parts, &mut buf);
                }
                Some('`') => {
                    if !buf.is_empty() {
                        parts.push(WordPart::Literal(std::mem::take(&mut buf)));
                    }
                    self.advance();
                    let raw = self.read_until_backtick();
                    parts.push(WordPart::CmdSub(raw));
                }
                // Inline single-quote: literal content, no expansion
                Some('\'') => {
                    self.advance(); // consume opening '
                    let s = self.read_single_quoted_str();
                    if !buf.is_empty() {
                        parts.push(WordPart::Literal(std::mem::take(&mut buf)));
                    }
                    parts.push(WordPart::Quoted(s));
                }
                // Inline double-quote: expansion within quotes
                Some('"') => {
                    self.advance(); // consume opening "
                    if !buf.is_empty() {
                        parts.push(WordPart::Literal(std::mem::take(&mut buf)));
                    }
                    let dq = self.read_dq_parts_until(|c| c == '"');
                    self.advance(); // consume closing "
                    parts.extend(dq);
                }
                Some(c) => {
                    buf.push(c); self.advance();
                }
            }
        }

        if !buf.is_empty() {
            parts.push(WordPart::Literal(buf));
        }

        Token::Word(parts)
    }

    /// Read `$`-expression and push result into parts/buf.
    fn read_dollar(&mut self, parts: &mut Vec<WordPart>, buf: &mut String) {
        self.advance(); // consume '$'
        match self.peek() {
            Some('{') => {
                self.advance();
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                let raw = self.read_brace_var();
                parts.push(WordPart::BraceVar(raw));
            }
            Some('(') => {
                self.advance(); // consume first '('
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                if self.peek() == Some('(') {
                    // $(( — arithmetic substitution
                    self.advance(); // consume second '('
                    let raw = self.read_arith_expr();
                    parts.push(WordPart::ArithSub(raw));
                } else {
                    // $( — command substitution
                    let raw = self.read_until_close_paren();
                    parts.push(WordPart::CmdSub(raw));
                }
            }
            Some(c) if c.is_alphanumeric() || c == '_' => {
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                let name = self.read_var_name();
                parts.push(WordPart::Var(name));
            }
            Some(c) if matches!(c, '?' | '#' | '@' | '*' | '!' | '$' | '-' | '0'..='9') => {
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                self.advance();
                parts.push(WordPart::Var(c.to_string()));
            }
            _ => buf.push('$'),
        }
    }

    /// Like the former `read_parts_until` but emits `Quoted` for literal segments (used inside double quotes).
    pub(crate) fn read_dq_parts_until(&mut self, end_pred: impl Fn(char) -> bool) -> Vec<WordPart> {
        let mut parts: Vec<WordPart> = Vec::new();
        let mut buf = String::new();

        loop {
            match self.peek() {
                None => break,
                Some(c) if end_pred(c) => break,
                Some('\\') => {
                    self.advance();
                    if let Some(c) = self.advance() {
                        match c {
                            '"' | '\\' | '$' | '`' | '\n' => buf.push(c),
                            _ => { buf.push('\\'); buf.push(c); }
                        }
                    }
                }
                Some('$') => {
                    if !buf.is_empty() {
                        parts.push(WordPart::Quoted(std::mem::take(&mut buf)));
                    }
                    // Temporarily borrow a plain buf for read_dollar, then convert Literals to Quoted
                    let mut tmp_buf = String::new();
                    let mut tmp_parts: Vec<WordPart> = Vec::new();
                    self.read_dollar(&mut tmp_parts, &mut tmp_buf);
                    if !tmp_buf.is_empty() {
                        parts.push(WordPart::Quoted(tmp_buf));
                    }
                    parts.extend(tmp_parts);
                }
                Some('`') => {
                    if !buf.is_empty() {
                        parts.push(WordPart::Quoted(std::mem::take(&mut buf)));
                    }
                    self.advance();
                    let raw = self.read_until_backtick();
                    parts.push(WordPart::CmdSub(raw));
                }
                Some(c) => {
                    buf.push(c);
                    self.advance();
                }
            }
        }

        if !buf.is_empty() {
            parts.push(WordPart::Quoted(buf));
        }
        parts
    }

    fn read_single_quoted_str(&mut self) -> String {
        let mut s = String::new();
        loop {
            match self.advance() {
                None | Some('\'') => break,
                Some(c) => s.push(c),
            }
        }
        s
    }

    fn read_brace_var(&mut self) -> String {
        let mut s = String::new();
        let mut depth = 1;
        loop {
            match self.advance() {
                None => break,
                Some('{') => { depth += 1; s.push('{'); }
                Some('}') => {
                    depth -= 1;
                    if depth == 0 { break; }
                    s.push('}');
                }
                Some(c) => s.push(c),
            }
        }
        s
    }

    fn read_until_close_paren(&mut self) -> String {
        let mut s = String::new();
        let mut depth = 1;
        let mut in_single = false;
        loop {
            match self.advance() {
                None => break,
                Some('\'') if !in_single => { in_single = true; s.push('\''); }
                Some('\'') if in_single => { in_single = false; s.push('\''); }
                Some('(') if !in_single => { depth += 1; s.push('('); }
                Some(')') if !in_single => {
                    depth -= 1;
                    if depth == 0 { break; }
                    s.push(')');
                }
                Some(c) => s.push(c),
            }
        }
        s
    }

    fn read_until_double_close_paren(&mut self) -> String {
        let mut s = String::new();
        let mut depth = 0usize;
        loop {
            match self.peek() {
                None => break,
                Some('(') => { depth += 1; s.push('('); self.advance(); }
                Some(')') if depth > 0 => { depth -= 1; s.push(')'); self.advance(); }
                Some(')') => {
                    if self.chars.get(self.pos + 1) == Some(&')') {
                        self.advance(); self.advance(); // consume ))
                        break;
                    }
                    s.push(')'); self.advance();
                }
                Some(c) => { s.push(c); self.advance(); }
            }
        }
        s.trim().to_string()
    }

    fn read_arith_expr(&mut self) -> String {
        let mut s = String::new();
        let mut paren_depth = 0;
        loop {
            match self.peek() {
                None => break,
                Some('(') => { paren_depth += 1; s.push('('); self.advance(); }
                Some(')') if paren_depth > 0 => { paren_depth -= 1; s.push(')'); self.advance(); }
                Some(')') => {
                    // Check for ))
                    if self.chars.get(self.pos + 1) == Some(&')') {
                        self.advance(); // first )
                        self.advance(); // second )
                        break;
                    }
                    s.push(')');
                    self.advance();
                }
                Some(c) => { s.push(c); self.advance(); }
            }
        }
        s
    }

    fn read_until_backtick(&mut self) -> String {
        let mut s = String::new();
        loop {
            match self.advance() {
                None | Some('`') => break,
                Some(c) => s.push(c),
            }
        }
        s
    }

    fn read_var_name(&mut self) -> String {
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

/// Parse a heredoc content string into `WordPart`s with variable/command expansion.
/// This is used when the heredoc delimiter is unquoted (expand=true).
pub fn parse_heredoc_content(content: &str) -> Vec<WordPart> {
    let mut lexer = Lexer::new(content);
    lexer.read_dq_parts_until(|_| false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex(input: &str) -> Vec<Token> {
        let mut l = Lexer::new(input);
        let mut toks = l.tokenize();
        if toks.last() == Some(&Token::Eof) { toks.pop(); }
        toks
    }

    fn word(parts: Vec<WordPart>) -> Token { Token::Word(parts) }
    fn lit(s: &str) -> WordPart { WordPart::Literal(s.into()) }
    fn quoted(s: &str) -> WordPart { WordPart::Quoted(s.into()) }
    fn var(s: &str) -> WordPart { WordPart::Var(s.into()) }

    #[test]
    fn test_simple_words() {
        assert_eq!(lex("echo hello"), vec![
            word(vec![lit("echo")]),
            word(vec![lit("hello")]),
        ]);
    }

    #[test]
    fn test_pipe() {
        assert_eq!(lex("a | b"), vec![
            word(vec![lit("a")]), Token::Pipe, word(vec![lit("b")]),
        ]);
    }


    #[test]
    fn test_pipe_amp() {
        assert_eq!(lex("a |& b"), vec![
            word(vec![lit("a")]), Token::PipeAmp, word(vec![lit("b")]),
        ]);
    }

    #[test]
    fn test_pipe_amp_vs_pipe_pipe() {
        assert_eq!(lex("a |& b || c"), vec![
            word(vec![lit("a")]), Token::PipeAmp,
            word(vec![lit("b")]), Token::PipePipe,
            word(vec![lit("c")]),
        ]);
    }

    #[test]
    fn test_and_or() {
        assert_eq!(lex("a && b || c"), vec![
            word(vec![lit("a")]), Token::AmpAmp,
            word(vec![lit("b")]), Token::PipePipe,
            word(vec![lit("c")]),
        ]);
    }

    #[test]
    fn test_redirections() {
        assert_eq!(lex(">"), vec![Token::Gt]);
        assert_eq!(lex(">>"), vec![Token::GtGt]);
        assert_eq!(lex("<"), vec![Token::Lt]);
        assert_eq!(lex("2>"), vec![Token::Fd2Gt]);
        assert_eq!(lex("2>>"), vec![Token::Fd2GtGt]);
        assert_eq!(lex("2>&1"), vec![Token::Fd2GtAmp1]);
        assert_eq!(lex("&>"), vec![Token::AmpGt]);
        assert_eq!(lex("<<<"), vec![Token::HereString]);
    }

    #[test]
    fn test_single_quoted() {
        // Single-quoted string becomes Word([Quoted(...)])
        assert_eq!(lex("'hello world'"), vec![
            word(vec![quoted("hello world")]),
        ]);
    }

    #[test]
    fn test_double_quoted_literal() {
        assert_eq!(lex("\"hello\""), vec![
            word(vec![quoted("hello")]),
        ]);
    }

    #[test]
    fn test_double_quoted_var() {
        assert_eq!(lex("\"$FOO\""), vec![
            word(vec![var("FOO")]),
        ]);
    }

    #[test]
    fn test_double_quoted_mixed() {
        assert_eq!(lex("\"hello $NAME!\""), vec![
            word(vec![
                quoted("hello "),
                var("NAME"),
                quoted("!"),
            ]),
        ]);
    }

    #[test]
    fn test_semicolon() {
        assert_eq!(lex("a ; b"), vec![
            word(vec![lit("a")]), Token::Semi, word(vec![lit("b")]),
        ]);
    }

    #[test]
    fn test_var_in_word() {
        let toks = lex("echo $HOME/bin");
        assert_eq!(toks, vec![
            word(vec![lit("echo")]),
            word(vec![var("HOME"), lit("/bin")]),
        ]);
    }

    #[test]
    fn test_comment() {
        assert_eq!(lex("echo hi # comment"), vec![
            word(vec![lit("echo")]),
            word(vec![lit("hi")]),
        ]);
    }

    #[test]
    fn test_backslash_escape() {
        let toks = lex("echo hell\\o");
        assert_eq!(toks, vec![
            word(vec![lit("echo")]),
            word(vec![lit("hello")]),
        ]);
    }

    #[test]
    fn test_dollar_paren_cmd_sub() {
        assert_eq!(lex("$(cmd arg)"), vec![
            word(vec![WordPart::CmdSub("cmd arg".into())]),
        ]);
    }

    #[test]
    fn test_brace_var_in_word() {
        assert_eq!(lex("${FOO:-bar}"), vec![
            word(vec![WordPart::BraceVar("FOO:-bar".into())]),
        ]);
    }

    #[test]
    fn test_backtick_cmd_sub() {
        assert_eq!(lex("`whoami`"), vec![
            word(vec![WordPart::CmdSub("whoami".into())]),
        ]);
    }

    #[test]
    fn test_background_amp() {
        assert_eq!(lex("sleep 1 &"), vec![
            word(vec![lit("sleep")]),
            word(vec![lit("1")]),
            Token::Amp,
        ]);
    }

    #[test]
    fn test_adjacent_single_double_quote() {
        // 'foo'"bar" is ONE word token
        assert_eq!(lex("'foo'\"bar\""), vec![
            word(vec![quoted("foo"), quoted("bar")]),
        ]);
    }

    #[test]
    fn test_adjacent_bare_and_single() {
        // foo'bar' is ONE word token
        assert_eq!(lex("foo'bar'"), vec![
            word(vec![lit("foo"), quoted("bar")]),
        ]);
    }

    #[test]
    fn test_adjacent_separated_are_two_words() {
        // 'foo' "bar" (with space) is TWO tokens
        assert_eq!(lex("'foo' \"bar\""), vec![
            word(vec![quoted("foo")]),
            word(vec![quoted("bar")]),
        ]);
    }

    #[test]
    fn test_parens() {
        assert_eq!(lex("("), vec![Token::LParen]);
        assert_eq!(lex(")"), vec![Token::RParen]);
        assert_eq!(lex("()"), vec![Token::LParen, Token::RParen]);
    }

    #[test]
    fn test_double_brackets() {
        assert_eq!(lex("[[ x ]]"), vec![
            Token::DoubleBracketOpen,
            word(vec![lit("x")]),
            Token::DoubleBracketClose,
        ]);
    }

    #[test]
    fn test_arith_sub() {
        let tokens = lex("echo $((1 + 2))");
        assert_eq!(tokens, vec![
            word(vec![lit("echo")]),
            word(vec![WordPart::ArithSub("1 + 2".into())]),
        ]);
    }

    #[test]
    fn test_arith_sub_nested_parens() {
        let tokens = lex("echo $(( (3+4) * 2 ))");
        assert_eq!(tokens, vec![
            word(vec![lit("echo")]),
            word(vec![WordPart::ArithSub(" (3+4) * 2 ".into())]),
        ]);
    }

    #[test]
    fn test_arith_vs_cmdsub() {
        let tokens = lex("$((x+1)) $(echo hi)");
        assert_eq!(tokens, vec![
            word(vec![WordPart::ArithSub("x+1".into())]),
            word(vec![WordPart::CmdSub("echo hi".into())]),
        ]);
    }

    #[test]
    fn test_function_syntax_tokens() {
        assert_eq!(lex("foo()"), vec![
            word(vec![lit("foo")]),
            Token::LParen,
            Token::RParen,
        ]);
    }

    #[test]
    fn test_arith_command() {
        assert_eq!(lex("(( x + 1 ))"), vec![
            Token::ArithCommand("x + 1".into()),
        ]);
    }

    #[test]
    fn test_arith_command_nested_parens() {
        assert_eq!(lex("(( (3+4) * 2 ))"), vec![
            Token::ArithCommand("(3+4) * 2".into()),
        ]);
    }

    #[test]
    fn test_arith_command_assign() {
        assert_eq!(lex("(( x = 5 + 3 ))"), vec![
            Token::ArithCommand("x = 5 + 3".into()),
        ]);
    }

    #[test]
    fn test_proc_sub_in() {
        let tokens = lex("cat <(echo hi)");
        assert_eq!(tokens, vec![
            word(vec![lit("cat")]),
            word(vec![WordPart::ProcSubIn("echo hi".into())]),
        ]);
    }

    #[test]
    fn test_proc_sub_out() {
        let tokens = lex("tee >(cat)");
        assert_eq!(tokens, vec![
            word(vec![lit("tee")]),
            word(vec![WordPart::ProcSubOut("cat".into())]),
        ]);
    }

    #[test]
    fn test_proc_sub_in_nested_parens() {
        let tokens = lex("<(echo (foo))");
        assert_eq!(tokens, vec![
            word(vec![WordPart::ProcSubIn("echo (foo)".into())]),
        ]);
    }

    #[test]
    fn test_redirect_lt_still_works() {
        assert_eq!(lex("<"), vec![Token::Lt]);
        assert_eq!(lex("< file"), vec![Token::Lt, word(vec![lit("file")])]);
    }

    #[test]
    fn test_redirect_gt_still_works() {
        assert_eq!(lex(">"), vec![Token::Gt]);
        assert_eq!(lex(">> file"), vec![Token::GtGt, word(vec![lit("file")])]);
    }

    #[test]
    fn test_heredoc_basic() {
        let tokens = lex("<<EOF\nhello\nworld\nEOF\n");
        assert_eq!(tokens, vec![
            Token::HereDoc("hello\nworld\n".into(), true),
        ]);
    }

    #[test]
    fn test_heredoc_quoted_delimiter_no_expand() {
        let tokens = lex("<<'EOF'\nhello $name\nEOF\n");
        assert_eq!(tokens, vec![
            Token::HereDoc("hello $name\n".into(), false),
        ]);
    }

    #[test]
    fn test_heredoc_double_quoted_delimiter_no_expand() {
        let tokens = lex("<<\"EOF\"\nhello\nEOF\n");
        assert_eq!(tokens, vec![
            Token::HereDoc("hello\n".into(), false),
        ]);
    }

    #[test]
    fn test_heredoc_strip_tabs() {
        let tokens = lex("<<-EOF\n\thello\n\tworld\nEOF\n");
        assert_eq!(tokens, vec![
            Token::HereDoc("hello\nworld\n".into(), true),
        ]);
    }

    #[test]
    fn test_herestring_still_works() {
        assert_eq!(lex("<<<"), vec![Token::HereString]);
        assert_eq!(lex("<<< word"), vec![Token::HereString, word(vec![lit("word")])]);
    }

    #[test]
    fn test_heredoc_with_output_redirect() {
        // `cat << EOF > /tmp/file` should produce HereDoc + Gt + Word tokens
        let tokens = lex("cat << EOF > /tmp/file\nhello\nEOF\n");
        assert_eq!(tokens, vec![
            word(vec![lit("cat")]),
            Token::HereDoc("hello\n".into(), true),
            Token::Gt,
            word(vec![lit("/tmp/file")]),
            Token::Newline,
        ]);
    }

    #[test]
    fn test_heredoc_with_append_redirect() {
        let tokens = lex("cat << EOF >> /tmp/file\ndata\nEOF\n");
        assert_eq!(tokens, vec![
            word(vec![lit("cat")]),
            Token::HereDoc("data\n".into(), true),
            Token::GtGt,
            word(vec![lit("/tmp/file")]),
            Token::Newline,
        ]);
    }

    #[test]
    fn test_heredoc_with_stderr_and_output_redirect() {
        let tokens = lex("cat << EOF 2>/dev/null > /tmp/file\ndata\nEOF\n");
        assert_eq!(tokens, vec![
            word(vec![lit("cat")]),
            Token::HereDoc("data\n".into(), true),
            Token::Fd2Gt,
            word(vec![lit("/dev/null")]),
            Token::Gt,
            word(vec![lit("/tmp/file")]),
            Token::Newline,
        ]);
    }

    #[test]
    fn test_heredoc_no_trailing_unchanged() {
        // Without trailing redirect, behavior unchanged
        let tokens = lex("<<EOF\nhello\nEOF\n");
        assert_eq!(tokens, vec![
            Token::HereDoc("hello\n".into(), true),
        ]);
    }
}
