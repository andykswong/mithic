/**
 * `seq` — print a sequence of numbers.
 *
 * Usage:
 *   seq LAST
 *   seq FIRST LAST
 *   seq FIRST STEP LAST
 *
 * Flags:
 *   -s SEP / --separator=SEP   output separator (default newline)
 *   -w / --equal-width         pad all numbers to the same width
 *   -f FMT / --format=FMT      printf-style format string (%g, %f, %e, etc.)
 *
 * GNU parity notes:
 *   - When every operand is a plain integer literal (no `.`, no exponent) and no
 *     `-f` format is given, the arithmetic runs over BigInt so arbitrarily large
 *     counts stay exact (`seq 9007199254740992 9007199254740994` — past 2^53 —
 *     never loses a digit and never hangs).
 *   - Otherwise a decimal path formats each term with a fixed number of
 *     fractional digits equal to the MAX fractional-digit count across the
 *     first/step/last literals (so `seq 1.0 3.0` → `1.0 2.0 3.0`, and
 *     `seq 0.1 0.1 0.5` avoids `0.30000000000000004`). Decimal arithmetic is
 *     done in scaled integer space to avoid binary-float drift.
 *   - An empty range (e.g. `seq 5 1`) prints nothing and still exits 0.
 */
import { defineCommand, parseArgs, CoalescingWriter, isBrokenPipe, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** A number literal accepted by `seq`, optionally in scientific notation. */
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
/** A plain integer literal (no decimal point, no exponent) — the BigInt path. */
const INT_RE = /^[+-]?\d+$/;

/** Apply a simple printf-style format string to a numeric value. */
export function applySeqFormat(fmt: string, val: number): string {
  let result = '';
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '%' && i + 1 < fmt.length) {
      i++;
      // Flags
      let flags = '';
      while (i < fmt.length && '-+0 #'.includes(fmt[i])) { flags += fmt[i++]; }
      // Width
      let width = '';
      while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { width += fmt[i++]; }
      // Precision
      let prec = '';
      if (fmt[i] === '.') {
        i++;
        while (i < fmt.length && fmt[i] >= '0' && fmt[i] <= '9') { prec += fmt[i++]; }
      }
      const spec = fmt[i++];
      if (spec === '%') { result += '%'; continue; }
      const w = width ? parseInt(width, 10) : 0;
      const p = prec !== '' ? parseInt(prec, 10) : undefined;
      const leftAlign = flags.includes('-');
      const zeroPad = flags.includes('0') && !leftAlign;
      let s: string;
      if (spec === 'f') {
        s = val.toFixed(p ?? 6);
      } else if (spec === 'e') {
        s = fixSeqExp(val.toExponential(p ?? 6));
      } else if (spec === 'E') {
        s = fixSeqExp(val.toExponential(p ?? 6)).toUpperCase();
      } else if (spec === 'g' || spec === 'G') {
        const precision = p ?? 6;
        s = precision === 0 ? val.toFixed(0) : parseFloat(val.toPrecision(precision || 1)).toString();
        if (spec === 'G') s = s.toUpperCase();
      } else {
        // Fallback: treat as %g
        s = val.toString();
      }
      if (w > s.length) {
        const pad = w - s.length;
        if (leftAlign) s = s + ' '.repeat(pad);
        else if (zeroPad) s = '0'.repeat(pad) + s;
        else s = ' '.repeat(pad) + s;
      }
      result += s;
    } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
      const esc = fmt[i + 1];
      if (esc === 'n') { result += '\n'; i += 2; }
      else if (esc === 't') { result += '\t'; i += 2; }
      else if (esc === '\\') { result += '\\'; i += 2; }
      else { result += fmt[i++]; }
    } else {
      result += fmt[i++];
    }
  }
  return result;
}

/** Force a C-style 2-digit minimum exponent (`1e+6` → `1e+06`) for `%e`/`%E`. */
function fixSeqExp(s: string): string {
  return s.replace(/[eE]([+-])(\d+)/, (_m, sign: string, digits: string) =>
    'e' + sign + (digits.length < 2 ? digits.padStart(2, '0') : digits));
}

