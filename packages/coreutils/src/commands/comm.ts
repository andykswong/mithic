/**
 * `comm` — compare two sorted files line by line.
 *
 * Usage: comm [-123] file1 file2
 *
 * Output is three columns:
 *   col 1: lines only in file1
 *   col 2: lines only in file2 (indented 1 tab)
 *   col 3: lines in both files (indented 2 tabs)
 *
 * -1, -2, -3 suppress columns 1, 2, 3 respectively.
 */
import { defineCommand, parseArgs, writeLine, exitWith, readLines } from '../harness.ts';
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
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['1', '2', '3'],
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length < 2) {
      return await exitWith(err, 1, `${name}: missing operand`);
    }

    const [path1, path2] = positionals;
    let lines1: string[], lines2: string[];
    try { lines1 = await readFile(io, path1); }
    catch { return await exitWith(err, 1, `${name}: ${path1}: No such file or directory`); }
    try { lines2 = await readFile(io, path2); }
    catch { return await exitWith(err, 1, `${name}: ${path2}: No such file or directory`); }

    const col1 = !flags['1'], col2 = !flags['2'], col3 = !flags['3'];

    let i = 0, j = 0;
    while (i < lines1.length || j < lines2.length) {
      const a = lines1[i], b = lines2[j];
      if (i >= lines1.length) {
        if (col2) await writeLine(out, '\t' + b);
        j++;
      } else if (j >= lines2.length) {
        if (col1) await writeLine(out, a);
        i++;
      } else if (a < b) {
        if (col1) await writeLine(out, a);
        i++;
      } else if (a > b) {
        if (col2) await writeLine(out, '\t' + b);
        j++;
      } else {
        if (col3) await writeLine(out, '\t\t' + a);
        i++; j++;
      }
    }
    return 0;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(commCommand);
export { commCommand };
