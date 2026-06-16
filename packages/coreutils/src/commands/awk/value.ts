/**
 * Value model and formatting for the awk interpreter.
 *
 * awk values are dynamically typed and untyped at rest: a scalar is either a
 * string or a number, with implicit coercion driven by context. We represent a
 * scalar as a JS `string | number`. Uninitialized values are the empty string
 * which coerces to 0 numerically and "" as a string.
 *
 * "Numeric string" semantics (a field/input that looks like a number compares
 * numerically) are approximated: comparison coerces to number when BOTH sides
 * look numeric, otherwise string compares. This matches the common POSIX cases.
 */

export type Value = string | number;

/** A string consisting entirely of an optional-sign decimal/float, maybe with
 * surrounding whitespace — i.e. something awk would treat as a numeric string. */
const NUMERIC_STRING = /^[ \t]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?[ \t]*$/;
const NUMERIC_PREFIX = /^[ \t]*([-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?|[-+]?0[xX][0-9a-fA-F]+)/;

/** Coerce a value to a number using awk's leading-numeric-prefix rule. */
export function toNum(v: Value): number {
  if (typeof v === 'number') return v;
  const m = NUMERIC_PREFIX.exec(v);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isNaN(n) ? 0 : n;
}

/** Whether a string looks fully numeric (used for numeric-string comparisons). */
export function looksNumeric(v: Value): boolean {
  if (typeof v === 'number') return true;
  return v !== '' && NUMERIC_STRING.test(v);
}

/**
 * Format a number the way awk stringifies it for output/concatenation: integers
 * print without a decimal point; non-integers use the CONVFMT/OFMT format
 * (default `%.6g`). `ofmt` lets `print` pass OFMT while concat passes CONVFMT.
 */
export function numToStr(n: number, fmt = '%.6g'): string {
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : (n < 0 ? '-inf' : 'nan');
  // Integral values print as full integers (no exponent), matching gawk. For
  // magnitudes within the exactly-representable range `String` is exact; beyond
  // 2^53 `toFixed(0)` still renders the full (rounded) decimal expansion rather
  // than switching to scientific notation the way `String` does at 1e21.
  if (Number.isInteger(n)) {
    return Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
  }
  return sprintf(fmt, [n]);
}

/** Coerce a value to a string (using CONVFMT for non-integer numbers). */
export function toStr(v: Value, convfmt = '%.6g'): string {
  if (typeof v === 'string') return v;
  return numToStr(v, convfmt);
}

/** Truthiness: a number is true iff != 0; a string is true iff non-empty.
 * A numeric string is judged by its numeric value. */
export function toBool(v: Value): boolean {
  if (typeof v === 'number') return v !== 0;
  if (looksNumeric(v)) return toNum(v) !== 0;
  return v !== '';
}

// ── sprintf ────────────────────────────────────────────────────────────────────

/**
 * A faithful-enough implementation of awk/C `sprintf`. Supports the conversions
 * awk programs use: `d i o x X u c s e E f g G %` plus flags `- + space # 0`,
 * field width and precision (including `*` width/precision pulling from args).
 */
export function sprintf(fmt: string, args: Value[]): string {
  let out = '';
  let ai = 0;
  const nextArg = (): Value => (ai < args.length ? args[ai++] : '');
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c !== '%') { out += c; i++; continue; }
    // Parse a conversion spec: %[flags][width][.prec]conv
    const start = i;
    i++;
    if (fmt[i] === '%') { out += '%'; i++; continue; }
    let flags = '';
    while ('-+ #0'.includes(fmt[i])) { flags += fmt[i]; i++; }
    let width = '';
    if (fmt[i] === '*') { width = String(Math.trunc(toNum(nextArg()))); i++; }
    else while (fmt[i] >= '0' && fmt[i] <= '9') { width += fmt[i]; i++; }
    let prec = '';
    let hasPrec = false;
    if (fmt[i] === '.') {
      hasPrec = true;
      i++;
      if (fmt[i] === '*') { prec = String(Math.trunc(toNum(nextArg()))); i++; }
      else { prec = ''; while (fmt[i] >= '0' && fmt[i] <= '9') { prec += fmt[i]; i++; } }
    }
    const conv = fmt[i];
    if (conv === undefined) { out += fmt.slice(start); break; }
    i++;
    out += formatOne(conv, flags, width === '' ? undefined : Number(width),
      hasPrec ? (prec === '' ? 0 : Number(prec)) : undefined, nextArg);
  }
  return out;
}

