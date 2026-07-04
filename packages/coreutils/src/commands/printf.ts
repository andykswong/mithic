/**
 * `printf` — format and print data.
 *
 * Usage: printf FORMAT [ARGUMENT...]
 *
 * The FORMAT string is interpreted repeatedly over ARGUMENT groups until all
 * arguments are consumed (GNU printf behaviour). Supported conversions:
 *   %s %d %i %u %o %x %X %c %% %b %f %e %E %g %G
 *   Width, precision, flags (0 - + space #), * width/precision from args.
 *   \\ \a \b \f \n \r \t \v \0NNN \xHH (in FORMAT and %b args).
 */
import { defineCommand, writeString, writeLine } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { processEscapesFull } from './echo.ts';

interface ConvSpec {
  flags: string;
  width: number | null;
  precision: number | null;
  spec: string;
}

/** C `intmax_t` / `uintmax_t` bounds (64-bit), matching GNU printf. */
const INTMAX_MAX = 9223372036854775807n;
const INTMAX_MIN = -9223372036854775808n;
const UINTMAX = 18446744073709551616n; // 2^64
const UINTMAX_MAX = 18446744073709551615n; // 2^64 - 1
const UINTMAX_MIN = -(18446744073709551615n); // -(2^64-1): GNU's low bound for %u/%o/%x

/**
 * A numeric-argument diagnostic accumulated while formatting (GNU printf prints
 * these to stderr and exits 1 but still emits the formatted output). `code` is
 * the desired exit code (always 1).
 */
interface PrintfDiag { message: string; }

function parseNextConversion(fmt: string, pos: number): [ConvSpec, number] | null {
  // pos points at the character after '%'
  let i = pos;
  // Flags
  let flags = '';
  while (i < fmt.length && '-+ 0#'.includes(fmt[i])) flags += fmt[i++];
  // Width
  let width: number | null = null;
  if (fmt[i] === '*') { width = -1; i++; }
  else {
    let ws = '';
    while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') ws += fmt[i++];
    if (ws) width = parseInt(ws, 10);
  }
  // Precision
  let precision: number | null = null;
  if (fmt[i] === '.') {
    i++;
    if (fmt[i] === '*') { precision = -1; i++; }
    else {
      let ps = '';
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') ps += fmt[i++];
      precision = ps ? parseInt(ps, 10) : 0;
    }
  }
  if (i >= fmt.length) return null;
  const spec = fmt[i++];
  return [{ flags, width, precision, spec }, i];
}

/**
 * Parse an integer argument the way C/POSIX printf does for `%d %i %u %o %x`
 * — as a BigInt (C intmax_t/uintmax_t is 64-bit, well past JS's 2^53):
 *   - a leading `'` or `"` means "the numeric code of the next character"
 *     (`'A` → 65);
 *   - `0x`/`0X` prefix → hexadecimal;
 *   - a leading `0` (with more digits) → octal;
 *   - otherwise decimal (with optional sign).
 *
 * Returns `{ value }` on success, plus an optional `diag`:
 *   - a non-numeric argument → value 0, `expected a numeric value`;
 *   - an out-of-range value → clamped/saturated, `Result too large`.
 *
 * The target range depends on the conversion: SIGNED convs (`%d`/`%i`) clamp to
 * [INTMAX_MIN, INTMAX_MAX]; UNSIGNED convs (`%u`/`%o`/`%x`) parse the arg as
 * `uintmax_t`, so they accept the full [-(2^64-1), 2^64-1] range and saturate to
 * UINTMAX_MAX (GNU parses unsigned-conversion args as uintmax_t). GNU prints the
 * diagnostic on stderr, still emits the (clamped/zero) value, and exits 1.
 */
