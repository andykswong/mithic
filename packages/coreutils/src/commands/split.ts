/**
 * `split` — split a file into pieces.
 *
 * Forms (mutually exclusive):
 *   -l N   split every N lines (default 1000)
 *   -b N   split every N bytes; N accepts a size suffix (b/k/K/KB/m/M/MB/G/GB/…)
 *   -C N   split into files of at most N bytes, without splitting a line unless a
 *          single line exceeds N (line-bounded byte size)
 *   -n CHUNKS  split into CHUNKS pieces. CHUNKS is: `N` (N equal byte pieces),
 *          `l/N` (N pieces on line boundaries), `r/N` (N pieces, round-robin by
 *          line), or `K/N` (write only the K-th of N byte pieces to stdout).
 * Options:
 *   -a N / --suffix-length=N   fixed suffix length (default auto-widening from 2)
 *   --verbose                  print `creating file 'NAME'` per output file
 *   INPUT    a file path, or `-`/omitted to read stdin
 *   PREFIX   output-name prefix (default `x`)
 */
import { defineCommand, parseArgs, readAll, exitWith } from '../harness.ts';
import { readFile, writeFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** GNU size suffix multipliers shared with head/tail. */
function suffixMultiplier(suf: string): number | undefined {
  const KB = 1000, K = 1024;
  switch (suf) {
    case '': return 1;
    case 'b': return 512;
    case 'k': case 'K': return K;
    case 'KB': return KB;
    case 'm': case 'M': return K * K;
    case 'MB': return KB * KB;
    case 'G': return K ** 3;
    case 'GB': return KB ** 3;
    case 'T': return K ** 4;
    case 'TB': return KB ** 4;
    case 'P': return K ** 5;
    case 'PB': return KB ** 5;
    case 'E': return K ** 6;
    case 'EB': return KB ** 6;
    case 'Z': return K ** 7;
    case 'ZB': return KB ** 7;
    case 'Y': return K ** 8;
    case 'YB': return KB ** 8;
    default: return undefined;
  }
}

/** Parse a byte size like `512`, `1k`, `2M`, `1G` into a byte count. */
function parseSize(s: string): number | undefined {
  const m = /^(\d+)([a-zA-Z]*)$/.exec(s);
  if (!m) return undefined;
  const mult = suffixMultiplier(m[2]);
  if (mult === undefined) return undefined;
  return Number(m[1]) * mult;
}

/**
 * Generate the n-th suffix. With a fixed `width` the suffix is exactly that many
 * letters (0→aaa for width 3). With `width === 0` (auto), two letters cover the
 * first 676 pieces, then widen (aa…zz → zaaa… like GNU's auto mode).
 */
function suffixFor(index: number, width: number): string {
  if (width > 0) {
    let n = index;
    let out = '';
    for (let i = 0; i < width; i++) { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
    return out;
  }
  let w = 2;
  let span = 26 * 26;
  let base = 0;
  while (index >= base + span) { base += span; w++; span *= 26; }
  let n = index - base;
  let out = '';
  for (let i = 0; i < w; i++) { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26); }
  return out;
}

/** Split bytes into `chunk`-line groups (a final unterminated line forms its own group). */
function splitByLines(bytes: Uint8Array, chunk: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let lineNo = 0;
  let start = 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a) {
      lineNo++;
      if (lineNo % chunk === 0) { pieces.push(bytes.subarray(start, i + 1)); start = i + 1; }
    }
  }
  if (start < bytes.byteLength) pieces.push(bytes.subarray(start, bytes.byteLength));
  return pieces;
}

/** Split bytes into `chunk`-byte pieces. */
function splitByBytes(bytes: Uint8Array, chunk: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  for (let off = 0; off < bytes.byteLength; off += chunk) {
    pieces.push(bytes.subarray(off, Math.min(off + chunk, bytes.byteLength)));
  }
  return pieces;
}

/**
 * `-C N` line-bounded byte split: fill each output up to N bytes at line
 * boundaries; a line longer than N is broken into N-byte pieces.
 */