/**
 * Fractional-digit count GNU uses to pick the output precision of a numeric
 * literal: digits after the decimal point, reduced by a positive exponent and
 * increased by a negative one (clamped at 0). `1.25e1` → 1, `1e-1` → 1, `1.0`
 * → 1, `100` → 0.
 */
export function fractionalDigits(literal: string): number {
  const m = /^[+-]?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!m) return 0;
  const frac = m[2] ?? '';
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  return Math.max(0, frac.length - exp);
}

const seqCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'seq';

  // seq has the tricky property that negative numbers like -1 appear as the
  // step argument but parseArgs would treat them as flags. We do a manual
  // two-pass: first separate flag tokens (starting with '-' that are NOT
  // numeric), then feed remaining numeric tokens as positionals.
  const rawArgs = io.args.slice(1);
  const flagTokens: string[] = [];
  const numTokens: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    // A token that looks like a number (including negatives / scientific) → operand.
    if (NUMBER_RE.test(a)) {
      numTokens.push(a);
    } else if (a === '--') {
      // Rest are operands
      for (let j = i + 1; j < rawArgs.length; j++) numTokens.push(rawArgs[j]);
      break;
    } else if (a.startsWith('-') && a !== '-') {
      // A dash-prefixed token that is not a number is a flag.
      flagTokens.push(a);
      // Consume flag value if it's a string-valued flag
      if ((a === '-s' || a === '--separator' || a === '-f' || a === '--format') && i + 1 < rawArgs.length) {
        flagTokens.push(rawArgs[++i]);
      }
    } else {
      // A non-flag, non-numeric token (e.g. `abc`, or a lone `-`) is an operand;
      // it will fail the numeric-operand validation with the GNU diagnostic.
      numTokens.push(a);
    }
  }

  const { flags } = parseArgs(flagTokens, {
    boolean: ['w', 'equal-width'],
    string: ['s', 'separator', 'f', 'format'],
    alias: { 'equal-width': 'w', separator: 's', format: 'f' },
  });
  const positionals = numTokens;

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length < 1) {
      return await exitWith(err, 1, `${name}: missing operand\nTry '${name} --help' for more information.`);
    }
    if (positionals.length > 3) {
      return await exitWith(err, 1, `${name}: extra operand ‘${positionals[3]}’\nTry '${name} --help' for more information.`);
    }
    // Validate every operand is a number (parseArgs already routed non-numbers
    // to flags, but a bare non-numeric operand would land here as a flag token).
    for (const t of positionals) {
      if (!NUMBER_RE.test(t)) {
        return await exitWith(err, 1, `${name}: invalid floating point argument: ‘${t}’\nTry '${name} --help' for more information.`);
      }
    }

    const sep = flags.s !== undefined ? String(flags.s) : '\n';
    const fmt = flags.f !== undefined ? String(flags.f) : null;
    const equalWidth = Boolean(flags.w);

    if (fmt !== null && equalWidth) {
      return await exitWith(err, 1, `${name}: format string may not be specified when printing equal width strings\nTry '${name} --help' for more information.`);
    }

    // Assign first/step/last from operand count.
    let firstStr: string, stepStr: string, lastStr: string;
    if (positionals.length === 1) { firstStr = '1'; stepStr = '1'; lastStr = positionals[0]; }
    else if (positionals.length === 2) { firstStr = positionals[0]; stepStr = '1'; lastStr = positionals[1]; }
    else { firstStr = positionals[0]; stepStr = positionals[1]; lastStr = positionals[2]; }

    // Zero step is an error regardless of path.
    if (Number(stepStr) === 0) {
      return await exitWith(err, 1, `${name}: invalid Zero increment value: ‘${stepStr}’\nTry '${name} --help' for more information.`);
    }

    // Integer BigInt path: every operand is a plain integer literal and there is
    // no custom format. Keeps arbitrarily large sequences exact and hang-free.
    const allInt = INT_RE.test(firstStr) && INT_RE.test(stepStr) && INT_RE.test(lastStr);

    const cw = new CoalescingWriter(out);
    let any = false;
    try {
      if (fmt === null && allInt) {
        any = await emitInteger(cw, sep, firstStr, stepStr, lastStr, equalWidth);
      } else {
        any = await emitDecimal(cw, sep, firstStr, stepStr, lastStr, fmt, equalWidth);
      }
      if (any) await cw.push('\n');
      await cw.flush();
    } catch (e) {
      // A downstream that closed early (`seq … | head`) breaks the pipe; that is
      // a clean stop for a producer (bash: SIGPIPE), not a seq error.
      if (!isBrokenPipe(e)) throw e;
    }
    // GNU seq exits 0 even for an empty range (`seq 5 1`).
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