function parseIntArg(raw: string, unsigned = false): { value: bigint; diag?: PrintfDiag } {
  const s = raw.trim();
  if (s === '') return { value: 0n };
  if (s[0] === '\'' || s[0] === '"') {
    // Character-code form; use the first code point after the quote.
    return { value: s.length > 1 ? BigInt(s.codePointAt(1)!) : 0n };
  }
  let sign = 1n;
  let body = s;
  if (body[0] === '+' || body[0] === '-') { if (body[0] === '-') sign = -1n; body = body.slice(1); }
  let n: bigint;
  try {
    if (/^0[xX][0-9a-fA-F]+$/.test(body)) n = BigInt(body);
    else if (/^0[0-7]+$/.test(body)) n = BigInt('0o' + body.slice(1));
    else if (/^[0-9]+$/.test(body)) n = BigInt(body);
    else return { value: 0n, diag: { message: `‘${raw}’: expected a numeric value` } };
  } catch {
    return { value: 0n, diag: { message: `‘${raw}’: expected a numeric value` } };
  }
  const value = sign * n;
  // Clamp to the target range (GNU: "Result too large" + exit 1, saturated value).
  if (unsigned) {
    if (value > UINTMAX_MAX || value < UINTMAX_MIN) return { value: UINTMAX_MAX, diag: { message: `‘${raw}’: Result too large` } };
    return { value };
  }
  if (value > INTMAX_MAX) return { value: INTMAX_MAX, diag: { message: `‘${raw}’: Result too large` } };
  if (value < INTMAX_MIN) return { value: INTMAX_MIN, diag: { message: `‘${raw}’: Result too large` } };
  return { value };
}

function pad(s: string, width: number, flags: string, padChar = ' '): string {
  if (width <= 0 || s.length >= width) return s;
  const p = padChar.repeat(width - s.length);
  return flags.includes('-') ? s + p : p + s;
}

/**
 * Round the EXACT value of a non-negative finite double `ax`, scaled by 10^k, to the
 * nearest integer with ties-to-EVEN — matching C/GNU printf (which round the true
 * IEEE-754 value, not the shortest decimal literal). Decomposes `ax = mant·2^e2` from
 * its bit pattern so the rational `ax·10^k = num/den` is exact; JS `toFixed`/
 * `toExponential` instead round exact ties half-away-from-zero, so this is the ONLY
 * place the output can differ from them, and only on exact-half values.
 */
function scaledRoundHalfEven(ax: number, k: number): bigint {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, ax);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const rawExp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo >>> 0);
  let e2: number;
  if (rawExp === 0) e2 = -1074;                       // subnormal (no implicit 1)
  else { mant |= (1n << 52n); e2 = rawExp - 1075; }   // normal: add implicit leading 1
  if (mant === 0n) return 0n;
  let num = mant, den = 1n;                            // ax·10^k = num/den (exact)
  if (k >= 0) num *= 10n ** BigInt(k); else den *= 10n ** BigInt(-k);
  if (e2 >= 0) num <<= BigInt(e2); else den <<= BigInt(-e2);
  let q = num / den;
  const twiceRem = (num - q * den) * 2n;
  if (twiceRem > den) q += 1n;
  else if (twiceRem === den && (q % 2n) === 1n) q += 1n; // exact tie → round to even
  return q;
}

/** `%f` magnitude of a non-negative finite double with `prec` fractional digits. */
function formatFixed(ax: number, prec: number): string {
  if (!Number.isFinite(ax)) return Math.abs(ax).toFixed(Math.min(prec, 100));
  const q = scaledRoundHalfEven(ax, prec).toString();
  if (prec === 0) return q;
  const s = q.padStart(prec + 1, '0');
  return s.slice(0, s.length - prec) + '.' + s.slice(s.length - prec);
}

/** `%e` formatting of a non-negative finite double: mantissa + e±NN (≥2 exponent
 *  digits), ties-to-even. */
function formatExp(n: number, prec: number, upper: boolean): string {
  const e = upper ? 'E' : 'e';
  if (!Number.isFinite(n)) {
    const s = Math.abs(n).toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
    return upper ? s.toUpperCase() : s;
  }
  if (n === 0) return (prec > 0 ? '0.' + '0'.repeat(prec) : '0') + e + '+00';
  const digits = prec + 1;                            // total significant digits
  let exp = Math.floor(Math.log10(n));
  let q = scaledRoundHalfEven(n, prec - exp);
  // A log10 estimate can be off by one, and rounding can carry a digit (9.99→10.0);
  // re-scale until the integer part has exactly `digits` digits.
  while (q.toString().length > digits) { exp += 1; q = scaledRoundHalfEven(n, prec - exp); }
  while (q !== 0n && q.toString().length < digits) { exp -= 1; q = scaledRoundHalfEven(n, prec - exp); }
  const ds = q.toString().padStart(digits, '0');
  const mant = prec > 0 ? ds[0] + '.' + ds.slice(1) : ds;
  const esign = exp < 0 ? '-' : '+';
  return mant + e + esign + String(Math.abs(exp)).padStart(2, '0');
}

