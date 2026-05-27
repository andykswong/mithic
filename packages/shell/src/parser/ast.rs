/// A word that may contain literals, variable refs, and command substitutions.
#[derive(Debug, Clone, PartialEq)]
pub enum WordPart {
    Literal(String),
    /// `$VAR` or `$?` etc.
    Var(String),
    /// `${VAR}` or `${VAR:-default}` — raw inner string
    BraceVar(String),
    /// `$(cmd)` or `` `cmd` `` — raw inner string
    CmdSub(String),
}

/// A word passed as an argument. The lexer merges adjacent quoting styles
/// into a single flat list of parts (e.g. `'foo'"$BAR"baz` → one Word).
#[derive(Debug, Clone, PartialEq)]
pub struct Word(pub Vec<WordPart>);

impl Word {
    pub fn literal(s: impl Into<String>) -> Self {
        Word(vec![WordPart::Literal(s.into())])
    }

    pub fn parts(&self) -> &[WordPart] {
        &self.0
    }
}

/// A file redirection.
#[derive(Debug, Clone, PartialEq)]
pub enum Redirect {
    /// `> file`
    Out(Word),
    /// `>> file`
    OutAppend(Word),
    /// `< file`
    In(Word),
    /// `2> file`
    Err(Word),
    /// `2>> file`
    ErrAppend(Word),
    /// `2>&1`
    ErrToOut,
    /// `&> file`
    Both(Word),
    /// `<<< word`
    HereString(Word),
}

/// A single simple command: name + args + redirections.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleCommand {
    pub words: Vec<Word>,
    pub redirects: Vec<Redirect>,
}

/// A pipeline: one or more commands connected by `|`.
/// `negate` is true when the pipeline is prefixed with `!`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pipeline {
    pub commands: Vec<SimpleCommand>,
    pub negate: bool,
}

/// A list of pipelines joined by `&&`, `||`, or `;`/newline.
#[derive(Debug, Clone, PartialEq)]
pub struct List {
    pub items: Vec<ListItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ListOp {
    And,  // &&
    Or,   // ||
    Seq,  // ; or newline
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    pub pipeline: Pipeline,
    /// Operator that follows this item (None = last item)
    pub op: Option<ListOp>,
}