/** Emit the integer (BigInt) sequence. Returns whether anything was emitted. */
async function emitInteger(
  cw: CoalescingWriter,
  sep: string,
  firstStr: string,
  stepStr: string,
  lastStr: string,
  equalWidth: boolean,
): Promise<boolean> {
  const first = BigInt(firstStr);
  const step = BigInt(stepStr);
  const last = BigInt(lastStr);

  let padWidth = 0;
  if (equalWidth) {
    padWidth = Math.max(first.toString().length, last.toString().length);
  }

  let any = false;
  let cur = first;
  const up = step > 0n;
  while (up ? cur <= last : cur >= last) {
    if (any) await cw.push(sep);
    let s = cur.toString();
    if (equalWidth) s = padNumber(s, padWidth);
    await cw.push(s);
    cur += step;
    any = true;
  }
  return any;
}

/**
 * Emit a decimal sequence using scaled-integer arithmetic (no binary drift).
 * The precision is the max fractional-digit count of first/step/last (or the
 * `-f` format handles its own formatting).
 */
async function emitDecimal(
  cw: CoalescingWriter,
  sep: string,
  firstStr: string,
  stepStr: string,
  lastStr: string,
  fmt: string | null,
  equalWidth: boolean,
): Promise<boolean> {
  const prec = Math.max(
    fractionalDigits(firstStr),
    fractionalDigits(stepStr),
    fractionalDigits(lastStr),
  );
  const scale = 10 ** prec;
  // Scaled integer representation to avoid float accumulation error.
  const toScaled = (s: string): number => Math.round(Number(s) * scale);
  const first = toScaled(firstStr);
  const step = toScaled(stepStr);
  const last = toScaled(lastStr);

  // Pre-compute the equal-width field size from the formatted endpoints.
  let padWidth = 0;
  if (equalWidth) {
    padWidth = Math.max(
      formatScaled(first, prec).length,
      formatScaled(last, prec).length,
    );
  }

  let any = false;
  let cur = first;
  const up = step > 0;
  while (up ? cur <= last : cur >= last) {
    if (any) await cw.push(sep);
    let s: string;
    if (fmt) {
      s = applySeqFormat(fmt, cur / scale);
    } else {
      s = formatScaled(cur, prec);
      if (equalWidth) s = padNumber(s, padWidth);
    }
    await cw.push(s);
    cur += step;
    any = true;
  }
  return any;
}

/** Format a scaled integer back into a fixed-precision decimal string. */
function formatScaled(scaled: number, prec: number): string {
  if (prec === 0) return String(scaled);
  const neg = scaled < 0;
  const digits = String(Math.abs(scaled)).padStart(prec + 1, '0');
  const intPart = digits.slice(0, digits.length - prec);
  const fracPart = digits.slice(digits.length - prec);
  return (neg ? '-' : '') + intPart + '.' + fracPart;
}

/**
 * Pad a formatted number to `width` with leading zeros, keeping a leading sign
 * in front of the zeros (GNU `-w`: `-1.5` and `01.0` share width 4).
 */
function padNumber(s: string, width: number): string {
  if (s.length >= width) return s;
  if (s[0] === '-' || s[0] === '+') {
    return s[0] + s.slice(1).padStart(width - 1, '0');
  }
  return s.padStart(width, '0');
}

export default defineCommand(seqCommand);
export { seqCommand };
