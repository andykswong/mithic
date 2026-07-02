import { tokenize } from './lexer.ts';
import type { Token, TokenType } from './lexer.ts';
import type {
  Assignment,
  CaseClause,
  Program,
  Redirect,
  RedirectOp,
  SimpleCommand,
  Statement,
} from './ast.ts';

/**
 * Recursive-descent parser for the shell grammar.
 *
 *   program   := list
 *   list      := and_or ( (';' | '&' | NEWLINE) and_or )*
 *   and_or    := pipeline ( ('&&' | '||') pipeline )*
 *   pipeline  := ['!'] command ( '|' command )*
 *   command   := compound | simple
 *   compound  := if | while | until | for | case | function | subshell | group
 *              | arithmetic-cmd | cond-cmd
 *
 * Here-docs are extracted from the raw source up front (see {@link extractHereDocs})
 * since their bodies span lines the tokenizer would otherwise split apart.
 */

const RESERVED = new Set([
  'if', 'then', 'elif', 'else', 'fi',
  'while', 'until', 'do', 'done',
  'for', 'select', 'in', 'case', 'esac', 'function',
  '{', '}', '!', 'coproc',
]);

interface HereDoc { id: number; body: string; quoted: boolean; }

export interface ParseOptions {
  /** POSIX mode: reject bash extensions ([[, ((, <<<, |&, select, arrays). */
  posix?: boolean;
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private heredocs: Map<number, HereDoc>;
  private posix: boolean;

  constructor(tokens: Token[], heredocs: Map<number, HereDoc>, options: ParseOptions = {}) {
    this.tokens = tokens;
    this.heredocs = heredocs;
    this.posix = options.posix ?? false;
  }