/**
 * C `%g` for a non-negative value `n`: `sig` significant digits (0 → 1). Uses `%e`
 * when the decimal exponent is < -4 or >= sig, else `%f`. Trailing zeros are
 * stripped unless the `#` (alt) flag is set. Rounds ties-to-even.
 */
function formatG(n: number, sig: number, upper: boolean, alt: boolean): string {
  if (sig < 1) sig = 1;
  if (n === 0) return alt ? '0.' + '0'.repeat(Math.max(0, sig - 1)) : '0';
  if (!Number.isFinite(n)) return formatExp(n, sig - 1, upper);
  // Determine the exponent of the value AFTER rounding to `sig` significant digits
  // (rounding can bump the exponent, e.g. 9.99 @ 2 sig → 10 → e+01).
  let exp = Math.floor(Math.log10(n));
  let q = scaledRoundHalfEven(n, sig - 1 - exp);
  while (q.toString().length > sig) { exp += 1; q = scaledRoundHalfEven(n, sig - 1 - exp); }
  while (q !== 0n && q.toString().length < sig) { exp -= 1; q = scaledRoundHalfEven(n, sig - 1 - exp); }
  let s: string;
  if (exp < -4 || exp >= sig) {
    s = formatExp(n, sig - 1, upper);
    // Trim trailing zeros before the exponent. `formatExp` may have uppercased `e`
    // to `E` (for `%G`), so match either case.
    if (!alt) s = s.replace(/\.?0+([eE])/, '$1');
    // `%#g` keeps the point even at precision 0 (`%#.1g 1e20` → `1.e+20`).
    else if (!s.includes('.')) s = s.replace(/([eE])/, '.$1');
  } else {
    s = formatFixed(n, Math.max(0, sig - 1 - exp));
    if (!alt && s.includes('.')) s = s.replace(/\.?0+$/, '');
    // `%#g` on an integer-valued result forces a trailing point (`%#g 100000` → `100000.`).
    else if (alt && !s.includes('.')) s = s + '.';
  }
  return s;
}

/**
 * Left-pad a signed integer body to `width` with zeros, keeping the sign in
 * front of the zeros (`%05d` of -42 → `-0042`, of +7 → `+0007`). Used only when
 * the `0` flag is active and no left-align/precision override applies.
 */
function zeroPadSigned(sign: string, digits: string, width: number): string {
  const total = sign.length + digits.length;
  if (total >= width) return sign + digits;
  return sign + digits.padStart(width - sign.length, '0');
}

/** C-string names for the control bytes glibc's shell-escape quoting spells out. */
const CTRL_ESCAPE: Record<number, string> = {
  0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n',
  0x0b: '\\v', 0x0c: '\\f', 0x0d: '\\r',
};

/**
 * Shell-quote `arg` exactly like GNU `printf %q` (glibc `quotearg` with the
 * shell-escape style). Rules:
 *   - empty string → `''`;
 *   - a byte that is a control/non-printable char is emitted in a `$'...'` run
 *     (named escape when known, else 3-digit octal); adjacent literal text sits
 *     in its own `'...'` run, so `a\nb` → `'a'$'\n''b'`;
 *   - otherwise, if any char forces quoting (shell metacharacters, plus leading
 *     `#`/`~`, plus a standalone `{`/`}`), the string is single-quoted; but when
 *     the ONLY quoting trigger is a `'` (with no other single-quote-forcing char
 *     and no `"`/`$`/`` ` ``/`\`) the string is double-quoted instead
 *     (`a'b` → `"a'b"`);
 *   - a string needing no quoting is emitted bare.
 */