function splitByLineBytes(bytes: Uint8Array, n: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let i = 0;
  while (i < bytes.byteLength) {
    // The next line spans [i, lineEnd) (including its trailing '\n' if present).
    let lineEnd = i;
    while (lineEnd < bytes.byteLength && bytes[lineEnd] !== 0x0a) lineEnd++;
    if (lineEnd < bytes.byteLength) lineEnd++; // include the '\n'
    const lineLen = lineEnd - i;
    if (lineLen > n) {
      // A single over-long line: emit it in N-byte pieces.
      for (let off = i; off < lineEnd; off += n) pieces.push(bytes.subarray(off, Math.min(off + n, lineEnd)));
      i = lineEnd;
      continue;
    }
    // Accumulate whole lines while they fit into N bytes.
    let end = lineEnd;
    for (;;) {
      let nextEnd = end;
      while (nextEnd < bytes.byteLength && bytes[nextEnd] !== 0x0a) nextEnd++;
      if (nextEnd < bytes.byteLength) nextEnd++;
      if (nextEnd === end) break; // no more lines
      if (nextEnd - i > n) break; // adding this line would overflow N
      if (nextEnd - end > n) break; // the next line alone exceeds N → let it start fresh
      end = nextEnd;
    }
    pieces.push(bytes.subarray(i, end));
    i = end;
  }
  return pieces;
}

/** `-n N` equal byte pieces: floor(size/N) each, remainder distributed to the first pieces. */
function splitIntoN(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = bytes.byteLength;
  const pieces: Uint8Array[] = [];
  const base = Math.floor(size / parts);
  const rem = size % parts;
  let off = 0;
  for (let k = 0; k < parts; k++) {
    const len = base + (k < rem ? 1 : 0);
    pieces.push(bytes.subarray(off, off + len));
    off += len;
  }
  return pieces;
}

/** `-n r/N` round-robin by line: line i goes to piece (i mod N). */
function splitRoundRobin(bytes: Uint8Array, parts: number): Uint8Array[] {
  const lines = splitByLines(bytes, 1); // one line per element
  const buckets: number[][] = Array.from({ length: parts }, () => []);
  lines.forEach((line, idx) => { for (const b of line) buckets[idx % parts].push(b); });
  return buckets.map((b) => new Uint8Array(b));
}

const splitCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'split';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['l', 'b', 'C', 'n', 'a', 'lines', 'bytes', 'line-bytes', 'number', 'suffix-length'],
    boolean: ['verbose'],
    alias: { lines: 'l', bytes: 'b', 'line-bytes': 'C', number: 'n', 'suffix-length': 'a' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const input = positionals[0];
    const prefix = positionals[1] ?? 'x';
    const verbose = Boolean(flags.verbose);

    // At most one of -l/-b/-C/-n may be given.
    const modes = ['l', 'b', 'C', 'n'].filter((f) => flags[f] !== undefined);
    if (modes.length > 1) {
      return await exitWith(err, 1, `${name}: cannot split in more than one way\nTry '${name} --help' for more information.`);
    }

    // Suffix length (fixed) — `-a 0` / absent → auto-widening.
    let width = 0;
    if (flags.a !== undefined) {
      const w = Number(flags.a);
      if (!Number.isInteger(w) || w < 0) return await exitWith(err, 1, `${name}: invalid suffix length: ‘${flags.a}’`);
      width = w;
    }

    const bytes = await (async (): Promise<Uint8Array | undefined> => {
      if (input === undefined || input === '-') return await readAll(io.stdin);
      try { return await readFile(io, input); }
      catch { await exitWith(err, 1, `${name}: cannot open '${input}' for reading: No such file or directory`); return undefined; }
    })();
    if (bytes === undefined) return 1;

    // `-n K/N`: write only the K-th of N byte pieces to stdout (no output files).
    let selectChunk: { k: number; parts: number } | undefined;
    let pieces: Uint8Array[];

    if (flags.n !== undefined) {
      const spec = String(flags.n);
      let m: RegExpExecArray | null;
      if ((m = /^l\/(\d+)\/(\d+)$/.exec(spec))) {
        // `l/K/N`: write only the K-th of N line-boundary chunks to stdout.
        const k = Number(m[1]); const parts = Number(m[2]);
        if (parts <= 0 || k < 1 || k > parts) return await exitWith(err, 1, `${name}: invalid chunk number: ‘${m[1]}’`);
        selectChunk = { k, parts };
        pieces = splitLineChunks(bytes, parts);
      } else if ((m = /^r\/(\d+)\/(\d+)$/.exec(spec))) {
        // `r/K/N`: write only the K-th of N round-robin chunks to stdout.
        const k = Number(m[1]); const parts = Number(m[2]);
        if (parts <= 0 || k < 1 || k > parts) return await exitWith(err, 1, `${name}: invalid chunk number: ‘${m[1]}’`);
        selectChunk = { k, parts };
        pieces = splitRoundRobin(bytes, parts);
      } else if ((m = /^l\/(\d+)$/.exec(spec))) {
        const parts = Number(m[1]);
        if (parts <= 0) return await exitWith(err, 1, `${name}: invalid number of chunks: ‘${spec}’`);
        pieces = splitLineChunks(bytes, parts);
      } else if ((m = /^r\/(\d+)$/.exec(spec))) {
        const parts = Number(m[1]);
        if (parts <= 0) return await exitWith(err, 1, `${name}: invalid number of chunks: ‘${spec}’`);
        pieces = splitRoundRobin(bytes, parts);
      } else if ((m = /^(\d+)\/(\d+)$/.exec(spec))) {
        const k = Number(m[1]); const parts = Number(m[2]);
        if (parts <= 0 || k < 1 || k > parts) return await exitWith(err, 1, `${name}: invalid chunk number: ‘${m[1]}’`);
        selectChunk = { k, parts };
        pieces = splitIntoN(bytes, parts);
      } else if ((m = /^(\d+)$/.exec(spec))) {
        const parts = Number(m[1]);
        if (parts <= 0) return await exitWith(err, 1, `${name}: invalid number of chunks: ‘${spec}’`);
        pieces = splitIntoN(bytes, parts);
      } else {
        return await exitWith(err, 1, `${name}: invalid number of chunks: ‘${spec}’`);
      }
    } else if (flags.b !== undefined) {
      const n = parseSize(String(flags.b));
      if (n === undefined || n <= 0) return await exitWith(err, 1, `${name}: invalid number of bytes: ‘${flags.b}’`);
      pieces = splitByBytes(bytes, n);
    } else if (flags.C !== undefined) {
      const n = parseSize(String(flags.C));
      if (n === undefined || n <= 0) return await exitWith(err, 1, `${name}: invalid number of bytes: ‘${flags.C}’`);
      pieces = splitByLineBytes(bytes, n);
    } else {
      // Default / `-l N`: line count.
      let chunk = 1000;
      if (flags.l !== undefined) {
        const n = Number(flags.l);
        if (!Number.isInteger(n) || n <= 0) return await exitWith(err, 1, `${name}: invalid number of lines: ‘${flags.l}’`);
        chunk = n;
      }
      pieces = splitByLines(bytes, chunk);
    }

    // `-n K/N`: emit only the selected chunk to stdout.
    if (selectChunk !== undefined) {
      const piece = pieces[selectChunk.k - 1] ?? new Uint8Array();
      if (piece.byteLength > 0) await out.write(piece);
      return 0;
    }

    for (let i = 0; i < pieces.length; i++) {
      const fname = prefix + suffixFor(i, width);
      if (verbose) await out.write(new TextEncoder().encode(`creating file '${fname}'\n`));
      await writeFile(io, fname, pieces[i]);
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

/**
 * `-n l/N`: N pieces on line boundaries. Matching GNU: each line is assigned to
 * chunk `min(N-1, floor(lineStartByte * N / size))` — i.e. the chunk the line's
 * starting byte falls into under an even byte partition, but never splitting a
 * line. Empty chunks (for tiny inputs) are still created.
 */
function splitLineChunks(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = bytes.byteLength;
  const buckets: number[][] = Array.from({ length: parts }, () => []);
  let start = 0;
  const assign = (from: number, to: number): void => {
    const idx = size === 0 ? 0 : Math.min(parts - 1, Math.floor((from * parts) / size));
    for (let i = from; i < to; i++) buckets[idx].push(bytes[i]);
  };
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a) { assign(start, i + 1); start = i + 1; }
  }
  if (start < bytes.byteLength) assign(start, bytes.byteLength);
  return buckets.map((b) => new Uint8Array(b));
}

export default defineCommand(splitCommand);
export { splitCommand, parseSize, suffixFor };
