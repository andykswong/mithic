use crate::parser::ast::*;
use crate::parser::lexer::{Lexer, Token};

pub struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    pub fn new(input: &str) -> Self {
        let mut lexer = Lexer::new(input);
        let tokens = lexer.tokenize();
        Parser { tokens, pos: 0 }
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
                _ => None,
            };
            let is_last = op.is_none();
            items.push(ListItem { pipeline, op });
            if is_last { break; }
        }
        List { items }
    }

    fn parse_pipeline(&mut self) -> Pipeline {
        let negate = if let Token::Word(parts) = self.peek() {
            parts.len() == 1 && matches!(&parts[0], WordPart::Literal(s) if s == "!")
        } else {
            false
        };
        if negate { self.advance(); }

        let mut commands = Vec::new();
        commands.push(Command::Simple(self.parse_simple_command()));
        while matches!(self.peek(), Token::Pipe) {
            self.advance();
            self.skip_newlines();
            commands.push(Command::Simple(self.parse_simple_command()));
        }
        Pipeline { commands, negate }
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

    fn parse_word_required(&mut self) -> Word {
        self.parse_word().unwrap_or_else(|| Word::literal(""))
    }

    fn parse_word(&mut self) -> Option<Word> {
        match self.peek().clone() {
            Token::Word(parts) => { self.advance(); Some(Word(parts)) }
            _ => None,
        }
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
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![WordPart::Literal("hello world".into())])),
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_double_quoted() {
        let list = parse("echo \"hello $NAME\"").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => assert_eq!(cmd.words[1], Word(vec![
                WordPart::Literal("hello ".into()),
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
        // echo 'foo'"bar"  →  single word with two literal parts
        let list = parse("echo 'foo'\"bar\"").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => {
                assert_eq!(cmd.words.len(), 2);
                assert_eq!(cmd.words[1], Word(vec![
                    WordPart::Literal("foo".into()),
                    WordPart::Literal("bar".into()),
                ]));
            }
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn test_adjacent_bare_and_quoted() {
        // echo foo'bar'  →  single word "foobar"
        let list = parse("echo foo'bar'").unwrap();
        match &list.items[0].pipeline.commands[0] {
            Command::Simple(cmd) => {
                assert_eq!(cmd.words.len(), 2);
                assert_eq!(cmd.words[1], Word(vec![
                    WordPart::Literal("foo".into()),
                    WordPart::Literal("bar".into()),
                ]));
            }
            _ => panic!("expected Simple command"),
        }
    }
}
