/**
 * `split` — split a file into pieces.
 *
 * Forms:
 *   split [-l N] [-b N] [INPUT [PREFIX]]
 *     -l N   split every N lines (default 1000)
 *     -b N   split every N bytes; N accepts a `k`/`K` (×1024) or `m`/`M`
 *            (×1048576) suffix
 *   INPUT    a file path, or `-`/omitted to read stdin
 *   PREFIX   output-name prefix (default `x`)
 *
 * Output files are PREFIX + a two-letter suffix `aa`, `ab`, … `az`, `ba`, …
 * (GNU's default suffix length is 2). When more than 26² pieces are produced the
 * suffix simply widens — but in practice this command handles the common case.
 */
import { defineCommand, parseArgs, readAll, exitWith } from '../harness.ts';
import { readFile, writeFile } from '../fs.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Parse a byte size like `512`, `1k`, `2M` into a byte count. */
function parseSize(s: string): number | undefined {
  const m = /^(\d+)([kKmM]?)$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (m[2] === 'k' || m[2] === 'K') return n * 1024;
  if (m[2] === 'm' || m[2] === 'M') return n * 1024 * 1024;
  return n;
}

/** Generate the n-th two-letter (or wider) suffix: 0→aa, 1→ab, … */
function suffixFor(index: number): string {
  // Two letters cover the first 676 pieces; beyond that, widen to three, etc.
  let width = 2;
  let span = 26 * 26;
  let base = 0;
  while (index >= base + span) { base += span; width++; span *= 26; }
  let n = index - base;
  let out = '';
  for (let i = 0; i < width; i++) {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

const splitCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'split';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['l', 'b'],
    alias: { lines: 'l', bytes: 'b' },
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    const input = positionals[0];
    const prefix = positionals[1] ?? 'x';

    let byBytes = false;
    let chunk = 1000;
    if (flags.b !== undefined) {
      const n = parseSize(String(flags.b));
      if (n === undefined || n <= 0) return await exitWith(err, 1, `${name}: invalid number of bytes: '${flags.b}'`);
      byBytes = true;
      chunk = n;
    } else if (flags.l !== undefined) {
      const n = Number(flags.l);
      if (!Number.isInteger(n) || n <= 0) return await exitWith(err, 1, `${name}: invalid number of lines: '${flags.l}'`);
      chunk = n;
    }

    let bytes: Uint8Array;
    if (input === undefined || input === '-') {
      bytes = await readAll(io.stdin);
    } else {
      try { bytes = await readFile(io, input); }
      catch { return await exitWith(err, 1, `${name}: cannot open '${input}' for reading: No such file or directory`); }
    }

    const pieces: Uint8Array[] = [];
    if (byBytes) {
      for (let off = 0; off < bytes.byteLength; off += chunk) {
        pieces.push(bytes.subarray(off, Math.min(off + chunk, bytes.byteLength)));
      }
    } else {
      // Split on newlines, keeping the terminator with each line; group `chunk`
      // lines per piece. A final unterminated line forms its own group.
      let lineNo = 0;
      let pieceStart = 0;
      for (let i = 0; i < bytes.byteLength; i++) {
        if (bytes[i] === 0x0a) {
          lineNo++;
          if (lineNo % chunk === 0) {
            pieces.push(bytes.subarray(pieceStart, i + 1));
            pieceStart = i + 1;
          }
        }
      }
      if (pieceStart < bytes.byteLength) pieces.push(bytes.subarray(pieceStart, bytes.byteLength));
    }

    for (let i = 0; i < pieces.length; i++) {
      await writeFile(io, prefix + suffixFor(i), pieces[i]);
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(splitCommand);
export { splitCommand, parseSize, suffixFor };
