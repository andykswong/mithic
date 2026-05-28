/// NFA-based regex engine supporting bash =~ operator semantics.
///
/// Supported syntax:
///   Literals, `.`, `*`, `+`, `?`, `^`, `$`, `|`, `(...)`, `[...]`, `[^...]`, `\`

// ── AST ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum Node {
    Literal(char),
    AnyChar,
    Anchor(Anchor),
    CharClass { negated: bool, ranges: Vec<CharRange> },
    Concat(Vec<Node>),
    Alt(Box<Node>, Box<Node>),
    Repeat { node: Box<Node>, min: usize, max: Option<usize> },
    Capture { index: usize, node: Box<Node> },
}

#[derive(Debug, Clone)]
enum Anchor { Start, End }

#[derive(Debug, Clone)]
enum CharRange { Single(char), Range(char, char) }

// ── Parser ───────────────────────────────────────────────────────────────────

struct Parser {
    chars: Vec<char>,
    pos: usize,
    capture_index: usize,
}

impl Parser {
    fn new(pattern: &str) -> Self {
        Parser { chars: pattern.chars().collect(), pos: 0, capture_index: 0 }
    }

    fn peek(&self) -> Option<char> { self.chars.get(self.pos).copied() }

    fn consume(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if c.is_some() { self.pos += 1; }
        c
    }

    fn parse(&mut self) -> Node {
        self.parse_alt()
    }

    fn parse_alt(&mut self) -> Node {
        let left = self.parse_concat();
        if self.peek() == Some('|') {
            self.consume();
            let right = self.parse_alt();
            Node::Alt(Box::new(left), Box::new(right))
        } else {
            left
        }
    }

    fn parse_concat(&mut self) -> Node {
        let mut nodes = Vec::new();
        while let Some(c) = self.peek() {
            if c == ')' || c == '|' { break; }
            nodes.push(self.parse_quantifier());
        }
        if nodes.len() == 1 { nodes.remove(0) } else { Node::Concat(nodes) }
    }

    fn parse_quantifier(&mut self) -> Node {
        let base = self.parse_atom();
        match self.peek() {
            Some('*') => { self.consume(); Node::Repeat { node: Box::new(base), min: 0, max: None } }
            Some('+') => { self.consume(); Node::Repeat { node: Box::new(base), min: 1, max: None } }
            Some('?') => { self.consume(); Node::Repeat { node: Box::new(base), min: 0, max: Some(1) } }
            _ => base,
        }
    }

    fn parse_atom(&mut self) -> Node {
        match self.peek() {
            Some('(') => {
                self.consume();
                let idx = self.capture_index;
                self.capture_index += 1;
                let inner = self.parse_alt();
                if self.peek() == Some(')') { self.consume(); }
                Node::Capture { index: idx, node: Box::new(inner) }
            }
            Some('[') => self.parse_char_class(),
            Some('^') => { self.consume(); Node::Anchor(Anchor::Start) }
            Some('$') => { self.consume(); Node::Anchor(Anchor::End) }
            Some('\\') => {
                self.consume();
                let c = self.consume().unwrap_or('\\');
                Node::Literal(c)
            }
            Some('.') => { self.consume(); Node::AnyChar }
            Some(c) => { self.consume(); Node::Literal(c) }
            None => Node::Concat(vec![]),
        }
    }

    fn parse_char_class(&mut self) -> Node {
        self.consume(); // '['
        let negated = if self.peek() == Some('^') { self.consume(); true } else { false };
        let mut ranges = Vec::new();

        // ']' as first char inside class is treated as literal
        if self.peek() == Some(']') {
            ranges.push(CharRange::Single(']'));
            self.consume();
        }

        while let Some(c) = self.peek() {
            if c == ']' { self.consume(); break; }
            let ch = if c == '\\' {
                self.consume();
                self.consume().unwrap_or('\\')
            } else {
                self.consume();
                c
            };
            if self.peek() == Some('-') {
                let after_dash = self.chars.get(self.pos + 1).copied();
                if after_dash.is_some() && after_dash != Some(']') {
                    self.consume(); // '-'
                    let end = if self.peek() == Some('\\') {
                        self.consume();
                        self.consume().unwrap_or('\\')
                    } else {
                        self.consume().unwrap_or(ch)
                    };
                    ranges.push(CharRange::Range(ch, end));
                    continue;
                }
            }
            ranges.push(CharRange::Single(ch));
        }

        Node::CharClass { negated, ranges }
    }
}

