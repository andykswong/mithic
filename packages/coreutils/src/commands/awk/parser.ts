/**
 * Recursive-descent parser for the POSIX awk language.
 *
 * Turns the {@link tokenize} stream into a {@link Program}. The grammar follows
 * the POSIX awk precedence ladder (loosest → tightest):
 *
 *   ?:                ternary (right-assoc)
 *   ||
 *   &&
 *   in                array membership
 *   ~  !~             match
 *   < <= == != >= >   comparison (non-assoc; also `>` is print-redirect-sensitive)
 *   concat            string concatenation by juxtaposition
 *   + -               additive
 *   * / %             multiplicative
 *   unary + - !
 *   ^                 power (right-assoc)
 *   ++ -- (pre)       increment
 *   $                 field
 *   ++ -- (post), grouping, primary
 *
 * Assignment (`= += …`) is the loosest of all and right-associative; it is
 * handled at the top of {@link parseExpr}. The `print`/`printf` argument list
 * suppresses the bare `>` comparison so that `print a > "file"` parses the `>`
 * as a redirect — we thread a `noGt` flag through expression parsing for that.
 */
import { tokenize } from './lexer.ts';
import type { Token } from './lexer.ts';
import type {
  Program, Rule, Pattern, FuncDef, Stmt, Expr, LValue,
  BinaryOp, AssignOp, Redirect,
} from './ast.ts';

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=']);

class Parser {
  private toks: Token[];
  private pos = 0;

  constructor(src: string) {
    this.toks = tokenize(src);
  }

  // ── token helpers ────────────────────────────────────────────────────────
  private peek(o = 0): Token { return this.toks[Math.min(this.pos + o, this.toks.length - 1)]; }
  private next(): Token { return this.toks[this.pos++]; }
  private atEof(): boolean { return this.peek().type === 'eof'; }

  private is(type: string, value?: string): boolean {
    const t = this.peek();
    return t.type === type && (value === undefined || t.value === value);
  }
  private isOp(v: string): boolean { return this.is('op', v); }
  private isKw(v: string): boolean { return this.is('keyword', v); }

  private eat(type: string, value?: string): Token {
    if (!this.is(type, value)) {
      const t = this.peek();
      throw new Error(`awk: syntax error: expected ${value ?? type}, got ${t.value || t.type} (line ${t.line})`);
    }
    return this.next();
  }
  private accept(type: string, value?: string): boolean {
    if (this.is(type, value)) { this.next(); return true; }
    return false;
  }

  /** Skip newlines and `;` used as terminators in some positions. */
  private skipNewlines(): void { while (this.is('newline') || this.isOp(';')) this.next(); }
  /** Skip only newlines (used after tokens that allow a line break). */
  private optNewlines(): void { while (this.is('newline')) this.next(); }

  // ── program ────────────────────────────────────────────────────────────────
  parse(): Program {
    const rules: Rule[] = [];
    const functions = new Map<string, FuncDef>();
    this.skipNewlines();
    while (!this.atEof()) {
      if (this.isKw('function')) {
        const fn = this.parseFunction();
        functions.set(fn.name, fn);
      } else {
        rules.push(this.parseRule());
      }
      this.skipNewlines();
    }
    return { rules, functions };
  }

  private parseFunction(): FuncDef {
    this.eat('keyword', 'function');
    const nameTok = this.peek();
    if (nameTok.type !== 'name' && nameTok.type !== 'func_name') {
      throw new Error(`awk: syntax error: function name expected (line ${nameTok.line})`);
    }
    this.next();
    this.eat('op', '(');
    const params: string[] = [];
    if (!this.isOp(')')) {
      do {
        this.optNewlines();
        params.push(this.eat('name').value);
        this.optNewlines();
      } while (this.accept('op', ','));
    }
    this.eat('op', ')');
    this.optNewlines();
    const body = this.parseBlock();
    return { name: nameTok.value, params, body };
  }

  private parseRule(): Rule {
    // BEGIN / END blocks.
    if (this.isKw('BEGIN')) { this.next(); this.optNewlines(); return { pattern: { type: 'begin' }, action: this.parseBlock() }; }
    if (this.isKw('END')) { this.next(); this.optNewlines(); return { pattern: { type: 'end' }, action: this.parseBlock() }; }

    // Action-only rule: `{ ... }`.
    if (this.isOp('{')) return { pattern: { type: 'always' }, action: this.parseBlock() };

    // Pattern (expression or range), optionally followed by an action.
    const first = this.parseExpr({ noIn: false, noGt: false });
    let pattern: Pattern;
    if (this.accept('op', ',')) {
      this.optNewlines();
      const second = this.parseExpr({ noIn: false, noGt: false });
      pattern = { type: 'range', start: first, end: second };
    } else {
      pattern = { type: 'expr', expr: first };
    }
    if (this.isOp('{')) return { pattern, action: this.parseBlock() };
    return { pattern }; // pattern-only → implicit print
  }