function shellQuote(arg: string): string {
  if (arg === '') return '\'\'';

  const forcesQuote = (ch: string, i: number): boolean => {
    if (' \t\n!"$&\'()*;<>?[\\^`|='.includes(ch)) return true;
    if ((ch === '#' || ch === '~') && i === 0) return true;
    if ((ch === '{' || ch === '}') && arg.length === 1) return true;
    return false;
  };

  let needsEscape = false;
  let needsQuote = false;
  let onlyQuoteTrigger = true; // every forcing char so far is the single-quote `'`
  for (let i = 0; i < arg.length; i++) {
    const code = arg.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code > 0x7f) { needsEscape = true; needsQuote = true; onlyQuoteTrigger = false; continue; }
    const ch = arg[i];
    if (forcesQuote(ch, i)) {
      needsQuote = true;
      if (ch !== '\'') onlyQuoteTrigger = false;
    }
    if ('"$`\\'.includes(ch)) onlyQuoteTrigger = false;
  }

  if (!needsQuote) return arg;

  if (needsEscape) {
    // Mixed form: literal runs in '...', escaped bytes in $'...'. Non-printable
    // bytes are the UTF-8 encoding of the string (GNU under LC_ALL=C escapes each
    // byte), so a multibyte char yields one octal escape per UTF-8 byte.
    const bytes = new TextEncoder().encode(arg);
    let out = '';
    let lit = '';
    let esc = '';
    const flushLit = () => { if (lit !== '') { out += `'${lit}'`; lit = ''; } };
    // GNU always opens with a '...' run, so a leading escape gets an empty ''.
    const flushEsc = () => { if (esc !== '') { if (out === '') out += '\'\''; out += `$'${esc}'`; esc = ''; } };
    for (const code of bytes) {
      if (code < 0x20 || code >= 0x7f) {
        flushLit();
        esc += CTRL_ESCAPE[code] ?? '\\' + code.toString(8).padStart(3, '0');
      } else {
        flushEsc();
        lit += String.fromCharCode(code);
      }
    }
    flushEsc();
    flushLit();
    return out;
  }

  if (onlyQuoteTrigger && arg.includes('\'')) {
    return '"' + arg + '"';
  }

  // Single-quote, escaping any embedded ' as '\''.
  return '\'' + arg.replace(/'/g, '\'\\\'\'') + '\'';
}

/** Mutable state threaded through a format pass: numeric diagnostics + a
 *  `\c`-in-`%b` truncation flag (which stops ALL further output). */
interface PassState { diags: PrintfDiag[]; truncated: boolean; }

