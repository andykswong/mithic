/**
 * `join` — join lines of two files on a common field.
 *
 * Forms:
 *   join [-t CHAR] [-1 N] [-2 N] FILE1 FILE2
 *     -t CHAR   field separator for input AND output (default: runs of
 *               whitespace on input, a single space on output)
 *     -1 N      join on field N of FILE1 (default 1)
 *     -2 N      join on field N of FILE2 (default 1)
 *   Either FILE may be `-` to read stdin.
 *
 * Both inputs are assumed sorted on their join field (GNU's contract). For each
 * key present in both, prints `KEY` followed by FILE1's remaining fields then
 * FILE2's remaining fields. Implements the common one-line-per-key case plus the
 * many-to-one fan-out a merge-join produces.
 */
import { defineCommand, parseArgs, writeLine, exitWith, readLines } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileLines(io: CommandIO, path: string): Promise<string[]> {
  if (path === '-') return readLines(io.stdin);
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
    await io.syscall('fs/close', { fd }).catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const text = new TextDecoder().decode(buf);
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Split a line into fields; `sep` undefined means split on whitespace runs. */
function splitFields(line: string, sep: string | undefined): string[] {
  if (sep === undefined) return line.trim() === '' ? [] : line.trim().split(/\s+/);
  return line.split(sep);
}

interface JoinRecord { key: string; fields: string[]; }

/** Parse lines into {key, fields}, keying on 1-based `field`. */
function parseRecords(lines: string[], field: number, sep: string | undefined): JoinRecord[] {
  return lines.map((line) => {
    const fields = splitFields(line, sep);
    return { key: fields[field - 1] ?? '', fields };
  });
}

const joinCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'join';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['t', '1', '2'],
  });
  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length < 2) return await exitWith(err, 1, `${name}: missing operand`);
    const sep = flags.t !== undefined ? String(flags.t) : undefined;
    const outSep = sep ?? ' ';
    const f1 = flags['1'] !== undefined ? Number(flags['1']) : 1;
    const f2 = flags['2'] !== undefined ? Number(flags['2']) : 1;

    let lines1: string[], lines2: string[];
    try { lines1 = await readFileLines(io, positionals[0]); }
    catch { return await exitWith(err, 1, `${name}: ${positionals[0]}: No such file or directory`); }
    try { lines2 = await readFileLines(io, positionals[1]); }
    catch { return await exitWith(err, 1, `${name}: ${positionals[1]}: No such file or directory`); }

    const recs1 = parseRecords(lines1, f1, sep);
    const recs2 = parseRecords(lines2, f2, sep);

    // Fields other than the join field, in original order.
    const rest = (r: JoinRecord, joinField: number): string[] =>
      r.fields.filter((_, i) => i !== joinField - 1);

    // Merge-join two key-sorted inputs (the GNU contract); a key block on one
    // side fans out against the matching block on the other.
    let i = 0, j = 0;
    while (i < recs1.length && j < recs2.length) {
      const a = recs1[i].key, b = recs2[j].key;
      if (a < b) { i++; continue; }
      if (a > b) { j++; continue; }
      // Equal keys: gather the run on each side, emit the cross product.
      let iEnd = i; while (iEnd < recs1.length && recs1[iEnd].key === a) iEnd++;
      let jEnd = j; while (jEnd < recs2.length && recs2[jEnd].key === b) jEnd++;
      for (let x = i; x < iEnd; x++) {
        for (let y = j; y < jEnd; y++) {
          const parts = [a, ...rest(recs1[x], f1), ...rest(recs2[y], f2)];
          await writeLine(out, parts.join(outSep));
        }
      }
      i = iEnd; j = jEnd;
    }
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(joinCommand);
export { joinCommand };
