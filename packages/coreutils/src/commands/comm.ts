/**
 * `comm` — compare two sorted files line by line.
 *
 * Usage: comm [-123] [--output-delimiter=STR] [--total] file1 file2
 *
 * Three columns:
 *   col 1: lines only in file1
 *   col 2: lines only in file2
 *   col 3: lines in both files
 *
 * -1/-2/-3 suppress the respective column. Each printed line is prefixed by the
 * output delimiter (default TAB) once for every PRECEDING column that is NOT
 * suppressed — so suppressing lower columns shifts the higher ones left (GNU
 * parity: `comm -12` prints common lines with no indent). `--total` appends a
 * final `c1<D>c2<D>c3<D>total` count line.
 */
import { defineCommand, parseArgs, optionError, exitWith, readLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<string[]> {
  if (path === '-') {
    return readLines(io.stdin);
  }
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder().decode(buf);
  if (text === '') return [];
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.split('\n');
}

const commCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'comm';
  const parsed = parseArgs(io.args.slice(1), {
    boolean: ['1', '2', '3', 'total', 'nocheck-order', 'check-order', 'z', 'zero-terminated'],
    string: ['output-delimiter'],
    alias: { 'zero-terminated': 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    if (positionals.length < 2) {
      return await exitWith(err, 1, `${name}: missing operand`);
    }

    const [path1, path2] = positionals;
    let lines1: string[], lines2: string[];
    try { lines1 = await readFile(io, path1); }
    catch { return await exitWith(err, 1, `${name}: ${path1}: No such file or directory`); }
    try { lines2 = await readFile(io, path2); }
    catch { return await exitWith(err, 1, `${name}: ${path2}: No such file or directory`); }

    const show1 = !flags['1'], show2 = !flags['2'], show3 = !flags['3'];
    const delim = flags['output-delimiter'] !== undefined ? String(flags['output-delimiter']) : '\t';

    // A line in column `col` (1/2/3) is prefixed by the delimiter once for each
    // shown column that precedes it — matching GNU, so suppressing lower columns
    // pulls higher ones toward the left margin.
    const prefixFor = (col: 1 | 2 | 3): string => {
      let n = 0;
      if (col >= 2 && show1) n++;
      if (col >= 3 && show2) n++;
      return delim.repeat(n);
    };

    let c1 = 0, c2 = 0, c3 = 0;
    const emit = async (col: 1 | 2 | 3, text: string): Promise<void> => {
      await writeString(out, prefixFor(col) + text + '\n');
    };

    let i = 0, j = 0;
    while (i < lines1.length || j < lines2.length) {
      const a = lines1[i], b = lines2[j];
      if (i >= lines1.length) {
        c2++; if (show2) await emit(2, b); j++;
      } else if (j >= lines2.length) {
        c1++; if (show1) await emit(1, a); i++;
      } else if (a < b) {
        c1++; if (show1) await emit(1, a); i++;
      } else if (a > b) {
        c2++; if (show2) await emit(2, b); j++;
      } else {
        c3++; if (show3) await emit(3, a); i++; j++;
      }
    }

    if (flags['total']) {
      await writeString(out, `${c1}${delim}${c2}${delim}${c3}${delim}total\n`);
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(commCommand);
export { commCommand };