function applyConversion(
  spec: ConvSpec,
  args: string[],
  argIdx: number,
  state: PassState,
): [string, number] {
  let idx = argIdx;
  let { width, precision } = spec;

  // Resolve * widths/precisions from args
  if (width === -1) { width = parseInt(args[idx++] ?? '0', 10); }
  if (precision === -1) { precision = parseInt(args[idx++] ?? '0', 10); }

  const rawArg = args[idx++] ?? '';
  const { flags, spec: s } = spec;

  const leftAlign = flags.includes('-');
  // The `0` flag is ignored for integer conversions when an explicit precision
  // is given (C rule), and for left-aligned output.
  const zeroPad = flags.includes('0') && !leftAlign;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');

  const diags = state.diags;
  // Parse an integer argument (BigInt), routing any diagnostic to `diags`.
  // `unsigned` selects the uintmax_t range for %u/%o/%x.
  const intArg = (unsigned = false): bigint => {
    const r = parseIntArg(rawArg, unsigned);
    if (r.diag) diags.push(r.diag);
    return r.value;
  };

  let out = '';
  switch (s) {
    case '%': out = '%'; idx--; break;
    case 's': {
      let str = rawArg;
      if (precision !== null && precision >= 0) str = str.slice(0, precision);
      out = pad(str, width ?? 0, flags);
      break;
    }
    case 'b': {
      const esc = processEscapesFull(rawArg, { errorOnMissingHex: true });
      if (esc.missingHex) state.diags.push({ message: 'missing hexadecimal number in escape' });
      if (esc.truncated) state.truncated = true; // `\c` or `\x`-no-hex in %b stops all output
      let str = esc.text;
      if (precision !== null && precision >= 0) str = str.slice(0, precision);
      out = pad(str, width ?? 0, flags);
      break;
    }
    case 'c': out = pad(rawArg[0] ?? '\0', width ?? 0, flags); break;
    case 'q': out = pad(shellQuote(rawArg), width ?? 0, flags); break;
    case 'd': case 'i': {
      const n = intArg();
      const neg = n < 0n;
      let ns = (neg ? -n : n).toString();
      if (precision !== null) ns = ns.padStart(precision, '0');
      const sign = neg ? '-' : (plus ? '+' : (space ? ' ' : ''));
      // Zero-pad only when the 0 flag is set and no explicit precision.
      if (zeroPad && precision === null && width !== null && (sign.length + ns.length) < width) {
        out = zeroPadSigned(sign, ns, width);
      } else {
        out = pad(sign + ns, width ?? 0, flags);
      }
      break;
    }
    case 'u': {
      let n = intArg(true);
      if (n < 0n) n = ((n % UINTMAX) + UINTMAX) % UINTMAX; // uintmax_t wrap
      let ns = n.toString();
      if (precision !== null) ns = ns.padStart(precision, '0');
      if (zeroPad && precision === null && width !== null && ns.length < width) ns = ns.padStart(width, '0');
      out = pad(ns, width ?? 0, flags);
      break;
    }
    case 'o': {
      let n = intArg(true);
      if (n < 0n) n = ((n % UINTMAX) + UINTMAX) % UINTMAX;
      let ns = n.toString(8);
      if (alt && !ns.startsWith('0')) ns = '0' + ns;
      if (precision !== null) ns = ns.padStart(precision, '0');
      if (zeroPad && precision === null && width !== null && ns.length < width) ns = ns.padStart(width, '0');
      out = pad(ns, width ?? 0, flags);
      break;
    }
    case 'x': case 'X': {
      let n = intArg(true);
      if (n < 0n) n = ((n % UINTMAX) + UINTMAX) % UINTMAX;
      let ns = n.toString(16);
      if (s === 'X') ns = ns.toUpperCase();
      const prefix = alt && n !== 0n ? (s === 'X' ? '0X' : '0x') : '';
      if (precision !== null) ns = ns.padStart(precision, '0');
      if (zeroPad && precision === null && width !== null && (prefix.length + ns.length) < width) {
        ns = ns.padStart(width - prefix.length, '0');
      }
      out = pad(prefix + ns, width ?? 0, flags);
      break;
    }
    case 'f': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) { n = 0; if (rawArg.trim() !== '') diags.push({ message: `‘${rawArg}’: expected a numeric value` }); }
      const neg = n < 0 || Object.is(n, -0);
      const ns = formatFixed(Math.abs(n), precision ?? 6);
      const sign = neg ? '-' : (plus ? '+' : (space ? ' ' : ''));
      if (zeroPad && width !== null && (sign.length + ns.length) < width) {
        out = zeroPadSigned(sign, ns, width);
      } else {
        out = pad(sign + ns, width ?? 0, flags);
      }
      break;
    }
    case 'e': case 'E': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) { n = 0; if (rawArg.trim() !== '') diags.push({ message: `‘${rawArg}’: expected a numeric value` }); }
      const neg = n < 0 || Object.is(n, -0);
      const ns = formatExp(Math.abs(n), precision ?? 6, s === 'E');
      const sign = neg ? '-' : (plus ? '+' : (space ? ' ' : ''));
      if (zeroPad && width !== null && (sign.length + ns.length) < width) {
        out = zeroPadSigned(sign, ns, width);
      } else {
        out = pad(sign + ns, width ?? 0, flags);
      }
      break;
    }
    case 'g': case 'G': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) { n = 0; if (rawArg.trim() !== '') diags.push({ message: `‘${rawArg}’: expected a numeric value` }); }
      const p = precision !== null ? precision : 6;
      const ns = formatG(Math.abs(n), p, s === 'G', alt);
      const sign = n < 0 ? '-' : (plus ? '+' : (space ? ' ' : ''));
      if (zeroPad && width !== null && (sign.length + ns.length) < width) {
        out = zeroPadSigned(sign, ns, width);
      } else {
        out = pad(sign + ns, width ?? 0, flags);
      }
      break;
    }
    default: out = '%' + s; idx--; break;
  }
  return [out, idx];
}