// ── NFA ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
enum TransitionKind {
    Literal(char),
    AnyChar,
    CharClass { negated: bool, ranges: Vec<CharRange> },
    AnchorStart,
    AnchorEnd,
    Epsilon,
    CaptureOpen(usize),   // marks start of capture group N
    CaptureClose(usize),  // marks end of capture group N
}

#[derive(Debug, Clone)]
struct State {
    transitions: Vec<(TransitionKind, usize)>,
    is_match: bool,
}

struct Nfa {
    states: Vec<State>,
    start: usize,
}

impl Nfa {
    fn new_state(states: &mut Vec<State>) -> usize {
        let id = states.len();
        states.push(State { transitions: vec![], is_match: false });
        id
    }

    fn build(node: &Node) -> Self {
        let mut states = Vec::new();
        let start = Self::new_state(&mut states);
        let accept = Self::new_state(&mut states);
        states[accept].is_match = true;
        Self::compile(node, start, accept, &mut states);
        Nfa { states, start }
    }

    fn compile(node: &Node, from: usize, to: usize, states: &mut Vec<State>) {
        match node {
            Node::Literal(c) => {
                states[from].transitions.push((TransitionKind::Literal(*c), to));
            }
            Node::AnyChar => {
                states[from].transitions.push((TransitionKind::AnyChar, to));
            }
            Node::Anchor(Anchor::Start) => {
                states[from].transitions.push((TransitionKind::AnchorStart, to));
            }
            Node::Anchor(Anchor::End) => {
                states[from].transitions.push((TransitionKind::AnchorEnd, to));
            }
            Node::CharClass { negated, ranges } => {
                states[from].transitions.push((
                    TransitionKind::CharClass { negated: *negated, ranges: ranges.clone() },
                    to,
                ));
            }
            Node::Capture { index, node } => {
                let open = Self::new_state(states);
                let close = Self::new_state(states);
                states[from].transitions.push((TransitionKind::CaptureOpen(*index), open));
                Self::compile(node, open, close, states);
                states[close].transitions.push((TransitionKind::CaptureClose(*index), to));
            }
            Node::Concat(nodes) => {
                if nodes.is_empty() {
                    states[from].transitions.push((TransitionKind::Epsilon, to));
                    return;
                }
                let mut prev = from;
                for (i, n) in nodes.iter().enumerate() {
                    let next = if i == nodes.len() - 1 {
                        to
                    } else {
                        Self::new_state(states)
                    };
                    Self::compile(n, prev, next, states);
                    prev = next;
                }
            }
            Node::Alt(left, right) => {
                let ls = Self::new_state(states);
                let la = Self::new_state(states);
                let rs = Self::new_state(states);
                let ra = Self::new_state(states);
                states[from].transitions.push((TransitionKind::Epsilon, ls));
                states[from].transitions.push((TransitionKind::Epsilon, rs));
                states[la].transitions.push((TransitionKind::Epsilon, to));
                states[ra].transitions.push((TransitionKind::Epsilon, to));
                Self::compile(left, ls, la, states);
                Self::compile(right, rs, ra, states);
            }
            Node::Repeat { node, min, max } => {
                Self::compile_repeat(node, from, to, *min, *max, states);
            }
        }
    }

