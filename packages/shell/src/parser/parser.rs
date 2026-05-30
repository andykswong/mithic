use crate::parser::ast::*;
use crate::parser::lexer::{parse_heredoc_content, Lexer, Token};

pub struct ParseError {
    pub message: String,
    pub span: Span,
}

pub struct Parser {
    tokens: Vec<Token>,
    spans: Vec<Span>,
    pos: usize,
    errors: Vec<ParseError>,
    posix: bool,
}

impl Parser {
    pub fn new(input: &str) -> Self {
        Self::new_with_mode(input, false)
    }

    pub fn new_with_mode(input: &str, posix: bool) -> Self {
        let mut lexer = Lexer::new(input);
        let (tokens, spans) = lexer.tokenize_with_spans();
        Parser { tokens, spans, pos: 0, errors: Vec::new(), posix }
    }

    pub fn errors(&self) -> &[ParseError] {
        &self.errors
    }

    fn current_span(&self) -> Span {
        self.spans.get(self.pos).copied().unwrap_or_default()
    }

    fn push_error(&mut self, message: impl Into<String>) {
        let span = self.current_span();
        self.errors.push(ParseError { message: message.into(), span });
    }

    fn peek(&self) -> &Token {
        self.tokens.get(self.pos).unwrap_or(&Token::Eof)
    }

