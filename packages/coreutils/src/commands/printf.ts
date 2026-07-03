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
 *   - an out-of-intmax-range value → clamped to INTMAX_MIN/MAX, `Result too large`.
 * GNU prints the diagnostic on stderr, still emits the (clamped/zero) value, and
 * exits 1.
 */
function parseIntArg(raw: string): { value: bigint; diag?: PrintfDiag } {
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
  // Clamp to intmax_t range (GNU: "Result too large" + exit 1).
  if (value > INTMAX_MAX) return { value: INTMAX_MAX, diag: { message: `‘${raw}’: Result too large` } };
  if (value < INTMAX_MIN) return { value: INTMAX_MIN, diag: { message: `‘${raw}’: Result too large` } };
  return { value };
}

function pad(s: string, width: number, flags: string, padChar = ' '): string {
  if (width <= 0 || s.length >= width) return s;
  const p = padChar.repeat(width - s.length);
  return flags.includes('-') ? s + p : p + s;
}

/** Force a C-style 2-digit minimum exponent (`1e+6` → `1e+06`). */
function fixExp(s: string): string {
  return s.replace(/[eE]([+-])(\d+)/, (_m, sign: string, digits: string) =>
    'e' + sign + (digits.length < 2 ? digits.padStart(2, '0') : digits));
}

/**
 * C `%g` for a non-negative value `n`: precision `prec` significant digits
 * (0 → 1). Uses `%e` when the decimal exponent is < -4 or >= prec, else `%f`.
 * Trailing zeros are stripped unless the `#` (alt) flag is set.
 */
function formatG(n: number, prec: number, upper: boolean, alt: boolean): string {
  const p = prec === 0 ? 1 : prec;
  let body: string;
  if (n === 0) {
    body = '0';
  } else {
    const exp = Math.floor(Math.log10(n));
    if (exp < -4 || exp >= p) {
      body = n.toExponential(p - 1);
      if (!alt) body = body.replace(/\.?0+e/, 'e');
      body = fixExp(body);
    } else {
      body = n.toFixed(Math.max(0, p - 1 - exp));
      if (!alt && body.includes('.')) body = body.replace(/\.?0+$/, '');
    }
  }
  return upper ? body.toUpperCase() : body;
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
  const intArg = (): bigint => {
    const r = parseIntArg(rawArg);
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
      const esc = processEscapesFull(rawArg);
      if (esc.truncated) state.truncated = true; // `\c` in %b stops all output
      let str = esc.text;
      if (precision !== null && precision >= 0) str = str.slice(0, precision);
      out = pad(str, width ?? 0, flags);
      break;
    }
    case 'c': out = pad(rawArg[0] ?? '\0', width ?? 0, flags); break;
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
      let n = intArg();
      if (n < 0n) n = ((n % UINTMAX) + UINTMAX) % UINTMAX; // uintmax_t wrap
      let ns = n.toString();
      if (precision !== null) ns = ns.padStart(precision, '0');
      if (zeroPad && precision === null && width !== null && ns.length < width) ns = ns.padStart(width, '0');
      out = pad(ns, width ?? 0, flags);
      break;
    }
    case 'o': {
      let n = intArg();
      if (n < 0n) n = ((n % UINTMAX) + UINTMAX) % UINTMAX;
      let ns = n.toString(8);
      if (alt && !ns.startsWith('0')) ns = '0' + ns;
      if (precision !== null) ns = ns.padStart(precision, '0');
      if (zeroPad && precision === null && width !== null && ns.length < width) ns = ns.padStart(width, '0');
      out = pad(ns, width ?? 0, flags);
      break;
    }
    case 'x': case 'X': {
      let n = intArg();
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
      const ns = Math.abs(n).toFixed(precision ?? 6);
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
      let ns = fixExp(Math.abs(n).toExponential(precision ?? 6));
      if (s === 'E') ns = ns.toUpperCase();
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
