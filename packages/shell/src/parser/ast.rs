/// Source position for error reporting.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Span {
    pub line: u32,
    pub col: u32,
}

/// A word that may contain literals, variable refs, and command substitutions.
#[derive(Debug, Clone, PartialEq)]
pub enum WordPart {
    Literal(String),
    /// Content from inside single or double quotes — not subject to brace or glob expansion.
    Quoted(String),
    /// `$VAR` or `$?` etc.
    Var(String),
    /// `${VAR}` or `${VAR:-default}` — raw inner string
    BraceVar(String),
    /// `$(cmd)` or `` `cmd` `` — raw inner string
    CmdSub(String),
    /// `$((expr))` — arithmetic substitution
    ArithSub(String),
    /// `<(cmd)` — input process substitution
    ProcSubIn(String),
    /// `>(cmd)` — output process substitution
    ProcSubOut(String),
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

/// A single command — either simple or compound.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Simple(SimpleCommand),
    If(IfCommand),
    While(WhileCommand),
    Until(WhileCommand),
    For(ForCommand),
    CFor(CForCommand),
    Case(CaseCommand),
    FunctionDef(FunctionDef),
    Group(List),
    Subshell(List),
    /// `arr=(a b c)` or `arr+=(x y)` — array assignment
    ArrayAssign(ArrayAssign),
    /// `(( expr ))` — arithmetic command
    Arithmetic(String),
}

/// Array assignment: `name=(elements)` or `name+=(elements)`.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrayAssign {
    pub name: String,
    pub append: bool,
    pub elements: Vec<Word>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IfCommand {
    pub condition: List,
    pub then_body: List,
    pub elifs: Vec<(List, List)>,
    pub else_body: Option<List>,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WhileCommand {
    pub condition: List,
    pub body: List,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ForCommand {
    pub var: String,
    pub words: Option<Vec<Word>>,
    pub body: List,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CForCommand {
    pub init: String,
    pub cond: String,
    pub step: String,
    pub body: List,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaseCommand {
    pub word: Word,
    pub arms: Vec<CaseArm>,
    pub redirects: Vec<Redirect>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CaseArm {
    pub patterns: Vec<Word>,
    pub body: List,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FunctionDef {
    pub name: String,
    pub body: Box<Command>,
}

/// A pipeline: one or more commands connected by `|`.
/// `negate` is true when the pipeline is prefixed with `!`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pipeline {
    pub commands: Vec<Command>,
    pub negate: bool,
}

/// A list of pipelines joined by `&&`, `||`, or `;`/newline.
#[derive(Debug, Clone, PartialEq)]
pub struct List {
    pub items: Vec<ListItem>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ListOp {
    And,        // &&
    Or,         // ||
    Seq,        // ; or newline
    Background, // &
}

#[derive(Debug, Clone, PartialEq)]
pub struct ListItem {
    pub pipeline: Pipeline,
    /// Operator that follows this item (None = last item)
    pub op: Option<ListOp>,
}
