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
 */
import { defineCommand, parseArgs, CoalescingWriter, isBrokenPipe, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

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
        s = val.toExponential(p ?? 6);
      } else if (spec === 'E') {
        s = val.toExponential(p ?? 6).toUpperCase();
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

/** Format a number for equal-width output: determine field width from bounds. */
function numStr(val: number, isFloat: boolean): string {
  if (!isFloat && Number.isFinite(val)) return String(Math.round(val));
  return String(val);
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
    // A token that looks like a number (including negative decimals) → positional
    if (/^-?(\d+\.?\d*|\.\d+)$/.test(a)) {
      numTokens.push(a);
    } else if (a === '--') {
      // Rest are positionals
      for (let j = i + 1; j < rawArgs.length; j++) numTokens.push(rawArgs[j]);
      break;
    } else {
      flagTokens.push(a);
      // Consume flag value if it's a string-valued flag
      if ((a === '-s' || a === '--separator' || a === '-f' || a === '--format') && i + 1 < rawArgs.length) {
        flagTokens.push(rawArgs[++i]);
      }
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
    if (positionals.length < 1 || positionals.length > 3) {
      return await exitWith(err, 1, `${name}: invalid usage`);
    }

    const nums = positionals.map(Number);
    if (nums.some(isNaN)) {
      return await exitWith(err, 1, `${name}: invalid number`);
    }

    let first: number, step: number, last: number;
    if (positionals.length === 1) { first = 1; step = 1; last = nums[0]; }
    else if (positionals.length === 2) { first = nums[0]; step = 1; last = nums[1]; }
    else { first = nums[0]; step = nums[1]; last = nums[2]; }

    if (step === 0) return await exitWith(err, 1, `${name}: zero step`);

    const sep = flags.s !== undefined ? String(flags.s) : '\n';
    const fmt = flags.f !== undefined ? String(flags.f) : null;
    const equalWidth = Boolean(flags.w);
    const isFloat = [first, step, last].some(n => !Number.isInteger(n));

    // Determine equal-width padding from start and end
    let padWidth = 0;
    if (equalWidth && !fmt) {
      const s1 = numStr(first, isFloat);
      const sLast = numStr(last, isFloat);
      padWidth = Math.max(s1.length, sLast.length);
    }

    // Coalesce output: `seq 1 100000` emits one short token per line, and a
    // per-token `await writer.write()` parks on the pipe's flush timer (~one
    // token/tick → tens of seconds for large counts — a de facto hang). The
    // CoalescingWriter buffers and flushes in 32 KiB blocks while preserving
    // incremental streaming (downstream EPIPE still surfaces on the next flush).
    const cw = new CoalescingWriter(out);
    let any = false;
    let cur = first;
    try {
      while ((step > 0 ? cur <= last : cur >= last)) {
        if (any) await cw.push(sep);
        let s: string;
        if (fmt) {
          s = applySeqFormat(fmt, cur);
        } else if (isFloat) {
          s = String(cur);
        } else {
          s = String(Math.round(cur));
        }
        if (equalWidth && !fmt && s.length < padWidth) {
          s = s.padStart(padWidth, '0');
        }
        await cw.push(s);
        cur += step;
        any = true;
      }
      if (any) await cw.push('\n');
      await cw.flush();
    } catch (e) {
      // A downstream that closed early (`seq … | head`) breaks the pipe; that is
      // a clean stop for a producer (bash: SIGPIPE), not a seq error.
      if (!isBrokenPipe(e)) throw e;
    }
    return any ? 0 : 1;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(seqCommand);
export { seqCommand };
