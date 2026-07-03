/**
 * `wc` — print newline, word, and byte/char counts for each file.
 *
 * Supported:
 *   - `-l` lines, `-w` words, `-c` bytes, `-m` chars, `-L` longest line length.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: prints a final `total` line.
 *
 * Field-width matches GNU `wc` (see {@link fieldWidth}): a single count from a
 * single source prints with no padding; otherwise every printed field is
 * right-aligned to a common width derived from the largest count, with a floor
 * of 7 when any input is a pipe (stdin) whose size cannot be known ahead of time.
 */
import { defineCommand, exitWith, optionError, parseArgs, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

interface Counts { lines: number; words: number; chars: number; bytes: number; maxLine: number; }

/**
 * Display width of a single code point, matching `wcwidth`: combining marks and
 * zero-width chars are 0; CJK/fullwidth ranges are 2; everything else is 1. This
 * is a pragmatic subset of Unicode's East-Asian-Width table — enough for the
 * common CJK/fullwidth cases `wc -L` reports as double-width. (Infeasible to ship
 * the full table here; matches GNU for the ranges below.)
 */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  // Zero-width: combining marks, ZWSP/ZWNJ/ZWJ, variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) || cp === 0x200b || cp === 0x200c ||
    cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)
  ) return 0;
  // Wide (East-Asian Wide/Fullwidth) ranges.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji/symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) return 2;
  return 1;
}

/** Longest display width among the input's lines (tab → next multiple of 8). */
function longestLineWidth(text: string): number {
  let max = 0;
  let col = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a) { if (col > max) max = col; col = 0; continue; }
    if (cp === 0x09) { col = Math.floor(col / 8) * 8 + 8; continue; }
    col += charWidth(cp);
  }
  if (col > max) max = col; // final line without trailing newline
  return max;
}

function count(bytes: Uint8Array): Counts {
  const text = new TextDecoder().decode(bytes);
  let lines = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lines++;
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  const chars = [...text].length;
  return { lines, words, chars, bytes: bytes.byteLength, maxLine: longestLineWidth(text) };
}

const WS = /\s/;

/**
 * Count a stream INCREMENTALLY without buffering it. Words/chars carry state
 * across chunk boundaries; the TextDecoder runs in streaming mode so a multibyte
 * sequence split across chunks counts as one code point. `maxLine` tracks the
 * longest display width (tab-expanded) across chunks via the running column.
 */
async function countStream(stream: ReadableStream<Uint8Array>): Promise<Counts> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const c: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
  let inWord = false;
  let col = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      c.bytes += value.byteLength;
      for (let i = 0; i < value.byteLength; i++) if (value[i] === 0x0a) c.lines++;
      const text = decoder.decode(value, { stream: true });
      for (const ch of text) {
        c.chars++;
        const cp = ch.codePointAt(0)!;
        if (cp === 0x0a) { if (col > c.maxLine) c.maxLine = col; col = 0; }
        else if (cp === 0x09) col = Math.floor(col / 8) * 8 + 8;
        else col += charWidth(cp);
        if (WS.test(ch)) inWord = false;
        else if (!inWord) { inWord = true; c.words++; }
      }
    }
    for (const _ of decoder.decode()) c.chars++; // flush any trailing partial char
    if (col > c.maxLine) c.maxLine = col; // final line without trailing newline
  } finally {
    reader.releaseLock();
  }
  return c;
}

const wcCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['l', 'w', 'c', 'm', 'L', 'lines', 'words', 'bytes', 'chars', 'max-line-length'],
    alias: { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L' },
    unknown: 'error',
  });
  const name = io.args[0] ?? 'wc';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();

  if (parsed.unknown.length) {
    try { return await exitWith(err, 1, optionError(name, parsed.unknown[0])); }
    finally { await out.close().catch(() => {}); await err.close().catch(() => {}); }
  }

  const { positionals, flags } = parsed;
  const showL = Boolean(flags.l);
  const showW = Boolean(flags.w);
  const showC = Boolean(flags.c);
  const showM = Boolean(flags.m);
  const showLen = Boolean(flags.L);
  const anySelected = showL || showW || showC || showM || showLen;
  const sel = anySelected
    ? { l: showL, w: showW, c: showC, m: showM, L: showLen }
    : { l: true, w: true, c: true, m: false, L: false };
  // GNU prints fields in the fixed order: lines, words, chars, bytes, max-line.
  const fieldOrder: (keyof Counts)[] = [];
  if (sel.l) fieldOrder.push('lines');
  if (sel.w) fieldOrder.push('words');
  if (sel.m) fieldOrder.push('chars');
  if (sel.c) fieldOrder.push('bytes');
  if (sel.L) fieldOrder.push('maxLine');

  // No operands → implicit stdin, printed with no label. An explicit `-` operand
  // is stdin too but keeps its `-` label (GNU parity).
  const hadOperands = positionals.length > 0;
  const sources = hadOperands ? positionals : ['-'];
  const anyStdin = sources.includes('-');
  let exitCode = 0;

  const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0, maxLine: 0 };
  const rows: { counts: Counts; label: string }[] = [];

  try {
    for (const src of sources) {
      let c: Counts;
      if (src === '-') {
        c = await countStream(io.stdin);
      } else {
        try { c = count(await readFile(io, src)); }
        catch (e) {
          await writeString(err, `${name}: ${src}: ${(e as { message?: string }).message ?? 'No such file or directory'}\n`);
          exitCode = 1;
          continue;
        }
      }
      total.lines += c.lines; total.words += c.words; total.chars += c.chars; total.bytes += c.bytes;
      // A -L total is the MAX longest line across files, not the sum.
      if (c.maxLine > total.maxLine) total.maxLine = c.maxLine;
      rows.push({ counts: c, label: !hadOperands && src === '-' ? '' : src });
    }

    // GNU prints a `total` line whenever more than one operand was given (even
    // if some failed to open — the total then reflects the ones that succeeded).
    const withTotal = sources.length > 1;
    const printed = withTotal ? [...rows, { counts: total, label: 'total' }] : rows;

    // Field width matches GNU `wc`: 0 (no padding) for a single count field from
    // a single source; otherwise the digit-count of the TOTAL byte count (the
    // upper bound GNU derives from stat'd file sizes), floored at 7 when any
    // input is a pipe (stdin) whose byte size cannot be known before reading.
    let width = 0;
    if (fieldOrder.length > 1 || sources.length > 1) {
      width = anyStdin ? 7 : String(total.bytes).length;
    }

    for (const { counts, label } of printed) {
      const body = fieldOrder.map((f) => String(counts[f]).padStart(width, ' ')).join(' ');
      await writeString(out, label ? `${body} ${label}\n` : `${body}\n`);
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(wcCommand);
export { wcCommand };
