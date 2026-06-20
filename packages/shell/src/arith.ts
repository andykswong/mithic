/**
 * POSIX/bash arithmetic evaluator for `$(( ... ))` and `(( ... ))`.
 *
 * Integer-only (bash semantics): division truncates toward zero, results are
 * 64-bit-ish JS numbers. Supports the full operator set including assignment
 * (`=`, `+=` …), pre/post increment, ternary, comma, bitwise, shifts, logical,
 * and comparisons. Variable references read/write the supplied `env` (bare
 * names and `$name` both resolve; an unset/non-numeric var is 0).
 */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string };

const OPS3 = ['<<=', '>>=', '**='];
const OPS2 = [
  '**', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
];
const OPS1 = ['+', '-', '*', '/', '%', '(', ')', '~', '!', '<', '>', '&', '|', '^', '?', ':', ',', '='];

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === '$') { i++; continue; } // `$name` → treat as bare name
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < n && /[0-9a-fA-FxX]/.test(src[j])) j++;
      const raw = src.slice(i, j);
      toks.push({ t: 'num', v: parseIntLiteral(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    const three = src.slice(i, i + 3);
    if (OPS3.includes(three)) { toks.push({ t: 'op', v: three }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) { toks.push({ t: 'op', v: two }); i += 2; continue; }
    if (OPS1.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new SyntaxError(`arith: unexpected character '${c}'`);
  }
  return toks;
}

function parseIntLiteral(raw: string): number {
  if (/^0[xX]/.test(raw)) return parseInt(raw, 16) | 0 || parseInt(raw, 16);
  if (/^0[0-7]+$/.test(raw)) return parseInt(raw, 8);
  const v = parseInt(raw, 10);
  return Number.isNaN(v) ? 0 : v;
}

class ArithParser {
  private toks: Tok[];
  private pos = 0;
  private env: Record<string, string>;

  constructor(toks: Tok[], env: Record<string, string>) {
    this.toks = toks;
    this.env = env;
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private isOp(v: string): boolean { const t = this.peek(); return t?.t === 'op' && t.v === v; }
  private eat(v: string): void {
    if (!this.isOp(v)) throw new SyntaxError(`arith: expected '${v}'`);
    this.pos++;
  }

  private read(name: string): number {
    const raw = this.env[name];
    if (raw === undefined || raw === '') return 0;
    const v = parseInt(raw.trim(), 10);
    return Number.isNaN(v) ? 0 : v;
  }
  private write(name: string, value: number): number {
    this.env[name] = String(value);
    return value;
  }

  parse(): number {
    const v = this.comma();
    if (this.pos < this.toks.length) throw new SyntaxError('arith: trailing tokens');
    return v;
  }

  // comma → assignment ( ',' assignment )*
  private comma(): number {
    let v = this.assign();
    while (this.isOp(',')) { this.pos++; v = this.assign(); }
    return v;
  }

  // assignment: lvalue ('='|'+='...) assignment | ternary
  private assign(): number {
    const start = this.pos;
    const t = this.peek();
    if (t?.t === 'name') {
      const next = this.toks[this.pos + 1];
      const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '**='];
      if (next?.t === 'op' && assignOps.includes(next.v)) {
        this.pos += 2;
        const rhs = this.assign();
        const cur = this.read(t.v);
        let result: number;
        switch (next.v) {
          case '=': result = rhs; break;
          case '+=': result = cur + rhs; break;
          case '-=': result = cur - rhs; break;
          case '*=': result = cur * rhs; break;
          case '/=': result = trunc(cur / checkNonZero(rhs)); break;
          case '%=': result = cur % checkNonZero(rhs); break;
          case '&=': result = cur & rhs; break;
          case '|=': result = cur | rhs; break;
          case '^=': result = cur ^ rhs; break;
          case '<<=': result = cur << rhs; break;
          case '>>=': result = cur >> rhs; break;
          case '**=': result = Math.pow(cur, rhs); break;
          default: result = rhs;
        }
        return this.write(t.v, result);
      }
    }
    this.pos = start;
    return this.ternary();
  }

  private ternary(): number {
    const cond = this.logicalOr();
    if (this.isOp('?')) {
      this.pos++;
      const a = this.assign();
      this.eat(':');
      const b = this.assign();
      return cond !== 0 ? a : b;
    }
    return cond;
  }

  private logicalOr(): number {
    let v = this.logicalAnd();
    while (this.isOp('||')) { this.pos++; const r = this.logicalAnd(); v = (v !== 0 || r !== 0) ? 1 : 0; }
    return v;
  }
  private logicalAnd(): number {
    let v = this.bitOr();
    while (this.isOp('&&')) { this.pos++; const r = this.bitOr(); v = (v !== 0 && r !== 0) ? 1 : 0; }
    return v;
  }
  private bitOr(): number {
    let v = this.bitXor();
    while (this.isOp('|')) { this.pos++; v = v | this.bitXor(); }
    return v;
  }
  private bitXor(): number {
    let v = this.bitAnd();
    while (this.isOp('^')) { this.pos++; v = v ^ this.bitAnd(); }
    return v;
  }
  private bitAnd(): number {
    let v = this.equality();
    while (this.isOp('&')) { this.pos++; v = v & this.equality(); }
    return v;
  }
  private equality(): number {
    let v = this.relational();
    for (;;) {
      if (this.isOp('==')) { this.pos++; v = v === this.relational() ? 1 : 0; }
      else if (this.isOp('!=')) { this.pos++; v = v !== this.relational() ? 1 : 0; }
      else break;
    }
    return v;
  }
  private relational(): number {
    let v = this.shift();
    for (;;) {
      if (this.isOp('<=')) { this.pos++; v = v <= this.shift() ? 1 : 0; }
      else if (this.isOp('>=')) { this.pos++; v = v >= this.shift() ? 1 : 0; }
      else if (this.isOp('<')) { this.pos++; v = v < this.shift() ? 1 : 0; }
      else if (this.isOp('>')) { this.pos++; v = v > this.shift() ? 1 : 0; }
      else break;
    }
    return v;
  }
  private shift(): number {
    let v = this.additive();
    for (;;) {
      if (this.isOp('<<')) { this.pos++; v = v << this.additive(); }
      else if (this.isOp('>>')) { this.pos++; v = v >> this.additive(); }
      else break;
    }
    return v;
  }
  private additive(): number {
    let v = this.multiplicative();
    for (;;) {
      if (this.isOp('+')) { this.pos++; v = v + this.multiplicative(); }
      else if (this.isOp('-')) { this.pos++; v = v - this.multiplicative(); }
      else break;
    }
    return v;
  }
  private multiplicative(): number {
    let v = this.power();
    for (;;) {
      if (this.isOp('*')) { this.pos++; v = v * this.power(); }
      else if (this.isOp('/')) { this.pos++; v = trunc(v / checkNonZero(this.power())); }
      else if (this.isOp('%')) { this.pos++; v = v % checkNonZero(this.power()); }
      else break;
    }
    return v;
  }
  private power(): number {
    const v = this.unary();
    if (this.isOp('**')) { this.pos++; return Math.pow(v, this.power()); } // right-assoc
    return v;
  }
  private unary(): number {
    if (this.isOp('+')) { this.pos++; return +this.unary(); }
    if (this.isOp('-')) { this.pos++; return -this.unary(); }
    if (this.isOp('!')) { this.pos++; return this.unary() === 0 ? 1 : 0; }
    if (this.isOp('~')) { this.pos++; return ~this.unary(); }
    if (this.isOp('++')) { this.pos++; return this.prefixIncr(1); }
    if (this.isOp('--')) { this.pos++; return this.prefixIncr(-1); }
    return this.postfix();
  }
  private prefixIncr(delta: number): number {
    const t = this.peek();
    if (t?.t !== 'name') throw new SyntaxError('arith: ++/-- needs lvalue');
    this.pos++;
    return this.write(t.v, this.read(t.v) + delta);
  }
  private postfix(): number {
    const t = this.peek();
    if (t?.t === 'name') {
      const next = this.toks[this.pos + 1];
      if (next?.t === 'op' && (next.v === '++' || next.v === '--')) {
        this.pos += 2;
        const old = this.read(t.v);
        this.write(t.v, old + (next.v === '++' ? 1 : -1));
        return old;
      }
    }
    return this.primary();
  }
  private primary(): number {
    const t = this.peek();
    if (!t) throw new SyntaxError('arith: unexpected end');
    if (t.t === 'num') { this.pos++; return t.v; }
    if (t.t === 'name') { this.pos++; return this.read(t.v); }
    if (this.isOp('(')) { this.pos++; const v = this.comma(); this.eat(')'); return v; }
    throw new SyntaxError(`arith: unexpected '${t.v}'`);
  }
}

function trunc(n: number): number {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}

/** Guard a divisor: bash errors on `/ 0` / `% 0` (the result is not Infinity). */
function checkNonZero(n: number): number {
  if (n === 0) throw new SyntaxError('arith: division by 0');
  return n;
}

/** Evaluate an arithmetic expression. Mutates `env` for assignments. */
export function evalArith(src: string, env: Record<string, string>): number {
  const toks = tokenize(src);
  if (toks.length === 0) return 0;
  return new ArithParser(toks, env).parse();
}