function formatOne(
  conv: string,
  flags: string,
  width: number | undefined,
  prec: number | undefined,
  nextArg: () => Value,
): string {
  const left = flags.includes('-');
  const zero = flags.includes('0') && !left;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');

  const pad = (s: string, signLen = 0): string => {
    if (width === undefined || s.length + signLen >= width) return s;
    const fill = width - s.length - signLen;
    if (left) return s + ' '.repeat(fill);
    if (zero) return '0'.repeat(fill) + s;
    return ' '.repeat(fill) + s;
  };
  const signOf = (neg: boolean): string => neg ? '-' : (plus ? '+' : (space ? ' ' : ''));
  const withSign = (sign: string, body: string): string => {
    if (width !== undefined && zero && !left && sign.length + body.length < width) {
      return sign + '0'.repeat(width - sign.length - body.length) + body;
    }
    const full = sign + body;
    return pad(full, 0);
  };

  switch (conv) {
    case 'd': case 'i': {
      const n = Math.trunc(toNum(nextArg()));
      const neg = n < 0 || Object.is(n, -0);
      let body = Math.abs(n).toFixed(0);
      if (prec !== undefined) body = body.padStart(prec, '0');
      if (prec === 0 && Math.abs(n) === 0) body = '';
      return withSign(signOf(neg), body);
    }
    case 'u': {
      let n = Math.trunc(toNum(nextArg()));
      if (n < 0) n = n >>> 0;
      let body = String(n);
      if (prec !== undefined) body = body.padStart(prec, '0');
      return withSign('', body);
    }
    case 'o': {
      let n = Math.trunc(toNum(nextArg()));
      if (n < 0) n = n >>> 0;
      let body = n.toString(8);
      if (alt && body[0] !== '0') body = '0' + body;
      if (prec !== undefined) body = body.padStart(prec, '0');
      return withSign('', body);
    }
    case 'x': case 'X': {
      let n = Math.trunc(toNum(nextArg()));
      if (n < 0) n = n >>> 0;
      let body = n.toString(16);
      if (conv === 'X') body = body.toUpperCase();
      if (prec !== undefined) body = body.padStart(prec, '0');
      const prefix = alt && n !== 0 ? (conv === 'X' ? '0X' : '0x') : '';
      return withSign(prefix, body);
    }
    case 'c': {
      const a = nextArg();
      let ch: string;
      if (typeof a === 'number') ch = a === 0 ? '' : String.fromCharCode(Math.trunc(a) & 0xff);
      else ch = a.length > 0 ? a[0] : '';
      return pad(ch);
    }
    case 's': {
      const a = nextArg();
      let s = typeof a === 'number' ? numToStr(a) : a;
      if (prec !== undefined) s = s.slice(0, prec);
      return pad(s);
    }
    case 'e': case 'E': {
      const n = toNum(nextArg());
      const p = prec ?? 6;
      let body = Math.abs(n).toExponential(p);
      if (conv === 'E') body = body.toUpperCase();
      body = fixExp(body, conv === 'E' ? 'E' : 'e');
      return withSign(signOf(n < 0), body);
    }
    case 'f': case 'F': {
      const n = toNum(nextArg());
      const p = prec ?? 6;
      const body = Math.abs(n).toFixed(p);
      return withSign(signOf(n < 0), body);
    }
    case 'g': case 'G': {
      const n = toNum(nextArg());
      const body = formatG(Math.abs(n), prec ?? 6, conv === 'G', alt);
      return withSign(signOf(n < 0), body);
    }
    default:
      // Unknown conversion: emit it literally (consume no arg).
      return '%' + flags + (width ?? '') + (prec !== undefined ? '.' + prec : '') + conv;
  }
}

/** Ensure a 2-digit exponent like C printf (`1e+5` → `1e+05`). */
function fixExp(s: string, e: string): string {
  return s.replace(/[eE]([+-])(\d+)/, (_m, sign: string, digits: string) =>
    e + sign + (digits.length < 2 ? digits.padStart(2, '0') : digits));
}

/** Implement `%g` per C semantics. */
function formatG(n: number, prec: number, upper: boolean, alt: boolean): string {
  const p = prec === 0 ? 1 : prec;
  if (n === 0) return '0';
  const exp = Math.floor(Math.log10(n));
  let body: string;
  if (exp < -4 || exp >= p) {
    body = n.toExponential(p - 1);
    if (!alt) body = body.replace(/\.?0+e/, 'e');
    body = fixExp(body, upper ? 'E' : 'e');
  } else {
    body = n.toFixed(Math.max(0, p - 1 - exp));
    if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
  }
  return upper ? body.toUpperCase() : body;
}