  private posixReject(feature: string): never {
    throw new SyntaxError(`shell: syntax error: ${feature} is not supported in POSIX mode`);
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private at(off = 0): Token | undefined { return this.tokens[this.pos + off]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }
  private atType(type: TokenType): boolean { return this.peek()?.type === type; }

  private atReserved(word: string): boolean {
    const t = this.peek();
    return t?.type === 'WORD' && t.value === word;
  }
  private atAnyReserved(words: string[]): boolean {
    const t = this.peek();
    if (t?.type !== 'WORD') return false;
    return words.includes(t.value);
  }

  private skipSeparators(): void {
    while (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
  }
  private skipNewlines(): void {
    while (this.atType('NEWLINE')) this.next();
  }

  parseProgram(): Program {
    const body: Statement[] = [];
    this.skipSeparators();
    while (this.peek() && !this.atTerminator()) {
      body.push(this.parseAndOr());
      if (this.atType('SEMI') || this.atType('NEWLINE') || this.atType('AMP')) this.next();
      this.skipSeparators();
    }
    return { type: 'Program', body };
  }

  private atTerminator(): boolean {
    const t = this.peek();
    if (!t) return true;
    if (t.type === 'WORD' && RESERVED.has(t.value)
      && !['if', 'while', 'until', 'for', 'select', 'case', 'function', '{', '!', 'coproc'].includes(t.value)) {
      return true;
    }
    if (t.type === 'RPAREN' || t.type === 'DSEMI' || t.type === 'DRPAREN') return true;
    return false;
  }

  private parseAndOr(): Statement {
    // The statement's source line = the line its first token starts on.
    const line = this.peek()?.line;
    let left = this.parsePipeline();
    for (;;) {
      if (this.atType('AND_IF') || this.atType('OR_IF')) {
        const op = this.next()!.type === 'AND_IF' ? 'And' : 'Or';
        this.skipNewlines();
        const right = this.parsePipeline();
        left = { type: op, left, right };
      } else break;
    }
    if (line !== undefined) left.line = line;
    return left;
  }

  private parsePipeline(): Statement {
    // The pipeline's source line = the line its first token starts on. Stamping
    // each pipeline (not just the outer And/Or node) lets a continuation's
    // right-hand side report its real line for $LINENO, e.g. `true &&\necho …`.
    const pipelineLine = this.peek()?.line;
    let negate = false;
    if (this.atReserved('!')) { this.next(); negate = true; }

    const first = this.parseCommand();
    if (!this.atType('PIPE') && !this.atType('PIPEAMP')) {
      if (negate) first.negate = true;
      this.maybeBackground(first);
      if (pipelineLine !== undefined) first.line ??= pipelineLine;
      return first;
    }

    // A pipeline of ≥2 stages. Each stage is a full command node; the `|&`
    // operator (PIPEAMP) marks the pipe BEFORE the following stage as also
    // carrying the previous stage's stderr. `pipeStderr[i]` is the flag for the
    // pipe joining stage i and i+1.
    const stageNodes: Statement[] = [first];
    const pipeStderr: boolean[] = [];
    while (this.atType('PIPE') || this.atType('PIPEAMP')) {
      const isAmp = this.atType('PIPEAMP');
      if (isAmp && this.posix) this.posixReject('|&');
      pipeStderr.push(isAmp);
      this.next();
      this.skipNewlines();
      stageNodes.push(this.parseCommand());
    }

    // Fast path: when every stage is a single SimpleCommand and no `|&`, keep the
    // flat `stages` form the kernel pipeline path expects.
    const allSimple = stageNodes.every((s) => s.type === 'Pipeline' && s.stages?.length === 1);
    const pipeline: Statement = { type: 'Pipeline', negate };
    if (allSimple && !pipeStderr.some(Boolean)) {
      pipeline.stages = stageNodes.map((s) => s.stages![0]);
    } else {
      pipeline.stageNodes = stageNodes;
      pipeline.pipeStderr = pipeStderr;
    }
    this.maybeBackground(pipeline);
    if (pipelineLine !== undefined) pipeline.line ??= pipelineLine;
    return pipeline;
  }

  private maybeBackground(stmt: Statement): void {
    if (this.atType('AMP')) { this.next(); stmt.background = true; }
  }

  private parseCommand(): Statement {
    if (this.atReserved('if')) return this.parseIf();
    if (this.atReserved('while') || this.atReserved('until')) return this.parseWhile();
    if (this.atReserved('for')) return this.parseFor();
    if (this.atReserved('case')) return this.parseCase();
    if (this.atReserved('function')) return this.parseFunctionKw();
    if (this.atReserved('{')) return this.parseGroup();
    if (this.atType('LPAREN')) return this.parseSubshell();
    if (this.atType('DLPAREN')) { if (this.posix) this.posixReject('(( ))'); return this.parseArithCmd(); }
    if (this.atType('DLBRACKET')) { if (this.posix) this.posixReject('[[ ]]'); return this.parseCond(); }
    if (this.atReserved('select')) { if (this.posix) this.posixReject('select'); return this.parseSelect(); }
    if (this.atReserved('coproc')) { if (this.posix) this.posixReject('coproc'); return this.parseCoproc(); }

    // function definition: NAME ( )  { ... }
    const t = this.peek();
    if (t?.type === 'WORD' && this.at(1)?.type === 'LPAREN' && this.at(2)?.type === 'RPAREN'
      && isName(t.value)) {
      return this.parseFunctionParen();
    }

    return this.wrapSimple(this.parseSimpleCommand());
  }

  private wrapSimple(cmd: SimpleCommand): Statement {
    return { type: 'Pipeline', stages: [cmd] };
  }

  /**
   * `coproc [NAME] command` / `coproc NAME { ...; }`.
   *
   * Disambiguation (bash): a NAME prefix is recognized ONLY when it is a valid
   * identifier AND is immediately followed by a COMPOUND command (`{`, `(`, or a
   * compound keyword). In every other case the word(s) after `coproc` ARE the
   * (simple) command and the array name defaults to `COPROC`.
   */
  private parseCoproc(): Statement {
    this.next(); // consume `coproc`
    let coprocName = 'COPROC';
    const headWord = this.peek();
    const next = this.at(1);
    if (
      headWord?.type === 'WORD'
      && isName(headWord.value)
      && !RESERVED.has(headWord.value)
      && next !== undefined
      && this.startsCompound(next)
    ) {
      coprocName = headWord.value;
      this.next(); // consume NAME
    }
    const coprocBody = this.parseCommand();
    return { type: 'Coproc', coprocName, coprocBody };
  }

  /** True if `t` begins a compound command (used by `coproc NAME compound`). */
  private startsCompound(t: Token): boolean {
    if (t.type === 'LPAREN' || t.type === 'DLPAREN' || t.type === 'DLBRACKET') return true;
    if (t.type === 'WORD') {
      return ['{', 'if', 'while', 'until', 'for', 'case', 'select'].includes(t.value);
    }
    return false;
  }

  private parseIf(): Statement {
    this.next();
    const condition = this.parseStatementListUntil(['then']);
    this.expectReserved('then');
    const thenBranch = this.parseStatementListUntil(['elif', 'else', 'fi']);
    let elseBranch: Statement[] | undefined;
    if (this.atReserved('elif')) {
      elseBranch = [this.parseElif()];
      return { type: 'If', condition, then: thenBranch, else: elseBranch };
    }
    if (this.atReserved('else')) { this.next(); elseBranch = this.parseStatementListUntil(['fi']); }
    this.expectReserved('fi');
    return { type: 'If', condition, then: thenBranch, else: elseBranch };
  }

  private parseElif(): Statement {
    this.next();
    const condition = this.parseStatementListUntil(['then']);
    this.expectReserved('then');
    const thenBranch = this.parseStatementListUntil(['elif', 'else', 'fi']);
    let elseBranch: Statement[] | undefined;
    if (this.atReserved('elif')) elseBranch = [this.parseElif()];
    else if (this.atReserved('else')) { this.next(); elseBranch = this.parseStatementListUntil(['fi']); }
    if (this.atReserved('fi')) this.next();
    return { type: 'If', condition, then: thenBranch, else: elseBranch };
  }

  private parseWhile(): Statement {
    const until = this.peek()!.value === 'until';
    this.next();
    const condition = this.parseStatementListUntil(['do']);
    this.expectReserved('do');
    const body = this.parseStatementListUntil(['done']);
    this.expectReserved('done');
    const stmt: Statement = { type: 'While', condition, body, until };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  private parseFor(): Statement {
    this.next(); // 'for'
    // C-style `for (( init; cond; incr ))` (M6). The lexer yields `((` as DLPAREN.
    if (this.atType('DLPAREN')) return this.parseArithFor();
    const v = this.next();
    if (v?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected for variable');
    let words: string[] | undefined;
    if (this.atReserved('in')) {
      this.next();
      words = [];
      while (this.peek() && !this.atType('SEMI') && !this.atType('NEWLINE') && !this.atReserved('do')) {
        words.push(this.next()!.raw);
      }
    }
    // consume separators up to 'do'
    while (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
    this.expectReserved('do');
    const body = this.parseStatementListUntil(['done']);
    this.expectReserved('done');
    const stmt: Statement = { type: 'For', varName: v.value, words, body };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  /**
   * C-style `for (( init; cond; incr )); do … done`. The lexer splits the inner
   * expression on `;` into SEMI tokens and the rest into WORDs; we reassemble
   * the three clauses by collecting tokens up to `))`, joining WORD `value`s.
   */
  private parseArithFor(): Statement {
    this.next(); // ((
    const clauses: string[] = [''];
    while (this.peek() && !this.atType('DRPAREN')) {
      if (this.atType('SEMI')) { clauses.push(''); this.next(); continue; }
      // `for ((;;))` tokenizes the empty middle as a single DSEMI (`;;`).
      if (this.atType('DSEMI')) { clauses.push(''); clauses.push(''); this.next(); continue; }
      const t = this.next()!;
      clauses[clauses.length - 1] += (clauses[clauses.length - 1] ? ' ' : '') + (t.value ?? t.raw);
    }
    if (this.atType('DRPAREN')) this.next();
    while (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
    this.expectReserved('do');
    const body = this.parseStatementListUntil(['done']);
    this.expectReserved('done');
    const stmt: Statement = {
      type: 'For', arithFor: true, body,
      arithInit: (clauses[0] ?? '').trim(),
      arithCond: (clauses[1] ?? '').trim(),
      arithIncr: (clauses[2] ?? '').trim(),
    };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  private parseSelect(): Statement {
    this.next(); // 'select'
    const v = this.next();
    if (v?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected select variable');
    let words: string[] | undefined;
    if (this.atReserved('in')) {
      this.next();
      words = [];
      while (this.peek() && !this.atType('SEMI') && !this.atType('NEWLINE') && !this.atReserved('do')) {
        words.push(this.next()!.raw);
      }
    }
    while (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
    this.expectReserved('do');
    const body = this.parseStatementListUntil(['done']);
    this.expectReserved('done');
    const stmt: Statement = { type: 'Select', varName: v.value, words, body };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  private parseCase(): Statement {
    this.next(); // 'case'
    const word = this.next();
    if (word?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected case word');
    this.expectReserved('in');
    this.skipNewlines();
    const clauses: CaseClause[] = [];
    while (this.peek() && !this.atReserved('esac')) {
      // optional leading (
      if (this.atType('LPAREN')) this.next();
      const patterns: string[] = [];
      patterns.push(this.next()!.raw);
      while (this.atType('PIPE')) { this.next(); patterns.push(this.next()!.raw); }
      if (!this.atType('RPAREN')) throw new SyntaxError('shell: syntax error: expected ) in case');
      this.next(); // )
      const body = this.parseStatementListUntil([], ['DSEMI', 'SEMIAMP', 'SEMISEMIAMP', 'esac-word']);
      const clause: CaseClause = { patterns, body };
      if (this.atType('SEMISEMIAMP')) { clause.continueMatch = true; this.next(); }
      else if (this.atType('SEMIAMP')) { clause.fallthrough = true; this.next(); }
      else if (this.atType('DSEMI')) this.next();
      clauses.push(clause);
      this.skipNewlines();
    }
    this.expectReserved('esac');
    return { type: 'Case', caseWord: word.raw, clauses };
  }

  private parseFunctionKw(): Statement {
    this.next(); // 'function'
    const name = this.next();
    if (name?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected function name');
    // optional ()
    if (this.atType('LPAREN')) { this.next(); if (this.atType('RPAREN')) this.next(); }
    this.skipNewlines();
    const body = this.parseBraceBody();
    return { type: 'Function', funcName: name.value, funcBody: body };
  }

  private parseFunctionParen(): Statement {
    const name = this.next()!; // WORD
    this.next(); // (
    this.next(); // )
    this.skipNewlines();
    const body = this.parseBraceBody();
    return { type: 'Function', funcName: name.value, funcBody: body };
  }

  private parseBraceBody(): Statement[] {
    this.expectReserved('{');
    const body = this.parseStatementListUntil(['}']);
    this.expectReserved('}');
    return body;
  }

  private parseGroup(): Statement {
    this.next(); // {
    const body = this.parseStatementListUntil(['}']);
    this.expectReserved('}');
    const stmt: Statement = { type: 'Group', body };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  private parseSubshell(): Statement {
    this.next(); // (
    const body: Statement[] = [];
    this.skipSeparators();
    while (this.peek() && !this.atType('RPAREN')) {
      body.push(this.parseAndOr());
      if (this.atType('SEMI') || this.atType('NEWLINE') || this.atType('AMP')) this.next();
      this.skipSeparators();
    }
    if (this.atType('RPAREN')) this.next();
    const stmt: Statement = { type: 'Subshell', body };
    this.attachTrailingRedirects(stmt);
    return stmt;
  }

  private parseArithCmd(): Statement {
    this.next(); // ((
    const words: string[] = [];
    while (this.peek() && !this.atType('DRPAREN')) words.push(this.next()!.value);
    if (this.atType('DRPAREN')) this.next();
    return { type: 'Arithmetic', expr: words.join(' ') };
  }

  private parseCond(): Statement {
    this.next(); // [[
    const words: string[] = [];
    while (this.peek() && !this.atType('DRBRACKET')) words.push(this.next()!.raw);
    if (this.atType('DRBRACKET')) this.next();
    return { type: 'Cond', condWords: words };
  }

  private expectReserved(word: string): void {
    if (!this.atReserved(word)) {
      const got = this.peek()?.value ?? 'end of input';
      throw new SyntaxError(`shell: syntax error: expected '${word}' but got '${got}'`);
    }
    this.next();
  }

  /** Parse a statement list until a head reserved word in `stops` (or a stop token). */
  private parseStatementListUntil(stops: string[], stopTokens: string[] = []): Statement[] {
    const list: Statement[] = [];
    this.skipSeparators();
    while (this.peek() && !this.atAnyReserved(stops) && !this.atStopToken(stopTokens)) {
      list.push(this.parseAndOr());
      if (this.atType('SEMI') || this.atType('NEWLINE') || this.atType('AMP')) this.next();
      this.skipSeparators();
      if (this.atStopToken(stopTokens)) break;
    }
    return list;
  }

  private atStopToken(stopTokens: string[]): boolean {
    if (stopTokens.includes('DSEMI') && this.atType('DSEMI')) return true;
    if (stopTokens.includes('SEMIAMP') && this.atType('SEMIAMP')) return true;
    if (stopTokens.includes('SEMISEMIAMP') && this.atType('SEMISEMIAMP')) return true;
    if (stopTokens.includes('esac-word') && this.atReserved('esac')) return true;
    return false;
  }

  private parseSimpleCommand(): SimpleCommand {
    const assignments: Assignment[] = [];
    const args: string[] = [];
    const redirects: Redirect[] = [];
    let name = '';
    let nameSet = false;

    while (this.atType('WORD') && !nameSet && isAssignment(this.peek()!.value)) {
      assignments.push(this.parseAssignmentWord());
    }

    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'WORD') {
        if (RESERVED.has(t.value) && !nameSet) break;
        if (!nameSet) { name = t.raw; nameSet = true; } else args.push(t.raw);
        this.next();
        continue;
      }
      if (this.isRedirectToken(t.type)) { redirects.push(this.parseRedirect()); continue; }
      break;
    }

    return { type: 'SimpleCommand', name, args, redirects, assignments };
  }

  /**
   * Parse an assignment prefix word. Handles scalar (`x=v`), append (`x+=v`),
   * element (`a[i]=v`, `a[i]+=v`), and array-literal (`a=(w1 w2)`, `a+=(w)`)
   * forms. The leading `(` of an array literal is a separate LPAREN token, so on
   * `name=`/`name+=` immediately followed by LPAREN we consume the parenthesized
   * word list as the array elements.
   */
  private parseAssignmentWord(): Assignment {
    const word = this.next()!;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[([^\]]*)\])?(\+?)=(.*)$/s.exec(word.raw);
    if (!m) {
      // Shouldn't happen (isAssignment gated), but degrade gracefully.
      const eq = word.value.indexOf('=');
      return { name: word.value.slice(0, eq), value: word.raw.slice(word.raw.indexOf('=') + 1) };
    }
    const name = m[1];
    const index = m[3];
    const append = m[4] === '+';
    const rhs = m[5];
    // Array literal: `name=(` — the value text after `=` is empty and the next
    // token is `(`. Collect the word list up to the matching `)`.
    if (rhs === '' && index === undefined && this.atType('LPAREN')) {
      if (this.posix) this.posixReject('arrays');
      this.next(); // (
      const elems: string[] = [];
      while (this.peek() && !this.atType('RPAREN')) {
        // Word list may span newlines inside the parens.
        if (this.atType('NEWLINE')) { this.next(); continue; }
        const t = this.next()!;
        elems.push(t.raw);
      }
      if (this.atType('RPAREN')) this.next();
      const arr: Assignment = { name, value: '', array: elems };
      if (append) arr.append = true;
      return arr;
    }
    const out: Assignment = { name, value: rhs };
    if (index !== undefined) out.index = index;
    if (append) out.append = true;
    return out;
  }

  private isRedirectToken(type: TokenType): boolean {
    return type === 'GREAT' || type === 'GREATGREAT' || type === 'GREATPIPE' || type === 'LESS'
      || type === 'LESSGREAT' || type === 'LESSLESS' || type === 'LESSLESSDASH' || type === 'LESSLESSLESS'
      || type === 'GREATAMP' || type === 'LESSAMP' || type === 'AMPGREAT' || type === 'AMPGREATGREAT';
  }

  private attachTrailingRedirects(stmt: Statement): void {
    const redirects: Redirect[] = [];
    while (this.peek() && this.isRedirectToken(this.peek()!.type)) {
      redirects.push(this.parseRedirect());
    }
    if (redirects.length) stmt.redirects = redirects;
  }

  private parseRedirect(): Redirect {
    const opTok = this.next()!;
    const fd = opTok.fd;
    switch (opTok.type) {
      case 'GREAT': return this.targetRedirect('>', fd);
      case 'GREATPIPE': return this.targetRedirect('>|', fd);
      case 'GREATGREAT': return this.targetRedirect('>>', fd);
      case 'LESS': return this.targetRedirect('<', fd);
      case 'LESSGREAT': return this.targetRedirect('<>', fd);
      case 'LESSLESSLESS': return this.hereString();
      case 'LESSLESS': return this.hereDocRedirect(false);
      case 'LESSLESSDASH': return this.hereDocRedirect(true);
      case 'GREATAMP': return this.dupRedirect('>&', fd);
      case 'LESSAMP': return this.dupRedirect('<&', fd);
      case 'AMPGREAT': return this.targetRedirect('&>', fd);
      case 'AMPGREATGREAT': return this.targetRedirect('&>>', fd);
      default: throw new SyntaxError('shell: syntax error: bad redirect');
    }
  }

  private targetRedirect(op: RedirectOp, fd?: number): Redirect {
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected redirect target');
    this.next();
    return { op, fd, target: target.raw };
  }

  private dupRedirect(op: RedirectOp, fd?: number): Redirect {
    // `2>&1` — the target is the destination fd word (e.g. `1`) or `-` to close.
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected dup target');
    this.next();
    return { op, fd, target: target.value };
  }

  private hereString(): Redirect {
    if (this.posix) this.posixReject('<<< here-string');
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected here-string word');
    this.next();
    return { op: '<<<', target: target.raw };
  }

  private hereDocRedirect(strip: boolean): Redirect {
    const delim = this.peek();
    if (delim?.type !== 'WORD') throw new SyntaxError('shell: syntax error: expected here-doc delimiter');
    this.next();
    // The delimiter word encodes a here-doc id (assigned during extraction).
    const id = parseInt(delim.value.replace(/^__HEREDOC_(\d+)__$/, '$1'), 10);
    const hd = this.heredocs.get(id);
    let body = hd?.body ?? '';
    if (strip) body = body.split('\n').map((l) => l.replace(/^\t+/, '')).join('\n');
    return { op: '<<', target: '', hereDoc: body, hereDocQuoted: hd?.quoted };
  }
}

function isAssignment(word: string): boolean {
  // Scalar `x=`, append `x+=`, element `a[i]=` / `a[i]+=` (array literal `a=(…)`
  // also starts with `a=`/`a+=` and is detected via the trailing LPAREN token).
  return /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word);
}

function isName(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word);
}

/**
 * Pull here-doc bodies out of the raw source, replacing each `<<DELIM` operand
 * with a synthetic token `__HEREDOC_N__` and stripping the body lines so the
 * tokenizer sees a flat single statement.
 */
function extractHereDocs(input: string): { src: string; heredocs: Map<number, HereDoc> } {
  const heredocs = new Map<number, HereDoc>();
  const lines = input.split('\n');
  const out: string[] = [];
  let id = 0;
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // `<<` or `<<-`, but NOT `<<<` (here-string). The lookbehind/lookahead pair
    // ensures we match a real here-doc `<<` and never the inner `<<` of a `<<<`
    // here-string (which would leave a stray `<` and a bogus heredoc delimiter).
    const re = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    const pending: Array<{ delim: string; quoted: boolean; strip: boolean; hid: number }> = [];
    line = line.replace(re, (full, q, delim) => {
      const strip = full.startsWith('<<-');
      const hid = id++;
      pending.push({ delim, quoted: q !== '', strip, hid });
      const op = strip ? '<<-' : '<<';
      return `${op} __HEREDOC_${hid}__`;
    });
    out.push(line);
    // Collect bodies for each pending here-doc, in order.
    for (const p of pending) {
      const bodyLines: string[] = [];
      let consumed = 0; // body lines + the terminator line, removed from `out`
      while (li + 1 < lines.length) {
        li++;
        consumed++;
        const bl = lines[li];
        const cmp = p.strip ? bl.replace(/^\t+/, '') : bl;
        if (cmp === p.delim) break;
        bodyLines.push(bl);
      }
      heredocs.set(p.hid, { id: p.hid, body: bodyLines.length ? bodyLines.join('\n') + '\n' : '', quoted: p.quoted });
      // Preserve source line numbers for $LINENO: the body+terminator lines were
      // pulled out of the token stream, so emit blank placeholders to keep every
      // later line's number aligned with the original source. Blank lines tokenize
      // to NEWLINE only, so parsing is unaffected.
      for (let k = 0; k < consumed; k++) out.push('');
    }
  }
  return { src: out.join('\n'), heredocs };
}

export function parse(input: string, options: ParseOptions = {}): Program {
  const { src, heredocs } = extractHereDocs(input);
  return new Parser(tokenize(src), heredocs, options).parseProgram();
}
