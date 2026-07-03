/**
 * `expr` — evaluate expressions.
 *
 * Supports arithmetic (+, -, *, /, %), comparison (= != < <= > >=),
 * logic (| &), string ops (length, substr, index), and match/regex.
 *
 * Grammar (lowest to highest precedence):
 *   expr: or-expr
 *   or-expr: and-expr ( '|' and-expr )*
 *   and-expr: cmp-expr ( '&' cmp-expr )*
 *   cmp-expr: add-expr ( ('='|'!='|'<'|'<='|'>'|'>=') add-expr )*
 *   add-expr: mul-expr ( ('+'|'-') mul-expr )*
 *   mul-expr: unary-expr ( ('*'|'/'|'%') unary-expr )*
 *   unary-expr: '(' expr ')' | STRING
 *
 * Returns: exit code 0 if result is non-null/non-zero/non-empty, 1 otherwise.
 */
import { defineCommand, writeLine, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type Value = string | number;

/** A syntax/usage error in an expr expression — GNU exits 2 for these. */
class ExprSyntaxError extends Error {}
/** A non-integer operand to an arithmetic operator — GNU exits 2. */
class ExprArithError extends Error {
  constructor() { super('non-integer argument'); }
}

function isZero(v: Value): boolean {
  if (typeof v === 'number') return v === 0;
  return v === '' || v === '0';
}

/**
 * Coerce an operand to an integer for arithmetic. GNU `expr` only does INTEGER
 * arithmetic: a float (`1.5`) or a non-numeric string (`abc`) is a fatal
 * `non-integer argument` error (exit 2), NOT a silent truncation to 0.
 */
function toInt(v: Value): number {
  if (typeof v === 'number') return v;
  if (/^[+-]?\d+$/.test(v)) return parseInt(v, 10);
  throw new ExprArithError();
}

class ExprParser {
  tokens: string[];
  pos: number;

  constructor(tokens: string[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(): string | undefined { return this.tokens[this.pos]; }
  consume(): string { return this.tokens[this.pos++] ?? ''; }

  parse(): Value { return this.parseOr(); }

  parseOr(): Value {
    let left = this.parseAnd();
    while (this.peek() === '|') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseAnd();
      // | returns left if left is non-zero/non-empty, else right
      left = (!isZero(left)) ? left : right;
    }
    return left;
  }

  parseAnd(): Value {
    let left = this.parseCmp();
    while (this.peek() === '&') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseCmp();
      // & returns left if both non-zero, else 0
      left = (!isZero(left) && !isZero(right)) ? left : 0;
    }
    return left;
  }

  parseCmp(): Value {
    let left = this.parseAdd();
    const ops = new Set(['=', '!=', '<', '<=', '>', '>=']);
    while (this.peek() !== undefined && ops.has(this.peek()!)) {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseAdd();
      const ls = String(left), rs = String(right);
      const ln = parseFloat(ls), rn = parseFloat(rs);
      const bothNum = !isNaN(ln) && !isNaN(rn);
      let res: boolean;
      if (bothNum) {
        if (op === '=') res = ln === rn;
        else if (op === '!=') res = ln !== rn;
        else if (op === '<') res = ln < rn;
        else if (op === '<=') res = ln <= rn;
        else if (op === '>') res = ln > rn;
        else res = ln >= rn;
      } else {
        if (op === '=') res = ls === rs;
        else if (op === '!=') res = ls !== rs;
        else if (op === '<') res = ls < rs;
        else if (op === '<=') res = ls <= rs;
        else if (op === '>') res = ls > rs;
        else res = ls >= rs;
      }
      left = res ? 1 : 0;
    }
    return left;
  }

  parseAdd(): Value {
    let left = this.parseMul();
    while (this.peek() === '+' || this.peek() === '-') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseMul();
      left = op === '+' ? toInt(left) + toInt(right) : toInt(left) - toInt(right);
    }
    return left;
  }

  parseMul(): Value {
    let left = this.parseUnary();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseUnary();
      const l = toInt(left), r = toInt(right);
      if ((op === '/' || op === '%') && r === 0) throw new Error('division by zero');
      if (op === '*') left = l * r;
      else if (op === '/') left = Math.trunc(l / r);
      else left = l % r;
    }
    return left;
  }

  parseUnary(): Value {
    if (this.peek() === '(') {
      this.consume();
      const v = this.parse();
      const last = this.tokens[this.pos - 1];
      if (this.consume() !== ')') throw new ExprSyntaxError(`syntax error: expecting ')' after ‘${last ?? ''}’`);
      return v;
    }
    // Built-in string functions
    const t = this.peek();
    if (t === 'length') {
      this.consume();
      const s = String(this.parseUnary());
      return s.length;
    }
    if (t === 'substr') {
      this.consume();
      const s = String(this.parseUnary());
      const pos = toInt(this.parseUnary());
      const len = toInt(this.parseUnary());
      // GNU expr: 1-based; a POS < 1, LEN <= 0, or POS past the end → empty
      // string (which makes expr exit 1).
      if (pos < 1 || len < 1 || pos > s.length) return '';
      return s.substr(pos - 1, len);
    }
    if (t === 'index') {
      this.consume();
      const s = String(this.parseUnary());
      const chars = String(this.parseUnary());
      // Return position (1-based) of first char in chars found in s, or 0
      for (let i = 0; i < s.length; i++) {
        if (chars.includes(s[i])) return i + 1;
      }
      return 0;
    }
    if (t === 'match') {
      this.consume();
      const s = String(this.parseUnary());
      const pat = String(this.parseUnary());
      const re = new RegExp('^(?:' + pat + ')');
      const m = re.exec(s);
      return m ? m[0].length : 0;
    }
    // POSIX `+` quote operator: in operand position, `+ TOKEN` forces TOKEN to
    // be a plain string operand (so `+ length` yields "length", `3 + + 4` = 7).
    // A trailing `+` with no operand is a syntax error.
    if (t === '+') {
      this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError('syntax error: missing argument after ‘+’');
      return this.consume();
    }
    const tok = this.peek();
    if (tok === undefined) throw new ExprSyntaxError('syntax error: missing operand');
    return this.consume();
  }
}

const exprCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'expr';
  const tokens = io.args.slice(1);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (tokens.length === 0) {
      return await exitWith(err, 2, `${name}: missing operand`);
    }
    let result: Value;
    try {
      result = new ExprParser(tokens).parse();
    } catch (e) {
      return await exitWith(err, 2, `${name}: ${(e as Error).message}`);
    }
    await writeLine(out, String(result));
    return isZero(result) ? 1 : 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(exprCommand);
export { exprCommand };
