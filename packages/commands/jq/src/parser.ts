/**
 * jq parser — recursive-descent over the {@link lex} token stream, producing the
 * {@link Node} AST. Precedence (low→high) follows jq: pipe `|`, comma `,`,
 * `//` alternative, `or`, `and`, comparisons, additive, multiplicative, unary
 * `-`, then postfix suffixes (`.foo`, `[..]`, `?`) on primaries.
 *
 * `def`/`as`/`reduce`/`foreach`/`if`/`try`/`label` are parsed as part of the
 * pipe level so they compose left-to-right with `|` the way jq expects.
 */
import { lex } from './lexer.ts';
import type { Token } from './lexer.ts';
import type { BinOp, Node, ObjectEntry, Pattern } from './ast.ts';

export class ParseError extends Error {}

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(src: string) {
    this.toks = lex(src);
  }

  private peek(o = 0): Token { return this.toks[this.pos + o]; }
  private next(): Token { return this.toks[this.pos++]; }
  private atEnd(): boolean { return this.peek().type === 'EOF'; }

  private is(type: Token['type'], value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private accept(type: Token['type'], value?: string): Token | null {
    if (this.is(type, value)) return this.next();
    return null;
  }
  private expect(type: Token['type'], value?: string): Token {
    if (this.is(type, value)) return this.next();
    const t = this.peek();
    throw new ParseError(`jq: syntax error: expected ${value ?? type}, got '${t.value || t.type}' at ${t.pos}`);
  }

  parseProgram(): Node {
    const node = this.parsePipe();
    if (!this.atEnd()) {
      const t = this.peek();
      throw new ParseError(`jq: syntax error: unexpected '${t.value || t.type}' at ${t.pos}`);
    }
    return node;
  }

  // ── pipe level (lowest) ──────────────────────────────────────────────────
  // Also where def / control-flow bindings live, since they pipe into the rest.
  private parsePipe(): Node {
    // function definitions: def f: body; rest
    if (this.is('KEYWORD', 'def')) {
      return this.parseFuncDef();
    }

    const left = this.parseComma();

    // `EXP as PATTERN ?// PATTERN | body`
    if (this.is('KEYWORD', 'as')) {
      this.next();
      const patterns: Pattern[] = [this.parsePattern()];
      while (this.accept('OP', '?//')) patterns.push(this.parsePattern());
      this.expect('PUNC', '|');
      const body = this.parsePipe();
      return { kind: 'bind', source: left, patterns, body };
    }

    if (this.accept('PUNC', '|')) {
      const right = this.parsePipe();
      return { kind: 'pipe', left, right };
    }
    return left;
  }

  private parseFuncDef(): Node {
    this.expect('KEYWORD', 'def');
    const name = this.expect('IDENT').value;
    const params: string[] = [];
    if (this.accept('PUNC', '(')) {
      do {
        if (this.is('VAR')) params.push('$' + this.next().value);
        else params.push(this.expect('IDENT').value);
      } while (this.accept('PUNC', ';'));
      this.expect('PUNC', ')');
    }
    this.expect('PUNC', ':');
    const body = this.parsePipe();
    this.expect('PUNC', ';');
    // The definition scopes over everything that follows.
    const rest = this.atEnd() || this.is('PUNC', ')') || this.is('PUNC', ';')
      ? ({ kind: 'identity' } as Node)
      : this.parsePipe();
    return { kind: 'funcdef', name, params, body, rest };
  }

  // ── comma ────────────────────────────────────────────────────────────────
  private parseComma(): Node {
    let left = this.parseAlternative();
    while (this.accept('PUNC', ',')) {
      const right = this.parseAlternative();
      left = { kind: 'comma', left, right };
    }
    return left;
  }

  // ── // alternative ─────────────────────────────────────────────────────────
  private parseAlternative(): Node {
    let left = this.parseReduceOrAssign();
    while (this.accept('OP', '//')) {
      const right = this.parseReduceOrAssign();
      left = { kind: 'alternative', left, right };
    }
    return left;
  }

  // assignment operators (=, |=, +=, ...) are right-assoc above // ; we treat
  // them at this level so `a // b` binds looser than assignment.
  private parseReduceOrAssign(): Node {
    const left = this.parseOr();
    const t = this.peek();
    if (t.type === 'OP' && ['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='].includes(t.value)) {
      this.next();
      const right = this.parseReduceOrAssign();
      return this.makeAssign(t.value, left, right);
    }
    return left;
  }

  private makeAssign(op: string, path: Node, value: Node): Node {
    // Desugar to update-assignment builtins handled by the interpreter via call.
    // `_modify(paths; update)`-style: we represent as a call the interp knows.
    return { kind: 'call', name: `@@assign:${op}`, args: [path, value] };
  }

  // ── or ───────────────────────────────────────────────────────────────────
  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.is('OP', 'or')) { this.next(); left = { kind: 'or', left, right: this.parseAnd() }; }
    return left;
  }

  // ── and ──────────────────────────────────────────────────────────────────
  private parseAnd(): Node {
    let left = this.parseComparison();
    while (this.is('OP', 'and')) { this.next(); left = { kind: 'and', left, right: this.parseComparison() }; }
    return left;
  }

  // ── comparison ─────────────────────────────────────────────────────────────
  private parseComparison(): Node {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && ['==', '!=', '<', '<=', '>', '>='].includes(t.value)) {
        this.next();
        left = { kind: 'binop', op: t.value as BinOp, left, right: this.parseAdditive() };
      } else break;
    }
    return left;
  }

  // ── additive ───────────────────────────────────────────────────────────────
  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && (t.value === '+' || t.value === '-')) {
        this.next();
        left = { kind: 'binop', op: t.value as BinOp, left, right: this.parseMultiplicative() };
      } else break;
    }
    return left;
  }

  // ── multiplicative ───────────────────────────────────────────────────────
  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        left = { kind: 'binop', op: t.value as BinOp, left, right: this.parseUnary() };
      } else break;
    }
    return left;
  }

  // ── unary minus ──────────────────────────────────────────────────────────
  private parseUnary(): Node {
    if (this.is('OP', '-')) { this.next(); return { kind: 'negate', operand: this.parsePostfix() }; }
    return this.parsePostfix();
  }

  // ── postfix suffixes on a primary: .foo, [..], ?, ─────────────────────────
  private parsePostfix(): Node {
    let node = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.type === 'FIELD') {
        this.next();
        node = { kind: 'index', target: node, index: { kind: 'literal', value: t.value }, optional: false };
      } else if (t.type === 'PUNC' && t.value === '.' && this.peek(1).type === 'STR') {
        // ."str"
        this.next();
        const strTok = this.next();
        node = { kind: 'index', target: node, index: this.stringNode(strTok), optional: false };
      } else if (t.type === 'PUNC' && t.value === '.' && this.peek(1).value === '[') {
        // chained `.[...]` after a primary that wasn't itself a bracket
        this.next();
        node = this.parseBracket(node);
      } else if (t.type === 'PUNC' && t.value === '[') {
        node = this.parseBracket(node);
      } else if (t.type === 'PUNC' && t.value === '?') {
        this.next();
        node = { kind: 'optional', body: node };
      } else break;
    }
    return node;
  }

  // parse `[...]` suffix against `target`: index, slice, or iterate.
  private parseBracket(target: Node): Node {
    this.expect('PUNC', '[');
    if (this.accept('PUNC', ']')) {
      const opt = this.acceptOptional();
      return { kind: 'iterate', target, optional: opt };
    }
    // slice forms: [from:to], [:to], [from:]
    if (this.is('PUNC', ':')) {
      this.next();
      const to = this.parsePipe();
      this.expect('PUNC', ']');
      return { kind: 'slice', target, from: null, to, optional: this.acceptOptional() };
    }
    const first = this.parsePipe();
    if (this.accept('PUNC', ':')) {
      if (this.is('PUNC', ']')) {
        this.next();
        return { kind: 'slice', target, from: first, to: null, optional: this.acceptOptional() };
      }
      const to = this.parsePipe();
      this.expect('PUNC', ']');
      return { kind: 'slice', target, from: first, to, optional: this.acceptOptional() };
    }
    this.expect('PUNC', ']');
    return { kind: 'index', target, index: first, optional: this.acceptOptional() };
  }

  private acceptOptional(): boolean {
    return this.accept('PUNC', '?') != null;
  }

  // ── primary ──────────────────────────────────────────────────────────────
  private parsePrimary(): Node {
    const t = this.peek();

    switch (t.type) {
      case 'NUM':
        this.next();
        return { kind: 'literal', value: Number(t.value) };
      case 'STR':
        this.next();
        return this.stringNode(t);
      case 'FORMAT': {
        this.next();
        // @base64 "..." applies the format to the following string
        if (this.is('STR')) {
          const strTok = this.next();
          return this.stringNode(strTok, t.value);
        }
        return { kind: 'format', name: t.value };
      }
      case 'VAR':
        this.next();
        if (t.value === '__loc__') return { kind: 'loc' };
        if (t.value === 'ENV') return { kind: 'call', name: '@@env', args: [] };
        return { kind: 'var', name: t.value };
      case 'FIELD':
        this.next();
        return { kind: 'index', target: { kind: 'identity' }, index: { kind: 'literal', value: t.value }, optional: false };
      case 'KEYWORD':
        return this.parseKeyword();
      case 'IDENT':
        return this.parseCall();
      case 'PUNC':
        return this.parsePunc();
      case 'OP':
        if (t.value === '..') { this.next(); return { kind: 'recurseDefault' }; }
        break;
    }
    throw new ParseError(`jq: syntax error: unexpected '${t.value || t.type}' at ${t.pos}`);
  }

  private parsePunc(): Node {
    const t = this.peek();
    switch (t.value) {
      case '.': {
        this.next();
        // `.[`, `."str"`, or bare identity
        if (this.is('PUNC', '[')) return this.parseBracket({ kind: 'identity' });
        if (this.is('STR')) {
          const strTok = this.next();
          return { kind: 'index', target: { kind: 'identity' }, index: this.stringNode(strTok), optional: false };
        }
        return { kind: 'identity' };
      }
      case '(': {
        this.next();
        const inner = this.parsePipe();
        this.expect('PUNC', ')');
        return inner;
      }
      case '[': {
        // array constructor
        this.next();
        if (this.accept('PUNC', ']')) return { kind: 'array', body: null };
        const body = this.parsePipe();
        this.expect('PUNC', ']');
        return { kind: 'array', body };
      }
      case '{':
        return this.parseObject();
    }
    throw new ParseError(`jq: syntax error: unexpected '${t.value}' at ${t.pos}`);
  }

  private parseKeyword(): Node {
    const kw = this.peek().value;
    switch (kw) {
      case 'if': return this.parseIf();
      case 'try': return this.parseTry();
      case 'reduce': return this.parseReduce();
      case 'foreach': return this.parseForeach();
      case 'label': return this.parseLabel();
      case 'def': return this.parseFuncDef();
      case 'not': // `not` used as a bare filter name
        this.next();
        return { kind: 'call', name: 'not', args: [] };
      case '__loc__':
        this.next();
        return { kind: 'loc' };
    }
    throw new ParseError(`jq: syntax error: unexpected keyword '${kw}'`);
  }

  private parseIf(): Node {
    this.expect('KEYWORD', 'if');
    const cond = this.parsePipe();
    this.expect('KEYWORD', 'then');
    const then = this.parsePipe();
    const elifs: Array<{ cond: Node; then: Node }> = [];
    while (this.is('KEYWORD', 'elif')) {
      this.next();
      const c = this.parsePipe();
      this.expect('KEYWORD', 'then');
      const b = this.parsePipe();
      elifs.push({ cond: c, then: b });
    }
    let elseNode: Node | null = null;
    if (this.accept('KEYWORD', 'else')) elseNode = this.parsePipe();
    this.expect('KEYWORD', 'end');
    return { kind: 'if', cond, then, elifs, else: elseNode };
  }

  private parseTry(): Node {
    this.expect('KEYWORD', 'try');
    const body = this.parsePostfix();
    let catchNode: Node | null = null;
    if (this.accept('KEYWORD', 'catch')) catchNode = this.parsePostfix();
    return { kind: 'try', body, catch: catchNode };
  }

  private parseReduce(): Node {
    this.expect('KEYWORD', 'reduce');
    const source = this.parsePostfix();
    this.expect('KEYWORD', 'as');
    const pattern = this.parsePattern();
    this.expect('PUNC', '(');
    const init = this.parsePipe();
    this.expect('PUNC', ';');
    const update = this.parsePipe();
    this.expect('PUNC', ')');
    return { kind: 'reduce', source, pattern, init, update };
  }

  private parseForeach(): Node {
    this.expect('KEYWORD', 'foreach');
    const source = this.parsePostfix();
    this.expect('KEYWORD', 'as');
    const pattern = this.parsePattern();
    this.expect('PUNC', '(');
    const init = this.parsePipe();
    this.expect('PUNC', ';');
    const update = this.parsePipe();
    let extract: Node | null = null;
    if (this.accept('PUNC', ';')) extract = this.parsePipe();
    this.expect('PUNC', ')');
    return { kind: 'foreach', source, pattern, init, update, extract };
  }

  private parseLabel(): Node {
    this.expect('KEYWORD', 'label');
    const name = this.expect('VAR').value;
    this.expect('PUNC', '|');
    const body = this.parsePipe();
    return { kind: 'label', name, body };
  }

  private parseCall(): Node {
    const name = this.expect('IDENT').value;
    // literal keywords that lex as identifiers
    if (name === 'true') return { kind: 'literal', value: true };
    if (name === 'false') return { kind: 'literal', value: false };
    if (name === 'null') return { kind: 'literal', value: null };
    if (name === 'break') {
      // `break $label`
      const v = this.expect('VAR');
      return { kind: 'break', name: v.value };
    }
    const args: Node[] = [];
    if (this.accept('PUNC', '(')) {
      do { args.push(this.parsePipe()); } while (this.accept('PUNC', ';'));
      this.expect('PUNC', ')');
    }
    return { kind: 'call', name, args };
  }

  // ── string literal → node (with interpolation + optional format) ─────────
  private stringNode(tok: Token, format: string | null = null): Node {
    const parts = tok.parts ?? [{ type: 'lit' as const, value: '' }];
    // Pure literal string → literal node.
    if (parts.length === 1 && parts[0].type === 'lit' && format === null) {
      return { kind: 'literal', value: parts[0].value };
    }
    if (parts.every((p) => p.type === 'lit') && format === null) {
      return { kind: 'literal', value: parts.map((p) => (p as { value: string }).value).join('') };
    }
    const nodeParts = parts.map((p) =>
      p.type === 'lit'
        ? { type: 'lit' as const, value: p.value }
        : { type: 'interp' as const, node: parse(p.src) },
    );
    return { kind: 'strinterp', parts: nodeParts, format };
  }

  // ── destructuring patterns ─────────────────────────────────────────────────
  private parsePattern(): Pattern {
    if (this.is('VAR')) {
      return { kind: 'var', name: this.next().value };
    }
    if (this.accept('PUNC', '[')) {
      const elements: Pattern[] = [];
      if (!this.is('PUNC', ']')) {
        do { elements.push(this.parsePattern()); } while (this.accept('PUNC', ','));
      }
      this.expect('PUNC', ']');
      return { kind: 'array', elements };
    }
    if (this.accept('PUNC', '{')) {
      const entries: Array<{ keyVar?: string; key?: Node; value: Pattern }> = [];
      do {
        if (this.is('VAR')) {
          const v = this.next().value;
          if (this.accept('PUNC', ':')) {
            entries.push({ key: { kind: 'var', name: v }, value: this.parsePattern() });
          } else {
            // {$x} shorthand → bind $x = .x
            entries.push({ keyVar: v, value: { kind: 'var', name: v } });
          }
        } else if (this.is('IDENT') || this.is('KEYWORD')) {
          const k = this.next().value;
          this.expect('PUNC', ':');
          entries.push({ key: { kind: 'literal', value: k }, value: this.parsePattern() });
        } else if (this.is('STR')) {
          const k = this.stringNode(this.next());
          this.expect('PUNC', ':');
          entries.push({ key: k, value: this.parsePattern() });
        } else if (this.accept('PUNC', '(')) {
          const k = this.parsePipe();
          this.expect('PUNC', ')');
          this.expect('PUNC', ':');
          entries.push({ key: k, value: this.parsePattern() });
        } else {
          throw new ParseError(`jq: syntax error in object pattern at ${this.peek().pos}`);
        }
      } while (this.accept('PUNC', ','));
      this.expect('PUNC', '}');
      return { kind: 'object', entries };
    }
    throw new ParseError(`jq: syntax error: invalid pattern at ${this.peek().pos}`);
  }

  // ── object constructor ─────────────────────────────────────────────────────
  private parseObject(): Node {
    this.expect('PUNC', '{');
    const entries: ObjectEntry[] = [];
    if (this.accept('PUNC', '}')) return { kind: 'object', entries };
    do {
      if (this.is('PUNC', '}')) break;
      entries.push(this.parseObjectEntry());
    } while (this.accept('PUNC', ','));
    this.expect('PUNC', '}');
    return { kind: 'object', entries };
  }

  private parseObjectEntry(): ObjectEntry {
    const t = this.peek();
    // {$x}  → key "x", value .x  ; {$x: v} → key "x"? No: $x as key means value of $x
    if (t.type === 'VAR') {
      this.next();
      if (this.accept('PUNC', ':')) {
        // {$k: v} — key is the variable's value
        const value = this.parseObjectValue();
        return { key: { kind: 'var', name: t.value }, value };
      }
      // {$x} shorthand → {"x": $x}
      return { key: { kind: 'literal', value: t.value }, value: { kind: 'var', name: t.value } };
    }
    if (t.type === 'IDENT' || t.type === 'KEYWORD') {
      this.next();
      if (this.accept('PUNC', ':')) {
        return { key: { kind: 'literal', value: t.value }, value: this.parseObjectValue() };
      }
      // {foo} shorthand → {"foo": .foo}
      return { key: { kind: 'literal', value: t.value }, value: { kind: 'index', target: { kind: 'identity' }, index: { kind: 'literal', value: t.value }, optional: false } };
    }
    if (t.type === 'STR') {
      this.next();
      const key = this.stringNode(t);
      if (this.accept('PUNC', ':')) {
        return { key, value: this.parseObjectValue() };
      }
      // {"foo"} shorthand
      const lit = (key.kind === 'literal' ? key.value : '') as string;
      return { key, value: { kind: 'index', target: { kind: 'identity' }, index: { kind: 'literal', value: lit }, optional: false } };
    }
    if (t.type === 'FORMAT') {
      this.next();
      // @base64 as a key: rare; treat as call format then expects ':'
      const key: Node = { kind: 'format', name: t.value };
      this.expect('PUNC', ':');
      return { key, value: this.parseObjectValue() };
    }
    if (t.type === 'PUNC' && t.value === '(') {
      this.next();
      const key = this.parsePipe();
      this.expect('PUNC', ')');
      this.expect('PUNC', ':');
      return { key, value: this.parseObjectValue() };
    }
    throw new ParseError(`jq: syntax error in object at ${t.pos}`);
  }

  // Object values bind tighter than `,` (which separates entries) and `|`.
  private parseObjectValue(): Node {
    return this.parseObjectValuePipe();
  }
  private parseObjectValuePipe(): Node {
    let left = this.parseAlternative();
    while (this.accept('PUNC', '|')) {
      const right = this.parseAlternative();
      left = { kind: 'pipe', left, right };
    }
    return left;
  }
}

/** Parse a jq program string into its AST root {@link Node}. */
export function parse(src: string): Node {
  return new Parser(src).parseProgram();
}
