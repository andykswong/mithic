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
 *   mul-expr: match-expr ( ('*'|'/'|'%') match-expr )*
 *   match-expr: unary-expr ( ':' unary-expr )*
 *   unary-expr: '(' expr ')' | STRING
 *
 * Integer arithmetic is exact (BigInt), matching GNU's GMP bignums.
 *
 * Returns: exit code 0 if result is non-null/non-zero/non-empty, 1 otherwise.
 */
import { defineCommand, writeLine, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

type Value = string | bigint;

/** GNU expr treats an operand as a number only if it is `-?[0-9]+` (a leading `+`
 *  is NOT part of an integer). */
const INT_RE = /^-?\d+$/;

/** A syntax/usage error in an expr expression — GNU exits 2 for these. */
class ExprSyntaxError extends Error {}
/** A non-integer operand to an arithmetic operator — GNU exits 2. */
class ExprArithError extends Error {
  constructor() { super('non-integer argument'); }
}

function isZero(v: Value): boolean {
  if (typeof v === 'bigint') return v === 0n;
  return v === '' || v === '0';
}

/**
 * Coerce an operand to an integer for arithmetic. GNU `expr` only does INTEGER
 * arithmetic: a float (`1.5`) or a non-numeric string (`abc`) is a fatal
 * `non-integer argument` error (exit 2), NOT a silent truncation to 0. BigInt is
 * used so operands/results past 2^53 stay exact (GNU uses GMP bignums).
 */
function toInt(v: Value): bigint {
  if (typeof v === 'bigint') return v;
  if (INT_RE.test(v)) return BigInt(v);
  throw new ExprArithError();
}

/** A small non-negative integer index (for `substr`), clamped from a BigInt. */
function toIndex(v: Value): number {
  const n = toInt(v);
  return Number(n);
}

/**
 * Translate a POSIX Basic Regular Expression (BRE — what GNU `expr` uses) into an
 * equivalent JS RegExp source. In a BRE the special forms are the BACKSLASHED
 * ones: `\(` `\)` group, `\{` `\}` interval, `\+` `\?` `\|` (GNU extensions);
 * the bare `+ ? | ( ) { }` are LITERAL characters. This is the inverse of a JS
 * (extended) regex, so we swap which of each pair is escaped. Character classes
 * `[...]` are copied verbatim (their contents are already the same in both).
 */
/** JS regex fragments for the POSIX character classes usable inside `[[:class:]]`. */
const POSIX_CLASS: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

/**
 * Copy a BRE bracket expression starting at `[` (index `i`) into JS regex source,
 * translating any `[[:class:]]` POSIX classes (which JS does not support) into
 * their equivalent ranges. Ordinary ranges (`[a-z]`) pass through unchanged.
 * Returns the JS source and the index of the closing `]`.
 */
function translateBracket(bre: string, i: number): [string, number] {
  let cls = '[';
  let j = i + 1;
  if (bre[j] === '^') { cls += '^'; j++; }
  if (bre[j] === ']') { cls += ']'; j++; } // a leading ] is a literal member
  while (j < bre.length && bre[j] !== ']') {
    if (bre[j] === '[' && bre[j + 1] === ':') {
      const end = bre.indexOf(':]', j + 2);
      if (end !== -1) {
        const name = bre.slice(j + 2, end);
        if (POSIX_CLASS[name] !== undefined) { cls += POSIX_CLASS[name]; j = end + 2; continue; }
      }
    }
    cls += bre[j]; j++;
  }
  cls += ']';
  return [cls, j];
}

function breToJs(bre: string): string {
  let out = '';
  for (let i = 0; i < bre.length; i++) {
    const c = bre[i];
    if (c === '\\') {
      const n = bre[i + 1];
      if (n === undefined) { out += '\\\\'; break; }
      // Backslashed metacharacters in BRE map to bare metacharacters in JS.
      if (n === '(' || n === ')' || n === '{' || n === '}' || n === '+' || n === '?' || n === '|') {
        out += n;
      } else if (/[1-9]/.test(n) || '.*[]^$\\'.includes(n) || 'wWsSbB'.includes(n)) {
        // \1..\9 backrefs, escaped BRE metacharacters, and the glibc-BRE regex
        // operators \w \W \s \S \b \B (word/space/boundary) — keep the escape
        // as-is (JS RegExp understands these identically).
        out += '\\' + n;
      } else {
        // \<ordinary> in a BRE is the LITERAL ordinary char (glibc: `\t` == `t`),
        // NOT a JS control escape. Emit the char, escaped only if JS-special.
        out += /[a-zA-Z0-9]/.test(n) ? n : '\\' + n;
      }
      i++;
    } else if (c === '(' || c === ')' || c === '{' || c === '}' || c === '+' || c === '?' || c === '|') {
      // Bare metacharacter in BRE is a LITERAL → escape it for JS.
      out += '\\' + c;
    } else if (c === '[') {
      const [cls, j] = translateBracket(bre, i);
      out += cls;
      i = j;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * GNU expr's anchored (implicit leading `^`) BRE match. Returns the captured
 * `\(...\)` substring when the pattern has a group (empty string on no match),
 * else the number of characters matched (0 on no match).
 */
function anchoredMatch(s: string, pat: string): Value {
  const hasGroup = /\\\(/.test(pat);
  let re: RegExp;
  try { re = new RegExp('^(?:' + breToJs(pat) + ')'); }
  catch { throw new ExprSyntaxError('Invalid regular expression'); }
  const m = re.exec(s);
  if (hasGroup) return m && m[1] !== undefined ? m[1] : '';
  return m ? BigInt(m[0].length) : 0n;
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
      left = (!isZero(left) && !isZero(right)) ? left : 0n;
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
      // GNU compares numerically (exact, arbitrary precision) only when BOTH
      // operands are signed decimal INTEGERS; anything else (floats, words) is a
      // byte-wise string comparison.
      const bothInt = INT_RE.test(ls) && INT_RE.test(rs);
      let res: boolean;
      if (bothInt) {
        const ln = BigInt(ls), rn = BigInt(rs);
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
      left = res ? 1n : 0n;
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
    let left = this.parseMatch();
    while (this.peek() === '*' || this.peek() === '/' || this.peek() === '%') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseMatch();
      const l = toInt(left), r = toInt(right);
      if ((op === '/' || op === '%') && r === 0n) throw new Error('division by zero');
      // BigInt `/` and `%` already truncate toward zero, matching C/GNU.
      if (op === '*') left = l * r;
      else if (op === '/') left = l / r;
      else left = l % r;
    }
    return left;
  }

  /**
   * The `:` (anchored-regex match) operator — GNU's most common expr idiom, e.g.
   * `expr "$s" : '.*'`. It has higher precedence than `* / %`. With no `\(...\)`
   * capture the result is the number of leading characters matched (0 on no
   * match); with a capture group it is the captured substring (empty on no
   * match). It shares GNU's `match` semantics exactly.
   */
  parseMatch(): Value {
    let left = this.parseUnary();
    while (this.peek() === ':') {
      const op = this.consume();
      if (this.peek() === undefined) throw new ExprSyntaxError(`syntax error: missing argument after ‘${op}’`);
      const right = this.parseUnary();
      left = anchoredMatch(String(left), String(right));
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
      return BigInt(s.length);
    }
    if (t === 'substr') {
      this.consume();
      const s = String(this.parseUnary());
      const pos = toIndex(this.parseUnary());
      const len = toIndex(this.parseUnary());
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
        if (chars.includes(s[i])) return BigInt(i + 1);
      }
      return 0n;
    }
    if (t === 'match') {
      // `match S REGEX` is the prefix-function synonym of the infix `S : REGEX`.
      this.consume();
      const s = String(this.parseUnary());
      const pat = String(this.parseUnary());
      return anchoredMatch(s, pat);
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
