/**
 * `diff` — compare two files line by line.
 *
 * Flags:
 *   -u / --unified    unified diff output (3-line context)
 *   -q / --brief      only report whether files differ (no patch output)
 *
 * Exit codes: 0 = identical, 1 = different, 2 = error.
 *
 * Algorithm: O(mn) LCS table (patience-diff style grouping for unified output).
 * Good enough for the file sizes typical in a sandboxed shell session.
 */
import { defineCommand, parseArgs, writeLine, writeString, exitWith } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
  const { fd } = (await io.syscall('fs/open', { path, oflags: {} })) as { fd: number };
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
      if (!chunk || chunk.byteLength === 0) break;
      chunks.push(chunk); total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  return dp;
}

type EditOp = ' ' | '-' | '+';

function editScript(a: string[], b: string[]): Array<[EditOp, string]> {
  const dp = lcsTable(a, b);
  const ops: Array<[EditOp, string]> = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push([' ', a[i]]); i++; j++;
    } else if (i < a.length && (j >= b.length || dp[i+1][j] >= dp[i][j+1])) {
      ops.push(['-', a[i]]); i++;
    } else {
      ops.push(['+', b[j]]); j++;
    }
  }
  return ops;
}

/** Normal diff output (no context lines, shows change hunks as c/a/d). */
function normalDiff(a: string[], b: string[]): string[] {
  // Collect raw -/+ contiguous runs mapped to line numbers
  const ops = editScript(a, b);
  const lines: string[] = [];
  let ai = 1, bi = 1;
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === ' ') { ai++; bi++; k++; continue; }
    // Collect contiguous non-context ops
    const start = k;
    const aStart = ai, bStart = bi;
    const del: string[] = [], add: string[] = [];
    while (k < ops.length && ops[k][0] !== ' ') {
      if (ops[k][0] === '-') { del.push(ops[k][1]); ai++; }
      else { add.push(ops[k][1]); bi++; }
      k++;
    }
    const aEnd = ai - 1, bEnd = bi - 1;
    if (del.length > 0 && add.length > 0) {
      lines.push(`${rangeStr(aStart, aEnd)}c${rangeStr(bStart, bEnd)}`);
      for (const l of del) lines.push('< ' + l);
      lines.push('---');
      for (const l of add) lines.push('> ' + l);
    } else if (del.length > 0) {
      lines.push(`${rangeStr(aStart, aEnd)}d${bStart - 1}`);
      for (const l of del) lines.push('< ' + l);
    } else {
      lines.push(`${aStart - 1}a${rangeStr(bStart, bEnd)}`);
      for (const l of add) lines.push('> ' + l);
    }
    void start; // suppress unused-var lint
  }
  return lines;
}

function rangeStr(start: number, end: number): string {
  return start === end ? String(start) : `${start},${end}`;
}

/** Unified diff output with `context` lines of surrounding context. */
function unifiedDiff(a: string[], b: string[], file1: string, file2: string, context = 3): string {
  const ops = editScript(a, b);
  if (ops.every(([t]) => t === ' ')) return '';

  const CONTEXT = context;
  // Find hunk extents: indices in ops[] where changes occur
  const hunks: Array<[number, number]> = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] !== ' ') {
      const lo = Math.max(0, k - CONTEXT);
      let hi = k + 1;
      while (hi < ops.length && ops[hi][0] !== ' ') hi++;
      hi = Math.min(ops.length, hi + CONTEXT);
      // Merge with previous hunk if they overlap
      if (hunks.length > 0 && lo <= hunks[hunks.length - 1][1]) {
        hunks[hunks.length - 1][1] = hi;
      } else {
        hunks.push([lo, hi]);
      }
      k = hi;
    } else {
      k++;
    }
  }

  let out = `--- ${file1}\n+++ ${file2}\n`;
  for (const [lo, hi] of hunks) {
    // Count a/b line ranges for the hunk header
    let aStart = 1, bStart = 1;
    let ai = 0, bi = 0;
    for (let x = 0; x < ops.length; x++) {
      if (x === lo) { aStart = ai + 1; bStart = bi + 1; }
      if (ops[x][0] !== '+') ai++;
      if (ops[x][0] !== '-') bi++;
    }
    let aCount = 0, bCount = 0;
    let hunkBody = '';
    for (let x = lo; x < hi; x++) {
      const [t, line] = ops[x];
      if (t !== '+') aCount++;
      if (t !== '-') bCount++;
      hunkBody += t + line + '\n';
    }
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n` + hunkBody;
  }
  return out;
}

const diffCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'diff';
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['u', 'unified', 'q', 'brief'],
    alias: { unified: 'u', brief: 'q' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  try {
    if (positionals.length < 2) {
      return await exitWith(err, 2, `${name}: missing operand`);
    }
    const [path1, path2] = positionals;

    let bytes1: Uint8Array, bytes2: Uint8Array;
    try { bytes1 = await readFile(io, path1); }
    catch { return await exitWith(err, 2, `${name}: ${path1}: No such file or directory`); }
    try { bytes2 = await readFile(io, path2); }
    catch { return await exitWith(err, 2, `${name}: ${path2}: No such file or directory`); }

    const dec = new TextDecoder();
    const splitLines = (text: string): string[] => {
      if (text === '') return [];
      const t = text.endsWith('\n') ? text.slice(0, -1) : text;
      return t.split('\n');
    };
    const lines1 = splitLines(dec.decode(bytes1));
    const lines2 = splitLines(dec.decode(bytes2));

    const brief = Boolean(flags.q);
    const unified = Boolean(flags.u);

    if (brief) {
      if (lines1.join('\n') !== lines2.join('\n')) {
        await writeLine(out, `Files ${path1} and ${path2} differ`);
        return 1;
      }
      return 0;
    }

    if (unified) {
      const patch = unifiedDiff(lines1, lines2, path1, path2);
      if (patch === '') return 0;
      await writeString(out, patch);
      return 1;
    }

    const chunks = normalDiff(lines1, lines2);
    if (chunks.length === 0) return 0;
    for (const line of chunks) await writeLine(out, line);
    return 1;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(diffCommand);
export { diffCommand };
