import { tokenize } from './lexer.ts';
import type { Token, TokenType } from './lexer.ts';
import type {
  Assignment,
  Program,
  Redirect,
  RedirectOp,
  SimpleCommand,
  Statement,
} from './ast.ts';

/**
 * Recursive-descent parser for the minimal shell grammar.
 *
 *   program     := list
 *   list        := and_or ( (';' | '&' | NEWLINE) and_or )*
 *   and_or      := pipeline ( ('&&' | '||') pipeline )*
 *   pipeline    := command ( '|' command )*
 *   command     := compound | simple
 *   compound    := if | while
 *   simple      := (assignment)* (word | redirect)*
 *
 * Words carry their raw (quote-preserving) source; expansion happens later.
 */

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done']);

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private atType(type: TokenType): boolean {
    return this.peek()?.type === type;
  }

  private atReserved(word: string): boolean {
    const t = this.peek();
    return t?.type === 'WORD' && t.value === word;
  }

  /** Skip statement separators (`;`, `&` handled by caller, NEWLINE). */
  private skipSeparators(): void {
    while (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
  }

  parseProgram(): Program {
    const body: Statement[] = [];
    this.skipSeparators();
    while (this.peek() && !this.atTerminator()) {
      body.push(this.parseAndOr());
      // Consume one trailing separator (`;`, `&`, NEWLINE) if present.
      if (this.atType('SEMI') || this.atType('NEWLINE')) {
        this.next();
      }
      this.skipSeparators();
    }
    return { type: 'Program', body };
  }

  /** True at tokens that terminate a nested statement list (then/fi/done/…). */
  private atTerminator(): boolean {
    const t = this.peek();
    if (!t) return true;
    if (t.type === 'WORD' && RESERVED.has(t.value) && t.value !== 'if' && t.value !== 'while' && t.value !== 'until') {
      return true;
    }
    if (t.type === 'RPAREN') return true;
    return false;
  }

  private parseAndOr(): Statement {
    let left = this.parsePipeline();
    for (;;) {
      if (this.atType('AND_IF') || this.atType('OR_IF')) {
        const op = this.next()!.type === 'AND_IF' ? 'And' : 'Or';
        this.skipNewlines();
        const right = this.parsePipeline();
        left = { type: op, stages: [], left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private skipNewlines(): void {
    while (this.atType('NEWLINE')) this.next();
  }

  private parsePipeline(): Statement {
    // A pipeline stage may itself be a compound command (if/while).
    if (this.atReserved('if')) return this.parseIf();
    if (this.atReserved('while') || this.atReserved('until')) return this.parseWhile();

    const stages: SimpleCommand[] = [this.parseSimpleCommand()];
    while (this.atType('PIPE')) {
      this.next();
      this.skipNewlines();
      stages.push(this.parseSimpleCommand());
    }
    const pipeline: Statement = { type: 'Pipeline', stages };
    if (this.atType('AMP')) {
      this.next();
      pipeline.background = true;
    }
    return pipeline;
  }

  private parseIf(): Statement {
    this.next(); // 'if'
    const condition = this.parseStatementListUntil(['then']);
    this.expectReserved('then');
    const thenBranch = this.parseStatementListUntil(['elif', 'else', 'fi']);
    let elseBranch: Statement[] | undefined;
    if (this.atReserved('elif')) {
      // elif chains into a nested If as the else-branch.
      elseBranch = [this.parseElif()];
      return { type: 'If', stages: [], condition, then: thenBranch, else: elseBranch };
    }
    if (this.atReserved('else')) {
      this.next();
      elseBranch = this.parseStatementListUntil(['fi']);
    }
    this.expectReserved('fi');
    return { type: 'If', stages: [], condition, then: thenBranch, else: elseBranch };
  }

  private parseElif(): Statement {
    this.next(); // 'elif'
    const condition = this.parseStatementListUntil(['then']);
    this.expectReserved('then');
    const thenBranch = this.parseStatementListUntil(['elif', 'else', 'fi']);
    let elseBranch: Statement[] | undefined;
    if (this.atReserved('elif')) {
      elseBranch = [this.parseElif()];
    } else if (this.atReserved('else')) {
      this.next();
      elseBranch = this.parseStatementListUntil(['fi']);
    }
    if (this.atReserved('fi')) this.next();
    return { type: 'If', stages: [], condition, then: thenBranch, else: elseBranch };
  }

  private parseWhile(): Statement {
    const until = this.peek()!.value === 'until';
    this.next(); // 'while' | 'until'
    const condition = this.parseStatementListUntil(['do']);
    this.expectReserved('do');
    const body = this.parseStatementListUntil(['done']);
    this.expectReserved('done');
    return { type: 'While', stages: [], condition, body, until };
  }

  private expectReserved(word: string): void {
    if (!this.atReserved(word)) {
      throw new SyntaxError(`shell: expected '${word}'`);
    }
    this.next();
  }

  /** Parse a `;`/newline-separated statement list until one of `stops` is the head. */
  private parseStatementListUntil(stops: string[]): Statement[] {
    const list: Statement[] = [];
    this.skipSeparators();
    while (this.peek() && !this.atAnyReserved(stops)) {
      list.push(this.parseAndOr());
      if (this.atType('SEMI') || this.atType('NEWLINE')) this.next();
      this.skipSeparators();
    }
    return list;
  }

  private atAnyReserved(words: string[]): boolean {
    const t = this.peek();
    if (t?.type !== 'WORD') return false;
    return words.includes(t.value);
  }

  private parseSimpleCommand(): SimpleCommand {
    const assignments: Assignment[] = [];
    const args: string[] = [];
    const redirects: Redirect[] = [];
    let name = '';
    let nameSet = false;

    // Leading assignments (NAME=value) only valid before the command word.
    while (this.atType('WORD') && !nameSet && isAssignment(this.peek()!.value)) {
      const eq = this.peek()!.value.indexOf('=');
      const word = this.next()!;
      assignments.push({ name: word.value.slice(0, eq), value: word.value.slice(eq + 1) });
    }

    for (;;) {
      const t = this.peek();
      if (!t) break;
      if (t.type === 'WORD') {
        if (RESERVED.has(t.value) && !nameSet) break; // reserved word terminates here
        if (!nameSet) {
          name = t.raw;
          nameSet = true;
        } else {
          args.push(t.raw);
        }
        this.next();
        continue;
      }
      if (t.type === 'GREAT' || t.type === 'GREATGREAT' || t.type === 'LESS') {
        redirects.push(this.parseRedirect());
        continue;
      }
      break;
    }

    return { type: 'SimpleCommand', name, args, redirects, assignments };
  }

  private parseRedirect(): Redirect {
    const opTok = this.next()!;
    const op: RedirectOp = opTok.type === 'GREATGREAT' ? '>>' : opTok.type === 'LESS' ? '<' : '>';
    const target = this.peek();
    if (target?.type !== 'WORD') {
      throw new SyntaxError('shell: expected redirect target');
    }
    this.next();
    return { op, target: target.raw };
  }
}

function isAssignment(word: string): boolean {
  const eq = word.indexOf('=');
  if (eq <= 0) return false;
  const name = word.slice(0, eq);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function parse(input: string): Program {
  return new Parser(tokenize(input)).parseProgram();
}