/** Full printf result: the produced text, any numeric diagnostics, and whether
 *  a `\c` escape truncated output (GNU: stop all further output). */
export interface SprintfResult {
  text: string;
  diags: PrintfDiag[];
  truncated: boolean;
}

export function sprintfFull(fmt: string, args: string[]): SprintfResult {
  let result = '';
  let argIdx = 0;
  const state: PassState = { diags: [], truncated: false };

  // Returns the pass text; sets `state.truncated` and stops early on `\c`.
  const doOnePass = (): string => {
    let s = '';
    let i = 0;
    while (i < fmt.length) {
      if (fmt[i] === '%' && i + 1 < fmt.length) {
        const parsed = parseNextConversion(fmt, i + 1);
        if (!parsed) { s += '%'; i++; continue; }
        const [spec, next] = parsed;
        if (spec.spec === '%') { s += '%'; i = next; continue; }
        const [out, newIdx] = applyConversion(spec, args, argIdx, state);
        s += out;
        argIdx = newIdx;
        i = next;
        if (state.truncated) return s; // `\c` inside %b stops all output
      } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
        // Format-level escape processing
        const next = fmt[i + 1];
        if (next === 'n') { s += '\n'; i += 2; }
        else if (next === 't') { s += '\t'; i += 2; }
        else if (next === 'r') { s += '\r'; i += 2; }
        else if (next === '\\') { s += '\\'; i += 2; }
        else if (next === 'a') { s += '\x07'; i += 2; }
        else if (next === 'b') { s += '\b'; i += 2; }
        else if (next === 'e') { s += '\x1b'; i += 2; }
        else if (next === 'f') { s += '\f'; i += 2; }
        else if (next === 'v') { s += '\v'; i += 2; }
        else if (next === 'c') { state.truncated = true; return s; }
        else if (next >= '0' && next <= '7') {
          // Format string bare octal: `\NNN`, up to 3 octal digits (no leading-0
          // requirement — unlike echo/%b). `\101`→A, `\0101`→\010 (0x08)+`1`.
          let oct = '';
          let j = i + 1;
          while (j < fmt.length && j < i + 4 && fmt[j] >= '0' && fmt[j] <= '7') oct += fmt[j++];
          s += String.fromCharCode(parseInt(oct, 8) & 0xff);
          i = j;
        } else if (next === 'x') {
          // `\xHH` — 1-2 hex digits; a bare `\x` (no hex) errors, same as %b.
          const hex = fmt.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/)?.[0];
          if (hex) { s += String.fromCharCode(parseInt(hex, 16)); i += 2 + hex.length; }
          else { state.diags.push({ message: 'missing hexadecimal number in escape' }); state.truncated = true; return s; }
        } else {
          s += '\\' + next; i += 2;
        }
      } else {
        s += fmt[i++];
      }
    }
    return s;
  };

  // First pass
  result += doOnePass();

  // Repeat format over remaining args (GNU behaviour), unless \c truncated.
  while (!state.truncated && argIdx < args.length) {
    const prev = argIdx;
    result += doOnePass();
    // Safety: if no conversion consumed args, stop to avoid infinite loop
    if (argIdx === prev) break;
  }

  return { text: result, diags: state.diags, truncated: state.truncated };
}

/** Text-only convenience wrapper (used by tests and callers that ignore diagnostics). */
export function sprintfAll(fmt: string, args: string[]): string {
  return sprintfFull(fmt, args).text;
}

const printfCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'printf';
  const rawArgs = io.args.slice(1);
  if (rawArgs.length === 0) {
    // No format — nothing to print (not an error per POSIX)
    return 0;
  }
  const fmt = rawArgs[0];
  const args = rawArgs.slice(1);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const { text, diags } = sprintfFull(fmt, args);
    await writeString(out, text);
    // GNU emits the formatted output, then any numeric diagnostics on stderr,
    // and exits 1 if there were any.
    for (const d of diags) await writeLine(err, `${name}: ${d.message}`);
    return diags.length > 0 ? 1 : 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(printfCommand);
export { printfCommand };