    fn advance(&mut self) -> Token {
        let tok = self.tokens.get(self.pos).cloned().unwrap_or(Token::Eof);
        if self.pos < self.tokens.len() { self.pos += 1; }
        tok
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Token::Newline) {
            self.advance();
        }
    }

    pub fn parse(&mut self) -> Option<List> {
        self.skip_newlines();
        if matches!(self.peek(), Token::Eof) {
            return None;
        }
        let list = self.parse_list();
        Some(list)
    }

    fn parse_list(&mut self) -> List {
        let mut items = Vec::new();
        loop {
            self.skip_newlines();
            if matches!(self.peek(), Token::Eof) { break; }

            let pipeline = self.parse_pipeline();
            let op = match self.peek() {
                Token::AmpAmp => { self.advance(); Some(ListOp::And) }
                Token::PipePipe => { self.advance(); Some(ListOp::Or) }
                Token::Semi => { self.advance(); Some(ListOp::Seq) }
                Token::Newline => { Some(ListOp::Seq) }
                Token::Amp => { self.advance(); Some(ListOp::Background) }
                _ => None,
            };
            let is_last = op.is_none();
            items.push(ListItem { pipeline, op });
            if is_last { break; }
        }
        List { items }
    }

    fn peek_keyword(&self) -> Option<&str> {
        match self.peek() {
            Token::Word(parts) if parts.len() == 1 => {
                if let WordPart::Literal(s) = &parts[0] {
                    Some(s.as_str())
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    fn at_keyword(&self, kw: &str) -> bool {
        self.peek_keyword() == Some(kw)
    }

    fn expect_keyword(&mut self, kw: &str) -> bool {
        if self.at_keyword(kw) {
            self.advance();
            true
        } else {
            let found = match self.peek() {
                Token::Eof => "end of input".to_string(),
                Token::Word(parts) if parts.len() == 1 => {
                    if let WordPart::Literal(s) = &parts[0] { format!("'{}'", s) }
                    else { "token".to_string() }
                }
                _ => "token".to_string(),
            };
            self.push_error(format!("expected '{}', got {}", kw, found));
            false
        }
    }

    fn skip_terminators(&mut self) {
        while matches!(self.peek(), Token::Semi | Token::Newline) {
            self.advance();
        }
    }

    fn parse_pipeline(&mut self) -> Pipeline {
        let negate = if let Token::Word(parts) = self.peek() {
            parts.len() == 1 && matches!(&parts[0], WordPart::Literal(s) if s == "!")
        } else {
            false
        };
        if negate { self.advance(); }

        let mut commands = Vec::new();
        commands.push(self.parse_command());
        while matches!(self.peek(), Token::Pipe) {
            self.advance();
            self.skip_newlines();
            commands.push(self.parse_command());
        }
        Pipeline { commands, negate }
    }

    fn parse_command(&mut self) -> Command {
        if matches!(self.peek(), Token::DoubleBracketOpen) {
            if self.posix {
                self.push_error("[[ ]] is not supported in POSIX mode");
                self.advance();
                return Command::Simple(SimpleCommand { words: vec![], redirects: vec![] });
            }
            return self.parse_double_bracket();
        }
        if let Token::ArithCommand(_) = self.peek().clone() {
            if self.posix {
                self.push_error("(( )) arithmetic command is not supported in POSIX mode");
                self.advance();
                return Command::Simple(SimpleCommand { words: vec![], redirects: vec![] });
            }
        }
        if let Token::ArithCommand(expr) = self.peek().clone() {
            self.advance();
            return Command::Arithmetic(expr);
        }
        if matches!(self.peek(), Token::LParen) {
            return Command::Subshell(self.parse_subshell());
        }
        match self.peek_keyword() {
            Some("if") => Command::If(self.parse_if()),
            Some("while") => Command::While(self.parse_while()),
            Some("until") => Command::Until(self.parse_until()),
            Some("for") => self.parse_for(),
            Some("select") if !self.posix => Command::Select(self.parse_select()),
            Some("select") => {
                self.push_error("select is not supported in POSIX mode");
                self.parse_maybe_function_def()
            }
            Some("case") => Command::Case(self.parse_case()),
            Some("{") => Command::Group(self.parse_group()),
            Some("coproc") if !self.posix => self.parse_coproc(),
            _ => self.parse_maybe_function_def(),
        }
    }

    fn parse_compound_list_until(&mut self, stop_keywords: &[&str]) -> List {
        let mut items = Vec::new();
        loop {
            self.skip_terminators();
            if matches!(self.peek(), Token::Eof) { break; }
            if let Some(kw) = self.peek_keyword() {
                if stop_keywords.contains(&kw) { break; }
            }

            let pipeline = self.parse_pipeline();
            let op = match self.peek() {
                Token::AmpAmp => { self.advance(); Some(ListOp::And) }
                Token::PipePipe => { self.advance(); Some(ListOp::Or) }
                Token::Semi => { self.advance(); Some(ListOp::Seq) }
                Token::Newline => { self.advance(); Some(ListOp::Seq) }
                Token::Amp => { self.advance(); Some(ListOp::Background) }
                _ => None,
            };
            let is_last = op.is_none();
            items.push(ListItem { pipeline, op });
            if is_last { break; }
        }
        List { items }
    }

    fn parse_if(&mut self) -> IfCommand {
        self.advance(); // consume "if"
        self.skip_newlines();
        let condition = self.parse_compound_list_until(&["then"]);
        self.expect_keyword("then");
        self.skip_terminators();
        let then_body = self.parse_compound_list_until(&["elif", "else", "fi"]);

        let mut elifs = Vec::new();
        while self.at_keyword("elif") {
            self.advance();
            self.skip_newlines();
            let elif_cond = self.parse_compound_list_until(&["then"]);
            self.expect_keyword("then");
            self.skip_terminators();
            let elif_body = self.parse_compound_list_until(&["elif", "else", "fi"]);
            elifs.push((elif_cond, elif_body));
        }

        let else_body = if self.at_keyword("else") {
            self.advance();
            self.skip_terminators();
            Some(self.parse_compound_list_until(&["fi"]))
        } else {
            None
        };

        self.expect_keyword("fi");
        let redirects = self.parse_redirects();
        IfCommand { condition, then_body, elifs, else_body, redirects }
    }

    fn parse_while(&mut self) -> WhileCommand {
        self.advance(); // consume "while"
        self.skip_newlines();
        let condition = self.parse_compound_list_until(&["do"]);
        self.expect_keyword("do");
        self.skip_terminators();
        let body = self.parse_compound_list_until(&["done"]);
        self.expect_keyword("done");
        let redirects = self.parse_redirects();
        WhileCommand { condition, body, redirects }
    }

    fn parse_until(&mut self) -> WhileCommand {
        self.advance(); // consume "until"
        self.skip_newlines();
        let condition = self.parse_compound_list_until(&["do"]);
        self.expect_keyword("do");
        self.skip_terminators();
        let body = self.parse_compound_list_until(&["done"]);
        self.expect_keyword("done");
        let redirects = self.parse_redirects();
        WhileCommand { condition, body, redirects }
    }

    fn parse_for(&mut self) -> Command {
        self.advance(); // consume "for"
        self.skip_newlines();

        // Check for C-style: for (( init; cond; step ))
        if let Token::ArithCommand(expr) = self.peek().clone() {
            self.advance(); // consume the ArithCommand token
            let parts: Vec<&str> = expr.splitn(3, ';').collect();
            let init = parts.get(0).unwrap_or(&"").trim().to_string();
            let cond = parts.get(1).unwrap_or(&"").trim().to_string();
            let step = parts.get(2).unwrap_or(&"").trim().to_string();

            self.skip_terminators();
            self.expect_keyword("do");
            self.skip_terminators();
            let body = self.parse_compound_list_until(&["done"]);
            self.expect_keyword("done");
            let redirects = self.parse_redirects();

            return Command::CFor(CForCommand { init, cond, step, body, redirects });
        }

        let var = match self.advance() {
            Token::Word(parts) if parts.len() == 1 => {
                if let WordPart::Literal(s) = &parts[0] { s.clone() } else { String::new() }
            }
            _ => String::new(),
        };

        self.skip_terminators();

        let words = if self.at_keyword("in") {
            self.advance();
            let mut words = Vec::new();
            loop {
                match self.peek() {
                    Token::Semi | Token::Newline | Token::Eof => break,
                    _ => {
                        if self.at_keyword("do") { break; }
                        if let Some(w) = self.parse_word() {
                            words.push(w);
                        } else {
                            break;
                        }
                    }
                }
            }
            Some(words)
        } else {
            None
        };

        self.skip_terminators();
        self.expect_keyword("do");
        self.skip_terminators();
        let body = self.parse_compound_list_until(&["done"]);
        self.expect_keyword("done");
        let redirects = self.parse_redirects();
        Command::For(ForCommand { var, words, body, redirects })
    }

    fn parse_select(&mut self) -> SelectCommand {
        self.advance(); // consume "select"
        self.skip_newlines();

        let var = match self.advance() {
            Token::Word(parts) if parts.len() == 1 => {
                if let WordPart::Literal(s) = &parts[0] { s.clone() } else { String::new() }
            }
            _ => String::new(),
        };

        self.skip_terminators();

        let words = if self.at_keyword("in") {
            self.advance();
            let mut words = Vec::new();
            loop {
                match self.peek() {
                    Token::Semi | Token::Newline | Token::Eof => break,
                    _ => {
                        if self.at_keyword("do") { break; }
                        if let Some(w) = self.parse_word() {
                            words.push(w);
                        } else {
                            break;
                        }
                    }
                }
            }
            words
        } else {
            Vec::new()
        };

        self.skip_terminators();
        self.expect_keyword("do");
        self.skip_terminators();
        let body = self.parse_compound_list_until(&["done"]);
        self.expect_keyword("done");
        let redirects = self.parse_redirects();
        SelectCommand { var, words, body, redirects }
    }

    fn parse_case(&mut self) -> CaseCommand {
        self.advance(); // consume "case"
        let word = self.parse_word_required();
        self.skip_terminators();
        self.expect_keyword("in");
        self.skip_terminators();

        let mut arms = Vec::new();
        loop {
            if self.at_keyword("esac") { break; }
            if matches!(self.peek(), Token::Eof) { break; }
            self.skip_terminators();
            if self.at_keyword("esac") { break; }

            // Optional leading (
            if matches!(self.peek(), Token::LParen) { self.advance(); }

            let mut patterns = Vec::new();
            loop {
                if let Some(w) = self.parse_word() {
                    patterns.push(w);
                }
                if matches!(self.peek(), Token::Pipe) {
                    self.advance();
                } else {
                    break;
                }
            }

            // Expect ) after patterns
            if matches!(self.peek(), Token::RParen) { self.advance(); }
            self.skip_terminators();

            // Parse body until ;; or esac
            let body = self.parse_case_body();
            arms.push(CaseArm { patterns, body });
        }

        self.expect_keyword("esac");
        let redirects = self.parse_redirects();
        CaseCommand { word, arms, redirects }
    }

    fn parse_case_body(&mut self) -> List {
        let mut items = Vec::new();
        loop {
            self.skip_terminators();
            if matches!(self.peek(), Token::Eof) { break; }
            if self.at_keyword("esac") { break; }
            // Check for ;; (double semi)
            if matches!(self.peek(), Token::Semi) && self.tokens.get(self.pos + 1) == Some(&Token::Semi) {
                self.advance();
                self.advance();
                break;
            }

            let pipeline = self.parse_pipeline();
            let op = match self.peek() {
                Token::AmpAmp => { self.advance(); Some(ListOp::And) }
                Token::PipePipe => { self.advance(); Some(ListOp::Or) }
                Token::Semi => {
                    // Check if next is also ;
                    if self.tokens.get(self.pos + 1) == Some(&Token::Semi) {
                        None // don't consume — let the loop detect ;;
                    } else {
                        self.advance();
                        Some(ListOp::Seq)
                    }
                }
                Token::Newline => { self.advance(); Some(ListOp::Seq) }
                _ => None,
            };
            let is_last = op.is_none();
            items.push(ListItem { pipeline, op });
            if is_last { break; }
        }
        List { items }
    }

    fn parse_group(&mut self) -> List {
        self.advance(); // consume "{"
        self.skip_terminators();
        let list = self.parse_compound_list_until(&["}"]);
        self.expect_keyword("}");
        list
    }

    fn parse_subshell(&mut self) -> List {
        self.advance(); // consume "("
        self.skip_terminators();
        let mut items = Vec::new();
        loop {
            self.skip_terminators();
            if matches!(self.peek(), Token::Eof | Token::RParen) { break; }
            let pipeline = self.parse_pipeline();
            let op = match self.peek() {
                Token::AmpAmp => { self.advance(); Some(ListOp::And) }
                Token::PipePipe => { self.advance(); Some(ListOp::Or) }
                Token::Semi => { self.advance(); Some(ListOp::Seq) }
                Token::Newline => { self.advance(); Some(ListOp::Seq) }
                _ => None,
            };
            let is_last = op.is_none();
            items.push(ListItem { pipeline, op });
            if is_last { break; }
        }
        if matches!(self.peek(), Token::RParen) { self.advance(); }
        List { items }
    }

    fn parse_coproc(&mut self) -> Command {
        self.advance(); // consume "coproc"
        // Collect remaining words on this line as the coproc command
        let mut words = vec![Word::literal("coproc")];
        loop {
            match self.peek() {
                Token::Semi | Token::Newline | Token::Eof | Token::Amp => break,
                Token::Pipe | Token::AmpAmp | Token::PipePipe => break,
                _ => {
                    if let Some(w) = self.parse_word() {
                        words.push(w);
                    } else {
                        break;
                    }
                }
            }
        }
        Command::Simple(SimpleCommand { words, redirects: vec![] })
    }

    fn parse_maybe_function_def(&mut self) -> Command {
        if let Token::Word(parts) = self.peek() {
            if parts.len() == 1 {
                if let WordPart::Literal(lit) = &parts[0] {
                    let lit = lit.clone();

                    // Detect array assignment: `name=(` or `name+=(`.
                    // The lexer emits Word("name=") or Word("name+=") followed by LParen.
                    let (arr_name, append) = if lit.ends_with("+=") {
                        (Some(lit[..lit.len() - 2].to_string()), true)
                    } else if lit.ends_with('=') {
                        (Some(lit[..lit.len() - 1].to_string()), false)
                    } else {
                        (None, false)
                    };

                    if let Some(name) = arr_name {
                        if self.tokens.get(self.pos + 1) == Some(&Token::LParen) {
                            self.advance(); // consume Word("name=") / Word("name+=")
                            self.advance(); // consume (
                            let mut elements = Vec::new();
                            loop {
                                self.skip_newlines();
                                if matches!(self.peek(), Token::RParen | Token::Eof) { break; }
                                if let Some(w) = self.parse_word() {
                                    elements.push(w);
                                } else {
                                    break;
                                }
                            }
                            if matches!(self.peek(), Token::RParen) { self.advance(); }
                            return Command::ArrayAssign(ArrayAssign { name, append, elements });
                        }
                    }

                    // Detect function definition: `name()`.
                    if self.tokens.get(self.pos + 1) == Some(&Token::LParen)
                        && self.tokens.get(self.pos + 2) == Some(&Token::RParen)
                    {
                        // Only treat as function def if the literal has no `=` (already handled above).
                        if !lit.contains('=') {
                            self.advance(); // consume name
                            self.advance(); // consume (
                            self.advance(); // consume )
                            self.skip_newlines();
                            let body = self.parse_command();
                            return Command::FunctionDef(FunctionDef {
                                name: lit,
                                body: Box::new(body),
                            });
                        }
                    }
                }
            }
        }
        Command::Simple(self.parse_simple_command())
    }

    fn parse_double_bracket(&mut self) -> Command {
        self.advance(); // consume [[
        let mut words = vec![Word::literal("[[")];
        loop {
            match self.peek() {
                Token::DoubleBracketClose => { self.advance(); break; }
                Token::Eof => break,
                Token::AmpAmp => { self.advance(); words.push(Word::literal("&&")); }
                Token::PipePipe => { self.advance(); words.push(Word::literal("||")); }
                _ => {
                    if let Some(w) = self.parse_word() {
                        // When the operator is =~, the RHS is a raw regex pattern.
                        // Collect all remaining tokens until ]] as a single literal word,
                        // because the lexer splits on ( and ) which are valid regex syntax.
                        let is_regex_op = w.0.len() == 1
                            && matches!(&w.0[0], WordPart::Literal(s) if s == "=~");
                        words.push(w);
                        if is_regex_op {
                            let pattern_word = self.collect_regex_pattern();
                            if !pattern_word.0.is_empty() {
                                words.push(pattern_word);
                            }
                            break;
                        }
                    } else {
                        self.advance();
                    }
                }
            }
        }
        Command::Simple(SimpleCommand { words, redirects: vec![] })
    }

    /// Collect all tokens until `]]` or EOF and reconstruct them as a Word for regex matching.
    /// Literal text parts are stored as `Quoted` to prevent glob expansion.
    /// Variable-reference parts (`Var`, `BraceVar`) are kept for expansion.
    fn collect_regex_pattern(&mut self) -> Word {
        let mut word_parts: Vec<WordPart> = Vec::new();
        // Accumulate non-Word tokens as a literal string
        let mut literal_buf = String::new();

        let flush_literal = |buf: &mut String, parts: &mut Vec<WordPart>| {
            if !buf.is_empty() {
                parts.push(WordPart::Quoted(std::mem::take(buf)));
            }
        };

        loop {
            match self.peek().clone() {
                Token::DoubleBracketClose => { self.advance(); break; }
                Token::Eof => break,
                Token::Word(parts) => {
                    self.advance();
                    for p in parts {
                        match p {
                            // Literals become Quoted to avoid glob expansion
                            WordPart::Literal(s) | WordPart::Quoted(s) => {
                                flush_literal(&mut literal_buf, &mut word_parts);
                                word_parts.push(WordPart::Quoted(s));
                            }
                            // Variable references are kept for expansion
                            other => {
                                flush_literal(&mut literal_buf, &mut word_parts);
                                word_parts.push(other);
                            }
                        }
                    }
                }
                tok => {
                    // Non-word tokens (LParen, RParen, etc.) become literal text
                    literal_buf.push_str(&token_to_text(&tok));
                    self.advance();
                }
            }
        }
        flush_literal(&mut literal_buf, &mut word_parts);
        Word(word_parts)
    }

    fn parse_simple_command(&mut self) -> SimpleCommand {
        let mut words = Vec::new();
        let mut redirects = Vec::new();

        loop {
            match self.peek() {
                Token::Eof
                | Token::Pipe
                | Token::AmpAmp
                | Token::PipePipe
                | Token::Semi
                | Token::Newline
                | Token::Amp => break,

                Token::Gt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Out(w));
                }
                Token::GtPipe => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::OutClobber(w));
                }
                Token::GtGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::OutAppend(w));
                }
                Token::Lt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::In(w));
                }
                Token::Fd2Gt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Err(w));
                }
                Token::Fd2GtGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::ErrAppend(w));
                }
                Token::Fd2GtAmp1 => {
                    self.advance();
                    redirects.push(Redirect::ErrToOut);
                }
                Token::AmpGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Both(w));
                }
                Token::HereString => {
                    if self.posix {
                        self.push_error("<<< here-string is not supported in POSIX mode");
                        self.advance();
                        self.parse_word();
                        break;
                    }
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::HereString(w));
                }
                Token::HereDoc(_, _) => {
                    if let Token::HereDoc(content, expand) = self.advance() {
                        let parts = if expand {
                            parse_heredoc_content(&content)
                        } else {
                            vec![WordPart::Quoted(content)]
                        };
                        redirects.push(Redirect::HereString(Word(parts)));
                    }
                }
                _ => {
                    if let Some(w) = self.parse_word() {
                        words.push(w);
                    } else {
                        break;
                    }
                }
            }
        }

        SimpleCommand { words, redirects }
    }

    /// Parse any trailing redirections (used after compound command closing keywords).
    fn parse_redirects(&mut self) -> Vec<Redirect> {
        let mut redirects = Vec::new();
        loop {
            match self.peek() {
                Token::Gt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Out(w));
                }
                Token::GtPipe => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::OutClobber(w));
                }
                Token::GtGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::OutAppend(w));
                }
                Token::Lt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::In(w));
                }
                Token::Fd2Gt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Err(w));
                }
                Token::Fd2GtGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::ErrAppend(w));
                }
                Token::Fd2GtAmp1 => {
                    self.advance();
                    redirects.push(Redirect::ErrToOut);
                }
                Token::AmpGt => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::Both(w));
                }
                Token::HereString => {
                    self.advance();
                    let w = self.parse_word_required();
                    redirects.push(Redirect::HereString(w));
                }
                Token::HereDoc(_, _) => {
                    if let Token::HereDoc(content, expand) = self.advance() {
                        let parts = if expand {
                            parse_heredoc_content(&content)
                        } else {
                            vec![WordPart::Quoted(content)]
                        };
                        redirects.push(Redirect::HereString(Word(parts)));
                    }
                }
                _ => break,
            }
        }
        redirects
    }

    fn parse_word_required(&mut self) -> Word {
        self.parse_word().unwrap_or_else(|| {
            self.push_error("expected word after redirect operator");
            Word::literal("")
        })
    }

    fn parse_word(&mut self) -> Option<Word> {
        match self.peek().clone() {
            Token::Word(parts) => { self.advance(); Some(Word(parts)) }
            _ => None,
        }
    }

    pub fn is_incomplete(&self) -> bool {
        let mut if_depth = 0i32;
        let mut while_depth = 0i32;
        let mut for_depth = 0i32;
        let mut case_depth = 0i32;
        let mut brace_depth = 0i32;
        let mut paren_depth = 0i32;

        for tok in &self.tokens {
            if let Token::Word(parts) = tok {
                if parts.len() == 1 {
                    if let WordPart::Literal(s) = &parts[0] {
                        match s.as_str() {
                            "if" => if_depth += 1,
                            "fi" => if_depth -= 1,
                            "while" | "until" => while_depth += 1,
                            "for" | "select" => for_depth += 1,
                            "done" => { while_depth -= 1; for_depth -= 1; }
                            "case" => case_depth += 1,
                            "esac" => case_depth -= 1,
                            "{" => brace_depth += 1,
                            "}" => brace_depth -= 1,
                            _ => {}
                        }
                    }
                }
            }
            if let Token::LParen = tok { paren_depth += 1; }
            if let Token::RParen = tok { paren_depth -= 1; }
        }

        if_depth > 0 || while_depth > 0 || for_depth > 0 ||
        case_depth > 0 || brace_depth > 0 || paren_depth > 0
    }
}