    fn compile_repeat(
        node: &Node,
        from: usize,
        to: usize,
        min: usize,
        max: Option<usize>,
        states: &mut Vec<State>,
    ) {
        match (min, max) {
            (0, None) => {
                // Kleene star: from --eps--> to  (skip)
                //              from --eps--> loop_start
                //              loop_start --node--> loop_end
                //              loop_end --eps--> loop_start (repeat)
                //              loop_end --eps--> to (exit)
                let loop_start = Self::new_state(states);
                let loop_end = Self::new_state(states);
                states[from].transitions.push((TransitionKind::Epsilon, to));
                states[from].transitions.push((TransitionKind::Epsilon, loop_start));
                Self::compile(node, loop_start, loop_end, states);
                states[loop_end].transitions.push((TransitionKind::Epsilon, loop_start));
                states[loop_end].transitions.push((TransitionKind::Epsilon, to));
            }
            (1, None) => {
                // One or more: same as *, but require at least one
                let loop_start = Self::new_state(states);
                let loop_end = Self::new_state(states);
                // First mandatory occurrence
                states[from].transitions.push((TransitionKind::Epsilon, loop_start));
                Self::compile(node, loop_start, loop_end, states);
                // Then optionally repeat
                states[loop_end].transitions.push((TransitionKind::Epsilon, loop_start));
                states[loop_end].transitions.push((TransitionKind::Epsilon, to));
            }
            (0, Some(1)) => {
                // Optional: skip or consume once
                states[from].transitions.push((TransitionKind::Epsilon, to));
                Self::compile(node, from, to, states);
            }
            (min, max) => {
                // General case: chain min mandatory, then optional up to max
                let mut prev = from;
                for i in 0..min {
                    let next = if i == min - 1 && max == Some(min) {
                        to
                    } else {
                        Self::new_state(states)
                    };
                    Self::compile(node, prev, next, states);
                    prev = next;
                }
                // If min == 0, prev == from and we haven't advanced yet
                match max {
                    None => {
                        // After mandatory reps, loop optional star
                        // prev --eps--> to
                        // loop
                        let loop_start = Self::new_state(states);
                        let loop_end = Self::new_state(states);
                        states[prev].transitions.push((TransitionKind::Epsilon, to));
                        states[prev].transitions.push((TransitionKind::Epsilon, loop_start));
                        Self::compile(node, loop_start, loop_end, states);
                        states[loop_end].transitions.push((TransitionKind::Epsilon, loop_start));
                        states[loop_end].transitions.push((TransitionKind::Epsilon, to));
                    }
                    Some(m) => {
                        let remaining = m - min;
                        // Chain optional repetitions
                        let mut cur = prev;
                        for i in 0..remaining {
                            // Can skip to `to` from cur
                            states[cur].transitions.push((TransitionKind::Epsilon, to));
                            let next = if i == remaining - 1 {
                                to
                            } else {
                                Self::new_state(states)
                            };
                            if next != to {
                                let inner = Self::new_state(states);
                                Self::compile(node, cur, inner, states);
                                states[inner].transitions.push((TransitionKind::Epsilon, next));
                                cur = next;
                            } else {
                                Self::compile(node, cur, to, states);
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── Simulation ───────────────────────────────────────────────────────────────

/// Per-thread state during NFA simulation.
/// captures[i] = (start_byte, end_byte) of capture group i, or usize::MAX if not yet set.
#[derive(Clone)]
struct Thread {
    state: usize,
    cap_starts: Vec<usize>,  // usize::MAX = unset
    cap_ends: Vec<usize>,    // usize::MAX = unset
}

impl Thread {
    fn new(state: usize, num_captures: usize) -> Self {
        Thread {
            state,
            cap_starts: vec![usize::MAX; num_captures],
            cap_ends: vec![usize::MAX; num_captures],
        }
    }
}

fn char_class_matches(c: char, negated: bool, ranges: &[CharRange]) -> bool {
    let in_class = ranges.iter().any(|r| match r {
        CharRange::Single(sc) => *sc == c,
        CharRange::Range(lo, hi) => *lo <= c && c <= *hi,
    });
    if negated { !in_class } else { in_class }
}

/// Follow all zero-width transitions (epsilon, anchors, capture markers) from a set of threads.
/// Returns new set of threads at consuming states (no more epsilon/anchor transitions to follow).
fn epsilon_closure(
    states: &[State],
    init: Vec<Thread>,
    text_len: usize,
    pos: usize,
    num_captures: usize,
) -> Vec<Thread> {
    // We process threads greedily and deduplicate by (state_id) to avoid exponential blowup.
    // But since capture groups matter for final output, we keep the first thread reaching each state.
    let mut seen: Vec<bool> = vec![false; states.len()];
    let mut stack = Vec::new();
    let mut result = Vec::new();

    for t in init {
        if !seen[t.state] {
            seen[t.state] = true;
            stack.push(t);
        }
    }

    while let Some(thread) = stack.pop() {
        let state = &states[thread.state];
        let mut any_zero_width = false;

        for (kind, next) in &state.transitions {
            match kind {
                TransitionKind::Epsilon => {
                    any_zero_width = true;
                    if !seen[*next] {
                        seen[*next] = true;
                        stack.push(Thread { state: *next, ..thread.clone() });
                    }
                }
                TransitionKind::AnchorStart => {
                    if pos == 0 {
                        any_zero_width = true;
                        if !seen[*next] {
                            seen[*next] = true;
                            stack.push(Thread { state: *next, ..thread.clone() });
                        }
                    }
                }
                TransitionKind::AnchorEnd => {
                    if pos == text_len {
                        any_zero_width = true;
                        if !seen[*next] {
                            seen[*next] = true;
                            stack.push(Thread { state: *next, ..thread.clone() });
                        }
                    }
                }
                TransitionKind::CaptureOpen(idx) => {
                    any_zero_width = true;
                    if !seen[*next] {
                        seen[*next] = true;
                        let mut t2 = thread.clone();
                        t2.state = *next;
                        if *idx < num_captures {
                            t2.cap_starts[*idx] = pos;
                            t2.cap_ends[*idx] = usize::MAX; // reset end
                        }
                        stack.push(t2);
                    }
                }
                TransitionKind::CaptureClose(idx) => {
                    any_zero_width = true;
                    if !seen[*next] {
                        seen[*next] = true;
                        let mut t2 = thread.clone();
                        t2.state = *next;
                        if *idx < num_captures {
                            t2.cap_ends[*idx] = pos;
                        }
                        stack.push(t2);
                    }
                }
                _ => {}
            }
        }

        // This thread is at a state that has character transitions (or is an accept state with no more epsilon to follow)
        let _ = any_zero_width;
        result.push(thread);
    }

    result
}

fn simulate(nfa: &Nfa, text: &str, num_captures: usize) -> Option<Thread> {
    let chars: Vec<char> = text.chars().collect();
    // Byte offsets: char_byte_offsets[i] = byte offset of chars[i]; last entry = text.len()
    let mut char_byte_offsets = Vec::with_capacity(chars.len() + 1);
    {
        let mut off = 0usize;
        for c in &chars {
            char_byte_offsets.push(off);
            off += c.len_utf8();
        }
        char_byte_offsets.push(off);
    }
    let text_len = text.len();

    // Try match starting at each character position (substring semantics, leftmost-first).
    for start_char in 0..=chars.len() {
        let start_byte = char_byte_offsets[start_char];

        let init = vec![Thread::new(nfa.start, num_captures)];
        let mut current = epsilon_closure(&nfa.states, init, text_len, start_byte, num_captures);

        // Track the last accept seen — gives us the greedy (longest) match at this start position.
        let mut last_accept: Option<Thread> = find_accept(nfa, &current);

        let mut pos_char = start_char;

        while pos_char < chars.len() {
            let c = chars[pos_char];
            let next_byte = char_byte_offsets[pos_char + 1];
            let mut next_threads = Vec::new();

            for thread in &current {
                let state = &nfa.states[thread.state];
                for (kind, next) in &state.transitions {
                    let matches = match kind {
                        TransitionKind::Literal(lc) => *lc == c,
                        TransitionKind::AnyChar => c != '\n',
                        TransitionKind::CharClass { negated, ranges } => {
                            char_class_matches(c, *negated, ranges)
                        }
                        _ => false,
                    };
                    if matches {
                        next_threads.push(Thread { state: *next, ..thread.clone() });
                    }
                }
            }

            pos_char += 1;

            current = epsilon_closure(&nfa.states, next_threads, text_len, next_byte, num_captures);

            if let Some(t) = find_accept(nfa, &current) {
                last_accept = Some(t);
            }

            if current.is_empty() { break; }
        }

        if let Some(t) = last_accept {
            return Some(t);
        }
    }

    None
}

fn find_accept(nfa: &Nfa, threads: &[Thread]) -> Option<Thread> {
    threads.iter().find(|t| nfa.states[t.state].is_match).cloned()
}

// ── Public API ───────────────────────────────────────────────────────────────

pub(crate) struct RegexMatch {
    pub matched: bool,
    pub groups: Vec<String>,
}

pub(crate) fn regex_match(text: &str, pattern: &str) -> RegexMatch {
    // Wrap the pattern in a capture group to track full match bounds as group 0.
    let wrapped = format!("({})", pattern);
    let mut parser = Parser::new(&wrapped);
    let ast = parser.parse();
    let num_captures = parser.capture_index;

    let nfa = Nfa::build(&ast);

    match simulate(&nfa, text, num_captures) {
        None => RegexMatch { matched: false, groups: vec![] },
        Some(thread) => {
            let mut groups = Vec::new();
            // Group 0 is the full match (the wrapper we added)
            let full_match = if thread.cap_starts[0] != usize::MAX && thread.cap_ends[0] != usize::MAX {
                text[thread.cap_starts[0]..thread.cap_ends[0]].to_string()
            } else {
                String::new()
            };
            groups.push(full_match);
            // User's capture groups are 1..num_captures
            for i in 1..num_captures {
                let s = thread.cap_starts[i];
                let e = thread.cap_ends[i];
                if s != usize::MAX && e != usize::MAX && s <= e {
                    groups.push(text[s..e].to_string());
                } else {
                    groups.push(String::new());
                }
            }
            RegexMatch { matched: true, groups }
        }
    }
}

// ── Unit Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn m(text: &str, pat: &str) -> bool {
        regex_match(text, pat).matched
    }

    fn groups(text: &str, pat: &str) -> Vec<String> {
        regex_match(text, pat).groups
    }

    // ── Basic matching ──

    #[test]
    fn literal_match() {
        assert!(m("hello", "hello"));
        assert!(!m("world", "hello"));
    }

    #[test]
    fn substring_match() {
        assert!(m("say hello world", "hello"));
        assert!(!m("world", "hello"));
    }

    #[test]
    fn dot_matches_any() {
        assert!(m("abc", "a.c"));
        assert!(m("aXc", "a.c"));
        assert!(!m("ac", "a.c"));
    }

    #[test]
    fn star_zero_or_more() {
        assert!(m("ac", "ab*c"));
        assert!(m("abc", "ab*c"));
        assert!(m("abbc", "ab*c"));
        assert!(!m("axc", "ab*c"));
    }

    #[test]
    fn plus_one_or_more() {
        assert!(!m("ac", "ab+c"));
        assert!(m("abc", "ab+c"));
        assert!(m("abbc", "ab+c"));
    }

    #[test]
    fn question_zero_or_one() {
        assert!(m("ac", "ab?c"));
        assert!(m("abc", "ab?c"));
        assert!(!m("abbc", "ab?c"));
    }

    // ── Anchors ──

    #[test]
    fn anchor_start() {
        assert!(m("hello world", "^hello"));
        assert!(!m("say hello", "^hello"));
    }

    #[test]
    fn anchor_end() {
        assert!(m("say hello", "hello$"));
        assert!(!m("hello world", "hello$"));
    }

    #[test]
    fn anchor_both() {
        assert!(m("hello", "^hello$"));
        assert!(!m("hello world", "^hello$"));
        assert!(!m("say hello", "^hello$"));
    }

    // ── Character classes ──

    #[test]
    fn char_class_basic() {
        assert!(m("cat", "[abc]at"));
        assert!(m("bat", "[abc]at"));
        assert!(!m("dat", "[abc]at"));
    }

    #[test]
    fn char_class_range() {
        assert!(m("a1", "[a-z][0-9]"));
        assert!(!m("A1", "[a-z][0-9]"));
        assert!(!m("aa", "[a-z][0-9]"));
    }

    #[test]
    fn char_class_negated() {
        assert!(!m("abc", "[^abc]"));
        assert!(m("xyz", "[^abc]"));
    }

    // ── Alternation ──

    #[test]
    fn alternation_basic() {
        assert!(m("cat", "cat|dog"));
        assert!(m("dog", "cat|dog"));
        assert!(!m("fish", "cat|dog"));
    }

    #[test]
    fn alternation_in_anchor() {
        assert!(m("hello123", "^hello([0-9]+)$"));
    }

    // ── Grouping and captures ──

    #[test]
    fn capture_basic() {
        let g = groups("hello123", "^hello([0-9]+)$");
        assert_eq!(g.get(0).map(String::as_str), Some("hello123"));
        assert_eq!(g.get(1).map(String::as_str), Some("123"));
    }

    #[test]
    fn capture_multiple() {
        let g = groups("2024-01-15", "([0-9]+)-([0-9]+)-([0-9]+)");
        assert_eq!(g.get(0).map(String::as_str), Some("2024-01-15"));
        assert_eq!(g.get(1).map(String::as_str), Some("2024"));
        assert_eq!(g.get(2).map(String::as_str), Some("01"));
        assert_eq!(g.get(3).map(String::as_str), Some("15"));
    }

    #[test]
    fn no_match_returns_empty_groups() {
        let result = regex_match("hello", "^world");
        assert!(!result.matched);
        assert!(result.groups.is_empty());
    }

    // ── Escape ──

    #[test]
    fn escaped_dot() {
        assert!(m("a.b", r"a\.b"));
        assert!(!m("axb", r"a\.b"));
    }

    #[test]
    fn escaped_star() {
        assert!(m("a*b", r"a\*b"));
        assert!(!m("ab", r"a\*b"));
    }

    // ── Complex patterns ──

    #[test]
    fn email_like() {
        assert!(m("user@example.com", r"[a-zA-Z0-9]+@[a-zA-Z0-9]+\.[a-zA-Z]+"));
    }

    #[test]
    fn digits_only() {
        assert!(m("12345", "^[0-9]+$"));
        assert!(!m("123a5", "^[0-9]+$"));
    }

    #[test]
    fn optional_group() {
        assert!(m("colour", "colou?r"));
        assert!(m("color", "colou?r"));
    }

    #[test]
    fn word_boundary_like() {
        let g = groups("foo bar baz", "(bar)");
        assert_eq!(g.get(0).map(String::as_str), Some("bar"));
        assert_eq!(g.get(1).map(String::as_str), Some("bar"));
    }
}