  // ── statements ──────────────────────────────────────────────────────────────
  private parseBlock(): Stmt[] {
    this.eat('op', '{');
    const stmts: Stmt[] = [];
    this.skipNewlines();
    while (!this.isOp('}') && !this.atEof()) {
      stmts.push(this.parseStmt());
      this.skipNewlines();
    }
    this.eat('op', '}');
    return stmts;
  }

  /** Parse a single statement, consuming a trailing terminator if present. */
  private parseStmt(): Stmt {
    const t = this.peek();

    if (this.isOp('{')) return { type: 'block', body: this.parseBlock() };
    if (this.isOp(';')) { this.next(); return { type: 'empty' }; }

    if (t.type === 'keyword') {
      switch (t.value) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'do': return this.parseDoWhile();
        case 'for': return this.parseFor();
        case 'print': case 'printf': return this.parsePrint();
        case 'next': this.next(); this.endSimple(); return { type: 'next' };
        case 'nextfile': this.next(); this.endSimple(); return { type: 'nextfile' };
        case 'break': this.next(); this.endSimple(); return { type: 'break' };
        case 'continue': this.next(); this.endSimple(); return { type: 'continue' };
        case 'exit': {
          this.next();
          const code = this.startsExpr() ? this.parseExpr({ noIn: false, noGt: false }) : undefined;
          this.endSimple();
          return { type: 'exit', code };
        }
        case 'return': {
          this.next();
          const value = this.startsExpr() ? this.parseExpr({ noIn: false, noGt: false }) : undefined;
          this.endSimple();
          return { type: 'return', value };
        }
        case 'delete': return this.parseDelete();
        default: break;
      }
    }