/// Convert a token back to its source text representation.
/// Used to reconstruct the raw regex pattern after `=~` in `[[ ]]`.
fn token_to_text(tok: &Token) -> String {
    match tok {
        Token::Word(parts) => {
            let mut s = String::new();
            for p in parts {
                match p {
                    WordPart::Literal(t) => s.push_str(t),
                    WordPart::Quoted(t) => s.push_str(t),
                    WordPart::Var(name) => { s.push('$'); s.push_str(name); }
                    WordPart::BraceVar(raw) => { s.push_str("${"); s.push_str(raw); s.push('}'); }
                    WordPart::CmdSub(raw) => { s.push_str("$("); s.push_str(raw); s.push(')'); }
                    WordPart::ArithSub(raw) => { s.push_str("$(("); s.push_str(raw); s.push_str("))"); }
                    WordPart::ProcSubIn(raw) => { s.push_str("<("); s.push_str(raw); s.push(')'); }
                    WordPart::ProcSubOut(raw) => { s.push_str(">("); s.push_str(raw); s.push(')'); }
                }
            }
            s
        }
        Token::LParen => "(".to_string(),
        Token::RParen => ")".to_string(),
        Token::Pipe => "|".to_string(),
        Token::Amp => "&".to_string(),
        Token::AmpAmp => "&&".to_string(),
        Token::PipePipe => "||".to_string(),
        Token::Semi => ";".to_string(),
        Token::Newline => "\n".to_string(),
        Token::Gt => ">".to_string(),
        Token::GtPipe => ">|".to_string(),
        Token::GtGt => ">>".to_string(),
        Token::Lt => "<".to_string(),
        Token::Fd2Gt => "2>".to_string(),
        Token::Fd2GtGt => "2>>".to_string(),
        Token::Fd2GtAmp1 => "2>&1".to_string(),
        Token::AmpGt => "&>".to_string(),
        Token::HereString => "<<<".to_string(),
        Token::HereDoc(content, _) => content.clone(),
        Token::ArithCommand(raw) => format!("(({raw}))"),
        Token::DoubleBracketOpen => "[[".to_string(),
        Token::DoubleBracketClose => "]]".to_string(),
        Token::Eof => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(input: &str) -> Option<List> {
        Parser::new(input).parse()
    }

    fn simple(words: &[&str]) -> Pipeline {
        Pipeline {
            negate: false,
            commands: vec![Command::Simple(SimpleCommand {
                words: words.iter().map(|s| Word::literal(*s)).collect(),
                redirects: vec![],
            })],
        }
    }

    #[test]
    fn test_empty() {
        assert!(parse("").is_none());
        assert!(parse("   \n  ").is_none());
    }

    #[test]
    fn test_simple_command() {
        let list = parse("echo hello").unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].pipeline, simple(&["echo", "hello"]));
    }

    #[test]
    fn test_pipeline() {
        let list = parse("echo hello | cat").unwrap();
        let pipeline = &list.items[0].pipeline;
        assert_eq!(pipeline.commands.len(), 2);
        match &pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words, vec![Word::literal("echo"), Word::literal("hello")]),
            _ => panic!("expected Simple command"),
        }
        match &pipeline.commands[1] {
            Command::Simple(cmd) => assert_eq!(cmd.words, vec![Word::literal("cat")]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_sequence() {
        let list = parse("echo a ; echo b").unwrap();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.items[0].op, Some(ListOp::Seq));
        assert_eq!(list.items[1].op, None);
    }

    #[test]
    fn test_and_or() {
        let list = parse("cmd1 && cmd2 || cmd3").unwrap();
        assert_eq!(list.items.len(), 3);
        assert_eq!(list.items[0].op, Some(ListOp::And));
        assert_eq!(list.items[1].op, Some(ListOp::Or));
        assert_eq!(list.items[2].op, None);
    }

    #[test]
    fn test_redirect_out() {
        let list = parse("echo hi > /tmp/f").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::Out(Word::literal("/tmp/f"))]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_redirect_in() {
        let list = parse("cat < file.txt").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::In(Word::literal("file.txt"))]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_redirect_append() {
        let list = parse("echo x >> log").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::OutAppend(Word::literal("log"))]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_redirect_stderr() {
        let list = parse("cmd 2>/dev/null").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::Err(Word::literal("/dev/null"))]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_redirect_err_to_out() {
        let list = parse("cmd 2>&1").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::ErrToOut]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_single_quoted() {
        let list = parse("echo 'hello world'").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![WordPart::Quoted("hello world".into())])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_double_quoted() {
        let list = parse("echo \"hello $NAME\"").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![
                WordPart::Quoted("hello ".into()),
                WordPart::Var("NAME".into()),
            ])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_negate_pipeline() {
        let list = parse("! false").unwrap();
        assert!(list.items[0].pipeline.negate);
    }

    #[test]
    fn test_var_in_word() {
        let list = parse("echo $HOME/bin").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![
                WordPart::Var("HOME".into()),
                WordPart::Literal("/bin".into()),
            ])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_brace_var() {
        let list = parse("echo ${FOO:-default}").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![
                WordPart::BraceVar("FOO:-default".into()),
            ])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_here_string() {
        let list = parse("cat <<< hello").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.redirects, vec![Redirect::HereString(Word::literal("hello"))]),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_cmd_sub_in_word() {
        let list = parse("echo $(whoami)").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![
                WordPart::CmdSub("whoami".into()),
            ])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_adjacent_quoting() {
        // echo 'foo'"bar"  →  single word with two quoted parts
        let list = parse("echo 'foo'\"bar\"").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => {
                assert_eq!(cmd.words.len(), 2);
                assert_eq!(cmd.words[1], Word(vec![
                    WordPart::Quoted("foo".into()),
                    WordPart::Quoted("bar".into()),
                ]));
            }
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_adjacent_bare_and_quoted() {
        // echo foo'bar'  →  single word with bare literal + quoted parts
        let list = parse("echo foo'bar'").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => {
                assert_eq!(cmd.words.len(), 2);
                assert_eq!(cmd.words[1], Word(vec![
                    WordPart::Literal("foo".into()),
                    WordPart::Quoted("bar".into()),
                ]));
            }
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_parse_if_simple() {
        let list = parse("if true; then echo yes; fi").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::If(ic) => {
                assert_eq!(ic.condition.items.len(), 1);
                assert_eq!(ic.then_body.items.len(), 1);
                assert!(ic.elifs.is_empty());
                assert!(ic.else_body.is_none());
            }
            _ => panic!("expected If command"),
        }
    }

    #[test]
    fn test_parse_if_else() {
        let list = parse("if false; then echo no; else echo yes; fi").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::If(ic) => {
                assert!(ic.else_body.is_some());
            }
            _ => panic!("expected If command"),
        }
    }

    #[test]
    fn test_parse_if_elif() {
        let list = parse("if a; then b; elif c; then d; else e; fi").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::If(ic) => {
                assert_eq!(ic.elifs.len(), 1);
                assert!(ic.else_body.is_some());
            }
            _ => panic!("expected If command"),
        }
    }

    #[test]
    fn test_parse_while() {
        let list = parse("while true; do echo loop; done").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::While(wc) => {
                assert_eq!(wc.condition.items.len(), 1);
                assert_eq!(wc.body.items.len(), 1);
            }
            _ => panic!("expected While command"),
        }
    }

    #[test]
    fn test_parse_until() {
        let list = parse("until false; do echo x; done").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Until(_) => {}
            _ => panic!("expected Until command"),
        }
    }

    #[test]
    fn test_parse_for() {
        let list = parse("for i in a b c; do echo $i; done").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::For(fc) => {
                assert_eq!(fc.var, "i");
                assert_eq!(fc.words.as_ref().unwrap().len(), 3);
                assert_eq!(fc.body.items.len(), 1);
            }
            _ => panic!("expected For command"),
        }
    }

    #[test]
    fn test_parse_case() {
        let list = parse("case $x in a) echo a;; b) echo b;; esac").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Case(cc) => {
                assert_eq!(cc.arms.len(), 2);
                assert_eq!(cc.arms[0].patterns.len(), 1);
            }
            _ => panic!("expected Case command"),
        }
    }

    #[test]
    fn test_parse_case_multiple_patterns() {
        let list = parse("case $x in a|b) echo ab;; esac").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Case(cc) => {
                assert_eq!(cc.arms[0].patterns.len(), 2);
            }
            _ => panic!("expected Case command"),
        }
    }

    #[test]
    fn test_parse_group() {
        let list = parse("{ echo a; echo b; }").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Group(g) => {
                assert_eq!(g.items.len(), 2);
            }
            _ => panic!("expected Group command"),
        }
    }

    #[test]
    fn test_parse_function_def() {
        let list = parse("greet() { echo hello; }").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::FunctionDef(fd) => {
                assert_eq!(fd.name, "greet");
                match fd.body.as_ref() {
                    Command::Group(g) => assert_eq!(g.items.len(), 1),
                    _ => panic!("expected Group body"),
                }
            }
            _ => panic!("expected FunctionDef"),
        }
    }

    #[test]
    fn test_parse_subshell() {
        let list = parse("(echo hello)").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Subshell(s) => {
                assert_eq!(s.items.len(), 1);
            }
            _ => panic!("expected Subshell"),
        }
    }

    #[test]
    fn test_parse_double_bracket() {
        let list = parse("[[ $x == hello ]]").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(sc) => {
                assert_eq!(sc.words[0], Word::literal("[["));
            }
            _ => panic!("expected Simple command for [["),
        }
    }

    #[test]
    fn test_incomplete_if() {
        let mut p = Parser::new("if true; then");
        p.parse();
        assert!(p.is_incomplete());
    }

    #[test]
    fn test_complete_if() {
        let mut p = Parser::new("if true; then echo x; fi");
        p.parse();
        assert!(!p.is_incomplete());
    }

    #[test]
    fn test_incomplete_for() {
        let mut p = Parser::new("for i in a b c; do");
        p.parse();
        assert!(p.is_incomplete());
    }

    #[test]
    fn test_incomplete_brace() {
        let mut p = Parser::new("{ echo a;");
        p.parse();
        assert!(p.is_incomplete());
    }

    #[test]
    fn test_complete_brace() {
        let mut p = Parser::new("{ echo a; }");
        p.parse();
        assert!(!p.is_incomplete());
    }

    #[test]
    fn test_background_operator() {
        let mut p = Parser::new("sleep 10 &");
        let list = p.parse().unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].op, Some(ListOp::Background));
        let cmd = match &list.items[0].pipeline.commands[0] {
            Command::Simple(sc) => sc,
            _ => panic!("expected simple command"),
        };
        assert_eq!(cmd.words.len(), 2);
    }

    #[test]
    fn test_background_in_list() {
        let mut p = Parser::new("cmd1 & cmd2");
        let list = p.parse().unwrap();
        assert_eq!(list.items.len(), 2);
        assert_eq!(list.items[0].op, Some(ListOp::Background));
        assert_eq!(list.items[1].op, None);
    }

    #[test]
    fn test_background_pipeline() {
        let mut p = Parser::new("cmd1 | cmd2 &");
        let list = p.parse().unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].op, Some(ListOp::Background));
        assert_eq!(list.items[0].pipeline.commands.len(), 2);
    }
}
