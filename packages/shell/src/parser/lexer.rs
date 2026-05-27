use crate::parser::ast::WordPart;

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
    /// `||`
    PipePipe,
    /// `;`
    Semi,
    /// Newline
    Newline,
    /// `>`
    Gt,
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
    /// End of input
    Eof,
}

pub struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    pub fn new(input: &str) -> Self {
        Lexer { chars: input.chars().collect(), pos: 0 }
    }

    pub fn tokenize(&mut self) -> Vec<Token> {
        let mut tokens = Vec::new();
        loop {
            let tok = self.next_token();
            let done = tok == Token::Eof;
            tokens.push(tok);
            if done { break; }
        }
        tokens
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if c.is_some() { self.pos += 1; }
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
                else { Token::Pipe }
            }
            Some('&') => {
                self.advance();
                if self.peek() == Some('&') { self.advance(); Token::AmpAmp }
                else if self.peek() == Some('>') { self.advance(); Token::AmpGt }
                else { Token::Amp }
            }
            Some('>') => {
                self.advance();
                if self.peek() == Some('>') { self.advance(); Token::GtGt }
                else { Token::Gt }
            }
            Some('<') => {
                self.advance();
                if self.peek() == Some('<') && self.peek2() == Some('<') {
                    self.advance(); self.advance();
                    Token::HereString
                } else {
                    Token::Lt
                }
            }
            Some('2') if self.peek2() == Some('>') => {
                self.advance(); // '2'
                self.advance(); // '>'
                if self.peek() == Some('>') {
                    self.advance();
                    Token::Fd2GtGt
                } else if self.peek() == Some('&') && self.chars.get(self.pos + 1) == Some(&'1') {
                    self.advance(); self.advance();
                    Token::Fd2GtAmp1
                } else {
                    Token::Fd2Gt
                }
            }
            // Quotes and word chars all enter read_word.
            // Adjacent quoting ('foo'"bar"baz) is merged inside read_word.
            _ => self.read_word(),
        }
    }

    fn read_word(&mut self) -> Token {
        let mut parts: Vec<WordPart> = Vec::new();
        let mut buf = String::new();

        loop {
            match self.peek() {
                None => break,
                // Hard delimiters — end word
                Some(c) if matches!(c, ' ' | '\t' | '\n' | '|' | '&' | ';' | ')') => break,
                // Redirect operators — end word (special: '2' followed by '>' is handled in next_token,
                // so here we only stop if the word is empty or the buf is just '2')
                Some('>') | Some('<') => {
                    if buf.is_empty() && parts.is_empty() { break; }
                    if buf == "2" && parts.is_empty() { break; }
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
                    parts.push(WordPart::Literal(s));
                }
                // Inline double-quote: expansion within quotes
                Some('"') => {
                    self.advance(); // consume opening "
                    if !buf.is_empty() {
                        parts.push(WordPart::Literal(std::mem::take(&mut buf)));
                    }
                    let dq = self.read_parts_until(|c| c == '"');
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
                self.advance();
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                let raw = self.read_until_close_paren();
                parts.push(WordPart::CmdSub(raw));
            }
            Some(c) if c.is_alphanumeric() || c == '_' => {
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                let name = self.read_var_name();
                parts.push(WordPart::Var(name));
            }
            Some(c) if matches!(c, '?' | '#' | '@' | '*' | '0'..='9') => {
                if !buf.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(buf)));
                }
                self.advance();
                parts.push(WordPart::Var(c.to_string()));
            }
            _ => buf.push('$'),
        }
    }

    /// Read parts (literals, vars, cmd subs) until `end_pred` matches.
    /// Does NOT consume the terminator.
    fn read_parts_until(&mut self, end_pred: impl Fn(char) -> bool) -> Vec<WordPart> {
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
                Some(c) => {
                    buf.push(c);
                    self.advance();
                }
            }
        }

        if !buf.is_empty() {
            parts.push(WordPart::Literal(buf));
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
        // Single-quoted string becomes Word([Literal(...)])
        assert_eq!(lex("'hello world'"), vec![
            word(vec![lit("hello world")]),
        ]);
    }

    #[test]
    fn test_double_quoted_literal() {
        assert_eq!(lex("\"hello\""), vec![
            word(vec![lit("hello")]),
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
                lit("hello "),
                var("NAME"),
                lit("!"),
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
            word(vec![lit("foo"), lit("bar")]),
        ]);
    }

    #[test]
    fn test_adjacent_bare_and_single() {
        // foo'bar' is ONE word token
        assert_eq!(lex("foo'bar'"), vec![
            word(vec![lit("foo"), lit("bar")]),
        ]);
    }

    #[test]
    fn test_adjacent_separated_are_two_words() {
        // 'foo' "bar" (with space) is TWO tokens
        assert_eq!(lex("'foo' \"bar\""), vec![
            word(vec![lit("foo")]),
            word(vec![lit("bar")]),
        ]);
    }
}