    // Expression statement.
    const expr = this.parseExpr({ noIn: false, noGt: false });
    this.endSimple();
    return { type: 'expr', expr };
  }

  /** Consume an optional statement terminator (`;` or newline). */
  private endSimple(): void { if (this.is('newline') || this.isOp(';')) this.next(); }

  /** Whether the current token can begin an expression (for optional operands). */
  private startsExpr(): boolean {
    const t = this.peek();
    if (t.type === 'num' || t.type === 'str' || t.type === 'regex'
      || t.type === 'name' || t.type === 'func_name' || t.type === 'builtin') return true;
    if (t.type === 'keyword') return t.value === 'getline';
    if (t.type === 'op') return ['(', '$', '!', '-', '+', '++', '--'].includes(t.value);
    return false;
  }

  private parseIf(): Stmt {
    this.eat('keyword', 'if');
    this.eat('op', '(');
    const cond = this.parseExpr({ noIn: false, noGt: false });
    this.eat('op', ')');
    this.optNewlines();
    const then = this.parseStmt();
    // `else` may follow after optional terminators/newlines.
    const save = this.pos;
    this.skipNewlines();
    if (this.isKw('else')) {
      this.next();
      this.optNewlines();
      const els = this.parseStmt();
      return { type: 'if', cond, then, else: els };
    }
    this.pos = save;
    return { type: 'if', cond, then };
  }

  private parseWhile(): Stmt {
    this.eat('keyword', 'while');
    this.eat('op', '(');
    const cond = this.parseExpr({ noIn: false, noGt: false });
    this.eat('op', ')');
    this.optNewlines();
    return { type: 'while', cond, body: this.parseStmt() };
  }

  private parseDoWhile(): Stmt {
    this.eat('keyword', 'do');
    this.optNewlines();
    const body = this.parseStmt();
    this.skipNewlines();
    this.eat('keyword', 'while');
    this.eat('op', '(');
    const cond = this.parseExpr({ noIn: false, noGt: false });
    this.eat('op', ')');
    this.endSimple();
    return { type: 'dowhile', body, cond };
  }

  private parseFor(): Stmt {
    this.eat('keyword', 'for');
    this.eat('op', '(');
    // Detect `for (name in array)`.
    if (this.peek().type === 'name' && this.peek(1).type === 'keyword' && this.peek(1).value === 'in') {
      const varName = this.next().value;
      this.eat('keyword', 'in');
      const array = this.eat('name').value;
      this.eat('op', ')');
      this.optNewlines();
      return { type: 'forin', var: varName, array, body: this.parseStmt() };
    }
    // C-style for.
    let init: Stmt | undefined;
    if (!this.isOp(';')) init = { type: 'expr', expr: this.parseExpr({ noIn: false, noGt: false }) };
    this.eat('op', ';');
    let cond: Expr | undefined;
    if (!this.isOp(';')) cond = this.parseExpr({ noIn: false, noGt: false });
    this.eat('op', ';');
    let update: Stmt | undefined;
    if (!this.isOp(')')) update = { type: 'expr', expr: this.parseExpr({ noIn: false, noGt: false }) };
    this.eat('op', ')');
    this.optNewlines();
    return { type: 'for', init, cond, update, body: this.parseStmt() };
  }

  private parseDelete(): Stmt {
    this.eat('keyword', 'delete');
    const name = this.eat('name').value;
    if (this.accept('op', '[')) {
      const indices: Expr[] = [this.parseExpr({ noIn: false, noGt: false })];
      while (this.accept('op', ',')) indices.push(this.parseExpr({ noIn: false, noGt: false }));
      this.eat('op', ']');
      this.endSimple();
      return { type: 'delete', name, indices };
    }
    this.endSimple();
    return { type: 'delete', name };
  }

  private parsePrint(): Stmt {
    const kind = this.next().value as 'print' | 'printf';
    const args: Expr[] = [];
    // `print` with no args prints `$0`. Otherwise parse a comma list with `>`
    // suppressed (so it can be a redirect).
    if (this.startsExpr() && !this.isRedirect()) {
      args.push(this.parseExpr({ noIn: false, noGt: true }));
      while (this.accept('op', ',')) {
        this.optNewlines();
        args.push(this.parseExpr({ noIn: false, noGt: true }));
      }
    }
    let redirect: Redirect | undefined;
    if (this.isRedirect()) {
      const mode = this.next().value as '>' | '>>' | '|';
      const target = this.parseExpr({ noIn: false, noGt: false });
      redirect = { mode, target };
    }
    this.endSimple();
    // A single parenthesized group like `print (a, b)` is still a list — but our
    // grouping handling treats `(a, b)` specially only inside `in`; for print we
    // accept the common forms above.
    return kind === 'print' ? { type: 'print', args, redirect } : { type: 'printf', args, redirect };
  }

  private isRedirect(): boolean {
    return this.isOp('>') || this.isOp('>>') || this.isOp('|');
  }

  // ── expressions ──────────────────────────────────────────────────────────────
  private parseExpr(ctx: ExprCtx): Expr {
    return this.parseAssignment(ctx);
  }

  private parseAssignment(ctx: ExprCtx): Expr {
    const left = this.parseTernary(ctx);
    if (this.peek().type === 'op' && ASSIGN_OPS.has(this.peek().value)) {
      const lv = this.asLValue(left);
      if (lv) {
        const op = this.next().value as AssignOp;
        const value = this.parseAssignment(ctx); // right-assoc
        return { type: 'assign', op, target: lv, value };
      }
    }
    return left;
  }

  private parseTernary(ctx: ExprCtx): Expr {
    const cond = this.parseOr(ctx);
    if (this.accept('op', '?')) {
      this.optNewlines();
      const then = this.parseAssignment(ctx);
      this.eat('op', ':');
      this.optNewlines();
      const els = this.parseAssignment(ctx);
      return { type: 'ternary', cond, then, else: els };
    }
    return cond;
  }

  private parseOr(ctx: ExprCtx): Expr {
    let left = this.parseAnd(ctx);
    while (this.isOp('||')) { this.next(); this.optNewlines(); left = { type: 'binary', op: '||', left, right: this.parseAnd(ctx) }; }
    return left;
  }

  private parseAnd(ctx: ExprCtx): Expr {
    let left = this.parseIn(ctx);
    while (this.isOp('&&')) { this.next(); this.optNewlines(); left = { type: 'binary', op: '&&', left, right: this.parseIn(ctx) }; }
    return left;
  }

  private parseIn(ctx: ExprCtx): Expr {
    let left = this.parseMatch(ctx);
    while (!ctx.noIn && this.isKw('in')) {
      this.next();
      const array = this.eat('name').value;
      // `(a, b) in arr` produces a multidim membership; a single expr is wrapped.
      const indices = left.type === 'group' ? [left.expr] : [left];
      left = { type: 'in', indices, array };
    }
    return left;
  }

  private parseMatch(ctx: ExprCtx): Expr {
    let left = this.parseComparison(ctx);
    while (this.isOp('~') || this.isOp('!~')) {
      const op = this.next().value as BinaryOp;
      left = { type: 'binary', op, left, right: this.parseComparison(ctx) };
    }
    return left;
  }

  private parseComparison(ctx: ExprCtx): Expr {
    const left = this.parseConcat(ctx);
    // Comparison is non-associative in awk; parse at most one.
    const t = this.peek();
    if (t.type === 'op') {
      const v = t.value;
      if (v === '<' || v === '<=' || v === '==' || v === '!=' || v === '>='
        || (v === '>' && !ctx.noGt)) {
        this.next();
        return { type: 'binary', op: v as BinaryOp, left, right: this.parseConcat(ctx) };
      }
    }
    return left;
  }

  private parseConcat(ctx: ExprCtx): Expr {
    const parts: Expr[] = [this.parsePipeGetline(ctx)];
    // Concatenation continues while the next token can begin a (non-operator)
    // operand. We must NOT treat a leading `-`/`+` as concat (it's additive),
    // nor `in`, comparison, `?`, etc.
    while (this.startsConcatOperand()) {
      parts.push(this.parsePipeGetline(ctx));
    }
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  /**
   * Parse an additive expression, then recognize the `cmd | getline [var]` form:
   * an expression piped into `getline`. We only consume `|` when it is followed
   * by the `getline` keyword (the print `| cmd` redirect is handled in
   * {@link parsePrint}, which sees the bare `|` before reaching here).
   */
  private parsePipeGetline(ctx: ExprCtx): Expr {
    let left = this.parseAdditive(ctx);
    while (this.isOp('|') && this.peek(1).type === 'keyword' && this.peek(1).value === 'getline') {
      this.next(); // '|'
      this.eat('keyword', 'getline');
      let into: LValue | undefined;
      const t = this.peek();
      if (t.type === 'name' || (t.type === 'op' && t.value === '$')) {
        const target = this.parseField(ctx);
        const lv = this.asLValue(target);
        if (lv) into = lv;
      }
      left = { type: 'getline', source: 'cmd', into, arg: left };
    }
    return left;
  }

  /** Whether the current token can begin a concatenated operand. */
  private startsConcatOperand(): boolean {
    const t = this.peek();
    if (t.type === 'num' || t.type === 'str' || t.type === 'regex'
      || t.type === 'name' || t.type === 'func_name' || t.type === 'builtin') return true;
    if (t.type === 'keyword') return t.value === 'getline';
    if (t.type === 'op') {
      // `(`, `$`, `!`, prefix `++`/`--` start operands; `>` only if allowed.
      return t.value === '(' || t.value === '$' || t.value === '!'
        || t.value === '++' || t.value === '--';
    }
    return false;
  }

  private parseAdditive(ctx: ExprCtx): Expr {
    let left = this.parseMultiplicative(ctx);
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value as BinaryOp;
      left = { type: 'binary', op, left, right: this.parseMultiplicative(ctx) };
    }
    return left;
  }

  private parseMultiplicative(ctx: ExprCtx): Expr {
    let left = this.parseUnary(ctx);
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value as BinaryOp;
      left = { type: 'binary', op, left, right: this.parseUnary(ctx) };
    }
    return left;
  }

  private parseUnary(ctx: ExprCtx): Expr {
    if (this.isOp('!') || this.isOp('-') || this.isOp('+')) {
      const op = this.next().value as '-' | '+' | '!';
      return { type: 'unary', op, expr: this.parseUnary(ctx) };
    }
    return this.parsePower(ctx);
  }

  private parsePower(ctx: ExprCtx): Expr {
    const left = this.parsePreUpdate(ctx);
    if (this.isOp('^')) {
      this.next();
      // Power is right-associative and binds tighter than unary on its right.
      return { type: 'binary', op: '^', left, right: this.parseUnary(ctx) };
    }
    return left;
  }

  private parsePreUpdate(ctx: ExprCtx): Expr {
    if (this.isOp('++') || this.isOp('--')) {
      const op = this.next().value as '++' | '--';
      const target = this.parsePreUpdate(ctx);
      const lv = this.asLValue(target);
      if (!lv) throw new Error('awk: syntax error: ++/-- needs an lvalue');
      return { type: 'update', op, prefix: true, target: lv };
    }
    return this.parsePostfix(ctx);
  }

  private parsePostfix(ctx: ExprCtx): Expr {
    let expr = this.parseField(ctx);
    while (this.isOp('++') || this.isOp('--')) {
      const lv = this.asLValue(expr);
      if (!lv) break; // not an lvalue → leave the ++/-- for the caller (rare)
      const op = this.next().value as '++' | '--';
      expr = { type: 'update', op, prefix: false, target: lv };
    }
    return expr;
  }

  private parseField(ctx: ExprCtx): Expr {
    if (this.isOp('$')) {
      this.next();
      // `$` binds tighter than everything except postfix; `$i++` is `($i)++`,
      // `$NF` etc. The operand is a primary (incl. parenthesized / prefixed).
      const index = this.parseField(ctx);
      return { type: 'field', index };
    }
    return this.parsePrimary(ctx);
  }

  private parsePrimary(ctx: ExprCtx): Expr {
    const t = this.peek();

    if (t.type === 'num') { this.next(); return { type: 'num', value: t.num ?? Number(t.value) }; }
    if (t.type === 'str') { this.next(); return { type: 'str', value: t.value }; }
    if (t.type === 'regex') { this.next(); return { type: 'regex', source: t.value }; }

    if (t.type === 'keyword' && t.value === 'getline') return this.parseGetline(ctx);

    if (t.type === 'builtin') return this.parseBuiltin(ctx);

    if (t.type === 'func_name') {
      this.next();
      this.eat('op', '(');
      const args = this.parseArgList(ctx);
      this.eat('op', ')');
      return { type: 'call', name: t.value, args };
    }

    if (t.type === 'name') {
      this.next();
      if (this.accept('op', '[')) {
        const indices: Expr[] = [this.parseExpr({ noIn: false, noGt: false })];
        while (this.accept('op', ',')) indices.push(this.parseExpr({ noIn: false, noGt: false }));
        this.eat('op', ']');
        return { type: 'index', name: t.value, indices };
      }
      return { type: 'var', name: t.value };
    }

    if (this.isOp('(')) {
      this.next();
      const first = this.parseExpr({ noIn: false, noGt: false });
      // `(a, b) in arr` — a parenthesized comma list used only with `in`.
      if (this.isOp(',')) {
        const indices = [first];
        while (this.accept('op', ',')) indices.push(this.parseExpr({ noIn: false, noGt: false }));
        this.eat('op', ')');
        this.eat('keyword', 'in');
        const array = this.eat('name').value;
        return { type: 'in', indices, array };
      }
      this.eat('op', ')');
      return { type: 'group', expr: first };
    }

    throw new Error(`awk: syntax error: unexpected ${t.value || t.type} (line ${t.line})`);
  }

  private parseGetline(ctx: ExprCtx): Expr {
    this.eat('keyword', 'getline');
    // Optional target lvalue: a var/field/array element (not a general expr).
    let into: LValue | undefined;
    const t = this.peek();
    if (t.type === 'name' || (t.type === 'op' && t.value === '$')) {
      const target = this.parseField(ctx);
      const lv = this.asLValue(target);
      if (lv) into = lv;
    }
    // `getline [var] < file`.
    if (this.isOp('<')) {
      this.next();
      const arg = this.parseConcat(ctx);
      return { type: 'getline', source: 'file', into, arg };
    }
    return { type: 'getline', source: 'main', into };
  }

  private parseBuiltin(ctx: ExprCtx): Expr {
    const name = this.next().value;
    const args: Expr[] = [];
    // `length` may be used with no parens (`length` ≡ `length($0)`); every
    // other builtin requires a parenthesized argument list.
    if (this.accept('op', '(')) {
      args.push(...this.parseArgList(ctx));
      this.eat('op', ')');
    }
    return { type: 'builtin', name, args };
  }

  private parseArgList(ctx: ExprCtx): Expr[] {
    const args: Expr[] = [];
    this.optNewlines();
    if (this.isOp(')')) return args;
    args.push(this.parseExpr({ noIn: ctx.noIn, noGt: false }));
    while (this.accept('op', ',')) {
      this.optNewlines();
      args.push(this.parseExpr({ noIn: ctx.noIn, noGt: false }));
    }
    return args;
  }

  /** Coerce a parsed expression into an l-value if it is one. */
  private asLValue(e: Expr): LValue | undefined {
    if (e.type === 'var' || e.type === 'field' || e.type === 'index') return e;
    if (e.type === 'group') return this.asLValue(e.expr);
    return undefined;
  }
}

interface ExprCtx {
  /** Suppress the `in` operator (used inside `for(...)` array-index lists). */
  noIn: boolean;
  /** Suppress `>` as comparison (used in print/printf arg lists for redirect). */
  noGt: boolean;
}

/** Parse awk program source into a {@link Program}. */
export function parseProgram(src: string): Program {
  return new Parser(src).parse();
}
