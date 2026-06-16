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
import { defineCommand, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';
import { processEscapes } from './echo.ts';

interface ConvSpec {
  flags: string;
  width: number | null;
  precision: number | null;
  spec: string;
}

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

function pad(s: string, width: number, flags: string, padChar = ' '): string {
  if (width <= 0 || s.length >= width) return s;
  const p = padChar.repeat(width - s.length);
  return flags.includes('-') ? s + p : p + s;
}

function applyConversion(spec: ConvSpec, args: string[], argIdx: number): [string, number] {
  let idx = argIdx;
  let { width, precision } = spec;

  // Resolve * widths/precisions from args
  if (width === -1) { width = parseInt(args[idx++] ?? '0', 10); }
  if (precision === -1) { precision = parseInt(args[idx++] ?? '0', 10); }

  const rawArg = args[idx++] ?? '';
  const { flags, spec: s } = spec;

  const leftAlign = flags.includes('-');
  const zeroPad = flags.includes('0') && !leftAlign;
  const plus = flags.includes('+');
  const space = flags.includes(' ');
  const alt = flags.includes('#');

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
      let str = processEscapes(rawArg);
      if (precision !== null && precision >= 0) str = str.slice(0, precision);
      out = pad(str, width ?? 0, flags);
      break;
    }
    case 'c': out = pad(rawArg[0] ?? '\0', width ?? 0, flags); break;
    case 'd': case 'i': {
      let n = parseInt(rawArg, 10);
      if (isNaN(n)) n = 0;
      let ns = String(Math.abs(n));
      if (precision !== null) ns = ns.padStart(precision, '0');
      const sign = n < 0 ? '-' : (plus ? '+' : (space ? ' ' : ''));
      ns = sign + ns;
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      if (zeroPad && width !== null && out.length < width) {
        const signChar = out[0];
        if (signChar === '-' || signChar === '+' || signChar === ' ') {
          out = signChar + out.slice(1).padStart(width - 1, '0');
        } else {
          out = out.padStart(width, '0');
        }
      }
      break;
    }
    case 'u': {
      let n = parseInt(rawArg, 10);
      if (isNaN(n)) n = 0;
      if (n < 0) n = n >>> 0; // treat as unsigned 32-bit
      let ns = String(n);
      if (precision !== null) ns = ns.padStart(precision, '0');
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    case 'o': {
      let n = parseInt(rawArg, 10);
      if (isNaN(n)) n = 0;
      if (n < 0) n = n >>> 0;
      let ns = n.toString(8);
      if (alt && !ns.startsWith('0')) ns = '0' + ns;
      if (precision !== null) ns = ns.padStart(precision, '0');
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    case 'x': case 'X': {
      let n = parseInt(rawArg, 10);
      if (isNaN(n)) n = 0;
      if (n < 0) n = n >>> 0;
      let ns = n.toString(16);
      if (s === 'X') ns = ns.toUpperCase();
      if (alt && n !== 0) ns = (s === 'X' ? '0X' : '0x') + ns;
      if (precision !== null) ns = ns.padStart(precision, '0');
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    case 'f': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) n = 0;
      let ns = n.toFixed(precision ?? 6);
      if (plus && n >= 0) ns = '+' + ns;
      else if (space && n >= 0) ns = ' ' + ns;
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    case 'e': case 'E': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) n = 0;
      let ns = n.toExponential(precision ?? 6);
      if (s === 'E') ns = ns.toUpperCase();
      if (plus && n >= 0) ns = '+' + ns;
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    case 'g': case 'G': {
      let n = parseFloat(rawArg);
      if (isNaN(n)) n = 0;
      const p = precision !== null ? precision : 6;
      let ns = parseFloat(n.toPrecision(p || 1)).toString();
      if (s === 'G') ns = ns.toUpperCase();
      if (plus && n >= 0) ns = '+' + ns;
      out = pad(ns, width ?? 0, flags, zeroPad ? '0' : ' ');
      break;
    }
    default: out = '%' + s; idx--; break;
  }
  return [out, idx];
}

export function sprintfAll(fmt: string, args: string[]): string {
  // Process escape sequences in the format string (outside of %)
  let result = '';
  let argIdx = 0;
  let anyConversion = false;

  const doOnePass = (): string => {
    let s = '';
    let i = 0;
    while (i < fmt.length) {
      if (fmt[i] === '%' && i + 1 < fmt.length) {
        const parsed = parseNextConversion(fmt, i + 1);
        if (!parsed) { s += '%'; i++; continue; }
        const [spec, next] = parsed;
        if (spec.spec === '%') { s += '%'; i = next; continue; }
        anyConversion = true;
        const [out, newIdx] = applyConversion(spec, args, argIdx);
        s += out;
        argIdx = newIdx;
        i = next;
      } else if (fmt[i] === '\\' && i + 1 < fmt.length) {
        // Format-level escape processing
        const next = fmt[i + 1];
        if (next === 'n') { s += '\n'; i += 2; }
        else if (next === 't') { s += '\t'; i += 2; }
        else if (next === 'r') { s += '\r'; i += 2; }
        else if (next === '\\') { s += '\\'; i += 2; }
        else if (next === 'a') { s += '\x07'; i += 2; }
        else if (next === 'b') { s += '\b'; i += 2; }
        else if (next === 'f') { s += '\f'; i += 2; }
        else if (next === 'v') { s += '\v'; i += 2; }
        else if (next === '0') {
          let oct = '';
          let j = i + 2;
          while (j < fmt.length && j < i + 5 && fmt[j] >= '0' && fmt[j] <= '7') oct += fmt[j++];
          s += String.fromCharCode(parseInt(oct || '0', 8));
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

  // Repeat format over remaining args (GNU behaviour)
  while (argIdx < args.length) {
    anyConversion = false;
    const prev = argIdx;
    result += doOnePass();
    // Safety: if no conversion consumed args, stop to avoid infinite loop
    if (argIdx === prev) break;
  }

  void anyConversion;
  return result;
}

const printfCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const rawArgs = io.args.slice(1);
  if (rawArgs.length === 0) {
    // No format — nothing to print (not an error per POSIX)
    return 0;
  }
  const fmt = rawArgs[0];
  const args = rawArgs.slice(1);

  const out = io.stdout.getWriter();
  try {
    await writeString(out, sprintfAll(fmt, args));
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(printfCommand);
export { printfCommand };
