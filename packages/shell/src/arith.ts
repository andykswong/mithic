/**
 * POSIX/bash arithmetic evaluator for `$(( ... ))` and `(( ... ))`.
 *
 * Integer-only, 64-bit `intmax_t` semantics via BigInt (matching bash): every
 * operation wraps modulo 2^64 as two's-complement, division truncates toward zero,
 * `1 << 62` and values beyond 2^53 are exact. Supports the full operator set
 * including assignment (`=`, `+=` …), pre/post increment, ternary, comma, bitwise,
 * shifts, logical, and comparisons. Variable references read/write the supplied
 * `env` (bare names and `$name` both resolve; an unset/non-numeric var is 0).
 */

type Tok =
  | { t: 'num'; v: bigint }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string };

const OPS3 = ['<<=', '>>=', '**='];
const OPS2 = [
  '**', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>',
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
];
const OPS1 = ['+', '-', '*', '/', '%', '(', ')', '~', '!', '<', '>', '&', '|', '^', '?', ':', ',', '='];

const TWO_POW_64 = 1n << 64n;
const INT64_MAX = (1n << 63n) - 1n;

/** Wrap a BigInt to signed 64-bit two's-complement (bash intmax_t overflow). */
function wrap64(v: bigint): bigint {
  const m = ((v % TWO_POW_64) + TWO_POW_64) % TWO_POW_64; // 0 .. 2^64-1
  return m > INT64_MAX ? m - TWO_POW_64 : m;
}

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
      // `base#digits` literal (e.g. 16#ff, 2#1010, 36#z, 10#08). The base is the
      // leading run; the digits after `#` use [0-9a-zA-Z@_] valued 0..63.
      if (src[j] === '#') {
        let k = j + 1;
        while (k < n && /[0-9a-zA-Z@_]/.test(src[k])) k++;
        toks.push({ t: 'num', v: parseBaseLiteral(src.slice(i, j), src.slice(j + 1, k)) });
        i = k;
        continue;
      }
      const raw = src.slice(i, j);
      toks.push({ t: 'num', v: parseIntLiteral(raw) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      // An array-element lvalue `name[subscript]` is captured as one name token
      // (subscript kept verbatim, balanced brackets) so `a[i]++`/`a[i]+=n` work.
      if (src[j] === '[') {
        let depth = 0, k = j;
        for (; k < n; k++) {
          if (src[k] === '[') depth++;
          else if (src[k] === ']') { depth--; if (depth === 0) { k++; break; } }
        }
        toks.push({ t: 'name', v: src.slice(i, k) });
        i = k;
        continue;
      }
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

/**
 * Parse a numeric arithmetic token — a literal (`tokenize`) or a variable's value
 * (`read`). Handles an optional sign, `0x` hex, leading-zero octal, and decimal.
 * A leading-zero token with a non-octal digit (`08`/`09`) is a bash error
 * ("value too great for base"). Wraps to 64-bit. A non-numeric string is 0 (the
 * caller re-tries it as a recursive arithmetic expression).
 */
function parseArithInt(raw: string): bigint | undefined {
  const m = /^([+-]?)(.*)$/.exec(raw.trim());
  if (m === null) return undefined;
  const sign = m[1] === '-' ? -1n : 1n;
  const body = m[2];
  if (/^0[xX][0-9a-fA-F]+$/.test(body)) return wrap64(BigInt(body) * sign);
  if (/^0[0-7]+$/.test(body)) return wrap64(BigInt('0o' + body.slice(1)) * sign);
  if (/^0[0-9]+$/.test(body)) throw new SyntaxError(`arith: ${raw}: value too great for base (error token is "${raw}")`);
  if (/^[0-9]+$/.test(body)) return wrap64(BigInt(body) * sign);
  return undefined;
}

function parseIntLiteral(raw: string): bigint {
  const v = parseArithInt(raw); // may throw on invalid octal (08/09)
  return v ?? 0n;
}

/**
 * Parse a bash `base#digits` literal. Base is 2..64; digit values are
 * 0-9 → 0..9, a-z → 10..35, A-Z → 36..61, `@` → 62, `_` → 63. For bases ≤ 36 the
 * digits are case-insensitive (bash). A digit ≥ base or a bad base throws.
 */
function parseBaseLiteral(baseStr: string, digits: string): bigint {
  const base = parseInt(baseStr, 10);
  if (Number.isNaN(base) || base < 2 || base > 64) throw new SyntaxError(`arith: ${baseStr}: invalid arithmetic base`);
  const bigBase = BigInt(base);
  const digitValue = (ch: string): bigint => {
    let v: number;
    if (ch >= '0' && ch <= '9') v = ch.charCodeAt(0) - 48;
    else if (base <= 36) {
      const lower = ch.toLowerCase();
      if (lower >= 'a' && lower <= 'z') v = lower.charCodeAt(0) - 97 + 10; else v = base;
    } else if (ch >= 'a' && ch <= 'z') v = ch.charCodeAt(0) - 97 + 10;
    else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 65 + 36;
    else if (ch === '@') v = 62;
    else if (ch === '_') v = 63;
    else v = base;
    if (v >= base) throw new SyntaxError(`arith: ${baseStr}#${digits}: value too great for base`);
    return BigInt(v);
  };
  let result = 0n;
  for (const ch of digits) result = result * bigBase + digitValue(ch);
  return wrap64(result);
}

/** Optional array element accessors for `a[i]` / `m[k]` lvalues in arithmetic. */
export interface ArithArrayAccess {
  getElement(name: string, index: number): string | undefined;
  setElement(name: string, index: number, value: string): void;
  /** True when `name` is an ASSOCIATIVE array — its subscript is a string KEY,
   * NOT an arithmetic index (bash: `c[foo]` in `$(( ))` uses key `foo`). Optional. */
  isAssoc?(name: string): boolean;
  /** Read/write an associative-array element by string key (for `m[k]` in arith). */
  getAssocElement?(name: string, key: string): string | undefined;
  setAssocElement?(name: string, key: string, value: string): void;
}

class ArithParser {
  private toks: Tok[];
  private pos = 0;
  private env: Record<string, string>;
  private arr?: ArithArrayAccess;
  /**
   * >0 while parsing a short-circuited / untaken branch (the RHS of a decided
   * `&&`/`||`, or the non-selected `?:` arm). Tokens are still CONSUMED (so the
   * expression parses), but side effects are suppressed: writes are no-ops and a
   * `/ 0` / `% 0` does not throw — matching bash's lazy evaluation.
   */
  private suppress = 0;

  constructor(toks: Tok[], env: Record<string, string>, arr?: ArithArrayAccess) {
    this.toks = toks;
    this.env = env;
    this.arr = arr;
  }

  /** Parse a sub-production with side effects suppressed (untaken branch). */
  private lazy<T>(fn: () => T): T {
    this.suppress++;
    try { return fn(); } finally { this.suppress--; }
  }

  /** Guard a divisor: bash errors on `/ 0` / `% 0`. In a suppressed (untaken)
   * branch a zero divisor does NOT throw — return 1n so the dead computation is
   * harmless (bash never evaluates it). */
  private checkNonZero(n: bigint): bigint {
    if (n === 0n) {
      if (this.suppress > 0) return 1n;
      throw new SyntaxError('arith: division by 0');
    }
    return n;
  }

  /** Split an `a[idx]` / `m[key]` name. For an ASSOCIATIVE array the subscript is a
   * literal string KEY (bash: `m[foo]` uses key `foo`); otherwise it is evaluated
   * arithmetically to a numeric index. */
  private arrayRef(name: string): { arr: string; index: number; key?: string } | undefined {
    const b = name.indexOf('[');
    if (b < 0 || !name.endsWith(']')) return undefined;
    const arr = name.slice(0, b);
    const idxSrc = name.slice(b + 1, -1);
    if (this.arr?.isAssoc?.(arr)) return { arr, index: 0, key: idxSrc };
    // Inherit the current suppression: a subscript inside a short-circuited / untaken
    // branch (`0 ? a[i++] : 9`) must NOT run its side effects (bash never evaluates it).
    const sub = new ArithParser(tokenize(idxSrc), this.env, this.arr);
    sub.suppress = this.suppress;
    const index = Number(sub.parse());
    return { arr, index };
  }

  private peek(): Tok | undefined { return this.toks[this.pos]; }
  private isOp(v: string): boolean { const t = this.peek(); return t?.t === 'op' && t.v === v; }
  private eat(v: string): void {
    if (!this.isOp(v)) throw new SyntaxError(`arith: expected '${v}'`);
    this.pos++;
  }

  private read(name: string): bigint {
    const ref = this.arrayRef(name);
    const raw = ref
      ? (ref.key !== undefined ? this.arr?.getAssocElement?.(ref.arr, ref.key) : this.arr?.getElement(ref.arr, ref.index))
      : this.env[name];
    if (raw === undefined || raw === '') return 0n;
    // A variable's value is a numeric token (hex/octal/decimal — a leading-zero
    // value IS octal, `n=017` → 15) or, failing that, itself an arithmetic
    // expression (bash recursive arith). An invalid octal (`08`) throws.
    const num = parseArithInt(raw); // may throw on invalid octal
    if (num !== undefined) return num;
    // A variable whose value is itself an arith expression — inherit suppression so
    // its side effects (rare) also stay off in a dead branch.
    const sub = new ArithParser(tokenize(raw.trim()), this.env, this.arr);
    sub.suppress = this.suppress;
    return wrap64(sub.parse());
  }
  private write(name: string, value: bigint): bigint {
    const v = wrap64(value);
    if (this.suppress > 0) return v; // untaken branch: compute but do not persist
    const ref = this.arrayRef(name);
    if (ref) {
      if (ref.key !== undefined) this.arr?.setAssocElement?.(ref.arr, ref.key, String(v));
      else this.arr?.setElement(ref.arr, ref.index, String(v));
      return v;
    }
    this.env[name] = String(v);
    return v;
  }

  parse(): bigint {
    const v = this.comma();
    if (this.pos < this.toks.length) throw new SyntaxError('arith: trailing tokens');
    return v;
  }

  // comma → assignment ( ',' assignment )*
  private comma(): bigint {
    let v = this.assign();
    while (this.isOp(',')) { this.pos++; v = this.assign(); }
    return v;
  }

  // assignment: lvalue ('='|'+='...) assignment | ternary
  private assign(): bigint {
    const start = this.pos;
    const t = this.peek();
    if (t?.t === 'name') {
      const next = this.toks[this.pos + 1];
      const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '**='];
      if (next?.t === 'op' && assignOps.includes(next.v)) {
        this.pos += 2;
        const rhs = this.assign();
        const cur = this.read(t.v);
        let result: bigint;
        switch (next.v) {
          case '=': result = rhs; break;
          case '+=': result = cur + rhs; break;
          case '-=': result = cur - rhs; break;
          case '*=': result = cur * rhs; break;
          case '/=': result = trunc(cur, this.checkNonZero(rhs)); break;
          case '%=': result = cur % this.checkNonZero(rhs); break;
          case '&=': result = cur & rhs; break;
          case '|=': result = cur | rhs; break;
          case '^=': result = cur ^ rhs; break;
          case '<<=': result = cur << bshift(rhs); break;
          case '>>=': result = cur >> bshift(rhs); break;
          case '**=': result = this.powOp(cur, rhs); break;
          default: result = rhs;
        }
        return this.write(t.v, result);
      }
    }
    this.pos = start;
    return this.ternary();
  }

  private ternary(): bigint {
    const cond = this.logicalOr();
    if (this.isOp('?')) {
      this.pos++;
      // Only the SELECTED arm is evaluated for real; the other is parsed with side
      // effects suppressed (bash: `1 ? 10 : (x=99)` does not run `x=99`).
      const taken = cond !== 0n;
      const a = taken ? this.assign() : this.lazy(() => this.assign());
      this.eat(':');
      const b = taken ? this.lazy(() => this.assign()) : this.assign();
      return taken ? a : b;
    }
    return cond;
  }

  private logicalOr(): bigint {
    let v = this.logicalAnd();
    // `||` short-circuits: once the result is known true, the RHS is parsed with
    // side effects suppressed (no assignment / no divide-by-zero error leaks).
    while (this.isOp('||')) {
      this.pos++;
      const known = v !== 0n;
      const r = known ? this.lazy(() => this.logicalAnd()) : this.logicalAnd();
      v = (v !== 0n || r !== 0n) ? 1n : 0n;
    }
    return v;
  }
  private logicalAnd(): bigint {
    let v = this.bitOr();
    // `&&` short-circuits: once the result is known false, the RHS is parsed with
    // side effects suppressed.
    while (this.isOp('&&')) {
      this.pos++;
      const known = v === 0n;
      const r = known ? this.lazy(() => this.bitOr()) : this.bitOr();
      v = (v !== 0n && r !== 0n) ? 1n : 0n;
    }
    return v;
  }
  private bitOr(): bigint {
    let v = this.bitXor();
    while (this.isOp('|')) { this.pos++; v = wrap64(v | this.bitXor()); }
    return v;
  }
  private bitXor(): bigint {
    let v = this.bitAnd();
    while (this.isOp('^')) { this.pos++; v = wrap64(v ^ this.bitAnd()); }
    return v;
  }
  private bitAnd(): bigint {
    let v = this.equality();
    while (this.isOp('&')) { this.pos++; v = wrap64(v & this.equality()); }
    return v;
  }
  private equality(): bigint {
    let v = this.relational();
    for (;;) {
      if (this.isOp('==')) { this.pos++; v = v === this.relational() ? 1n : 0n; }
      else if (this.isOp('!=')) { this.pos++; v = v !== this.relational() ? 1n : 0n; }
      else break;
    }
    return v;
  }
  private relational(): bigint {
    let v = this.shift();
    for (;;) {
      if (this.isOp('<=')) { this.pos++; v = v <= this.shift() ? 1n : 0n; }
      else if (this.isOp('>=')) { this.pos++; v = v >= this.shift() ? 1n : 0n; }
      else if (this.isOp('<')) { this.pos++; v = v < this.shift() ? 1n : 0n; }
      else if (this.isOp('>')) { this.pos++; v = v > this.shift() ? 1n : 0n; }
      else break;
    }
    return v;
  }
  private shift(): bigint {
    let v = this.additive();
    for (;;) {
      if (this.isOp('<<')) { this.pos++; v = wrap64(v << bshift(this.additive())); }
      else if (this.isOp('>>')) { this.pos++; v = wrap64(v >> bshift(this.additive())); }
      else break;
    }
    return v;
  }
  private additive(): bigint {
    let v = this.multiplicative();
    for (;;) {
      if (this.isOp('+')) { this.pos++; v = wrap64(v + this.multiplicative()); }
      else if (this.isOp('-')) { this.pos++; v = wrap64(v - this.multiplicative()); }
      else break;
    }
    return v;
  }
  private multiplicative(): bigint {
    let v = this.power();
    for (;;) {
      if (this.isOp('*')) { this.pos++; v = wrap64(v * this.power()); }
      else if (this.isOp('/')) { this.pos++; v = trunc(v, this.checkNonZero(this.power())); }
      else if (this.isOp('%')) { this.pos++; v = v % this.checkNonZero(this.power()); }
      else break;
    }
    return v;
  }
  private power(): bigint {
    const v = this.unary();
    if (this.isOp('**')) { this.pos++; return this.powOp(v, this.power()); } // right-assoc
    return v;
  }
  /** `base ** exp`. A negative exponent is a bash error (unless in a dead branch). */
  private powOp(base: bigint, exp: bigint): bigint {
    if (exp < 0n) {
      if (this.suppress > 0) return 0n;
      throw new SyntaxError('arith: exponent less than 0');
    }
    return ipow(base, exp);
  }
  private unary(): bigint {
    if (this.isOp('+')) { this.pos++; return this.unary(); }
    if (this.isOp('-')) { this.pos++; return wrap64(-this.unary()); }
    if (this.isOp('!')) { this.pos++; return this.unary() === 0n ? 1n : 0n; }
    if (this.isOp('~')) { this.pos++; return wrap64(~this.unary()); }
    if (this.isOp('++')) { this.pos++; return this.prefixIncr(1n); }
    if (this.isOp('--')) { this.pos++; return this.prefixIncr(-1n); }
    return this.postfix();
  }
  private prefixIncr(delta: bigint): bigint {
    const t = this.peek();
    if (t?.t !== 'name') throw new SyntaxError('arith: ++/-- needs lvalue');
    this.pos++;
    return this.write(t.v, this.read(t.v) + delta);
  }
  private postfix(): bigint {
    const t = this.peek();
    if (t?.t === 'name') {
      const next = this.toks[this.pos + 1];
      if (next?.t === 'op' && (next.v === '++' || next.v === '--')) {
        this.pos += 2;
        const old = this.read(t.v);
        this.write(t.v, old + (next.v === '++' ? 1n : -1n));
        return old;
      }
    }
    return this.primary();
  }
  private primary(): bigint {
    const t = this.peek();
    if (!t) throw new SyntaxError('arith: unexpected end');
    if (t.t === 'num') { this.pos++; return t.v; }
    if (t.t === 'name') { this.pos++; return this.read(t.v); }
    if (this.isOp('(')) { this.pos++; const v = this.comma(); this.eat(')'); return v; }
    throw new SyntaxError(`arith: unexpected '${t.v}'`);
  }
}

/** Truncate a/b toward zero (bash integer division), wrapped to 64-bit. */
function trunc(a: bigint, b: bigint): bigint {
  // BigInt `/` already truncates toward zero.
  return wrap64(a / b);
}

/** `x ** y` for integer exponents (bash): y < 0 → 0 (integer), else repeated mul. */
function ipow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = base;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = wrap64(result * b);
    e >>= 1n;
    if (e > 0n) b = wrap64(b * b);
  }
  return wrap64(result);
}

/** A shift amount is taken modulo 64 (as C/bash do for a 64-bit type). */
function bshift(n: bigint): bigint {
  const m = n % 64n;
  return m < 0n ? m + 64n : m;
}


/**
 * Evaluate an arithmetic expression to a 64-bit `bigint` (bash intmax_t; overflow
 * wraps two's-complement). Mutates `env` for assignments; `arr` (if given) backs
 * `a[i]` element reads/writes. Callers needing a JS `number` (array indices) apply
 * `Number(...)`; `$(( ))` / `let` stringify the exact BigInt.
 */
export function evalArith(src: string, env: Record<string, string>, arr?: ArithArrayAccess): bigint {
  const toks = tokenize(src);
  if (toks.length === 0) return 0n;
  return new ArithParser(toks, env, arr).parse();
}
