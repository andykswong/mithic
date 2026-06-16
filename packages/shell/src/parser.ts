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
  'for', 'in', 'case', 'esac', 'function',
  '{', '}', '!',
]);

interface HereDoc { id: number; body: string; quoted: boolean; }

class Parser {
  private tokens: Token[];
  private pos = 0;
  private heredocs: Map<number, HereDoc>;

  constructor(tokens: Token[], heredocs: Map<number, HereDoc>) {
    this.tokens = tokens;
    this.heredocs = heredocs;
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
      && !['if', 'while', 'until', 'for', 'case', 'function', '{', '!'].includes(t.value)) {
      return true;
    }
    if (t.type === 'RPAREN' || t.type === 'DSEMI' || t.type === 'DRPAREN') return true;
    return false;
  }

  private parseAndOr(): Statement {
    let left = this.parsePipeline();
    for (;;) {
      if (this.atType('AND_IF') || this.atType('OR_IF')) {
        const op = this.next()!.type === 'AND_IF' ? 'And' : 'Or';
        this.skipNewlines();
        const right = this.parsePipeline();
        left = { type: op, left, right };
      } else break;
    }
    return left;
  }

  private parsePipeline(): Statement {
    let negate = false;
    if (this.atReserved('!')) { this.next(); negate = true; }

    const first = this.parseCommand();
    if (!this.atType('PIPE')) {
      if (negate) first.negate = true;
      this.maybeBackground(first);
      return first;
    }
    // Build a Pipeline of simple commands. Compound stages are uncommon; we
    // support simple-command pipelines (the common case).
    const stages: SimpleCommand[] = [];
    if (first.type === 'Pipeline' && first.stages) stages.push(...first.stages);
    else if (first.type === 'Pipeline') { /* empty */ }
    else throw new SyntaxError('shell: compound command in pipeline not supported');
    while (this.atType('PIPE')) {
      this.next();
      this.skipNewlines();
      const stage = this.parseCommand();
      if (stage.type === 'Pipeline' && stage.stages) stages.push(...stage.stages);
      else throw new SyntaxError('shell: compound command in pipeline not supported');
    }
    const pipeline: Statement = { type: 'Pipeline', stages, negate };
    this.maybeBackground(pipeline);
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
    if (this.atType('DLPAREN')) return this.parseArithCmd();
    if (this.atType('DLBRACKET')) return this.parseCond();

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
    const v = this.next();
    if (v?.type !== 'WORD') throw new SyntaxError('shell: expected for variable');
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

  private parseCase(): Statement {
    this.next(); // 'case'
    const word = this.next();
    if (word?.type !== 'WORD') throw new SyntaxError('shell: expected case word');
    this.expectReserved('in');
    this.skipNewlines();
    const clauses: CaseClause[] = [];
    while (this.peek() && !this.atReserved('esac')) {
      // optional leading (
      if (this.atType('LPAREN')) this.next();
      const patterns: string[] = [];
      patterns.push(this.next()!.raw);
      while (this.atType('PIPE')) { this.next(); patterns.push(this.next()!.raw); }
      if (!this.atType('RPAREN')) throw new SyntaxError('shell: expected ) in case');
      this.next(); // )
      const body = this.parseStatementListUntil([], ['DSEMI', 'esac-word']);
      clauses.push({ patterns, body });
      if (this.atType('DSEMI')) this.next();
      this.skipNewlines();
    }
    this.expectReserved('esac');
    return { type: 'Case', caseWord: word.raw, clauses };
  }

  private parseFunctionKw(): Statement {
    this.next(); // 'function'
    const name = this.next();
    if (name?.type !== 'WORD') throw new SyntaxError('shell: expected function name');
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
    if (!this.atReserved(word)) throw new SyntaxError(`shell: expected '${word}'`);
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
      const word = this.next()!;
      const eq = word.value.indexOf('=');
      assignments.push({ name: word.value.slice(0, eq), value: word.raw.slice(word.raw.indexOf('=') + 1) });
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

  private isRedirectToken(type: TokenType): boolean {
    return type === 'GREAT' || type === 'GREATGREAT' || type === 'LESS'
      || type === 'LESSLESS' || type === 'LESSLESSDASH' || type === 'LESSLESSLESS'
      || type === 'GREATAMP' || type === 'AMPGREAT' || type === 'AMPGREATGREAT';
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
      case 'GREATGREAT': return this.targetRedirect('>>', fd);
      case 'LESS': return this.targetRedirect('<', fd);
      case 'LESSLESSLESS': return this.hereString();
      case 'LESSLESS': return this.hereDocRedirect(false);
      case 'LESSLESSDASH': return this.hereDocRedirect(true);
      case 'GREATAMP': return this.dupRedirect('>&', fd);
      case 'AMPGREAT': return this.targetRedirect('&>', fd);
      case 'AMPGREATGREAT': { const r = this.targetRedirect('&>', fd); r.op = '&>'; return r; }
      default: throw new SyntaxError('shell: bad redirect');
    }
  }

  private targetRedirect(op: RedirectOp, fd?: number): Redirect {
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: expected redirect target');
    this.next();
    return { op, fd, target: target.raw };
  }

  private dupRedirect(op: RedirectOp, fd?: number): Redirect {
    // `2>&1` — the target is the destination fd word (e.g. `1`) or `-` to close.
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: expected dup target');
    this.next();
    return { op, fd, target: target.value };
  }

  private hereString(): Redirect {
    const target = this.peek();
    if (target?.type !== 'WORD') throw new SyntaxError('shell: expected here-string word');
    this.next();
    return { op: '<<<', target: target.raw };
  }

  private hereDocRedirect(strip: boolean): Redirect {
    const delim = this.peek();
    if (delim?.type !== 'WORD') throw new SyntaxError('shell: expected here-doc delimiter');
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
  const eq = word.indexOf('=');
  if (eq <= 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq));
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
      while (li + 1 < lines.length) {
        li++;
        const bl = lines[li];
        const cmp = p.strip ? bl.replace(/^\t+/, '') : bl;
        if (cmp === p.delim) break;
        bodyLines.push(bl);
      }
      heredocs.set(p.hid, { id: p.hid, body: bodyLines.length ? bodyLines.join('\n') + '\n' : '', quoted: p.quoted });
    }
  }
  return { src: out.join('\n'), heredocs };
}

export function parse(input: string): Program {
  const { src, heredocs } = extractHereDocs(input);
  return new Parser(tokenize(src), heredocs).parseProgram();
}
