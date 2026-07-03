/**
 * `paste` — merge lines of files.
 *
 * Supported:
 *   - default: merge corresponding lines of all files, TAB-separated.
 *   - `-d LIST`: cycle through delimiter chars in LIST (`\t`, `\n`, `\0`, `\\`).
 *   - `-s`: serial — concatenate all lines of each file onto one line.
 *   - `-z`: line delimiter is NUL for both input and output (not newline).
 *   - operands: file paths; `-` (or none) reads stdin. Multiple `-` in merge
 *     mode read stdin round-robin per output row (`paste - -` pairs adjacent
 *     lines); in `-s` mode the first `-` drains stdin, later `-` see EOF.
 */
import { defineCommand, isBrokenPipe, optionError, parseArgs, readAllText, streamLines, writeString, CoalescingWriter } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileText(io: CommandIO, path: string): Promise<string> {
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
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(buf);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/** Expand a -d LIST into delimiter chars, honoring `\t \n \0 \\`. */
export function parseDelims(spec: string): string[] {
  if (spec === '') return [''];
  const out: string[] = [];
  let i = 0;
  while (i < spec.length) {
    if (spec[i] === '\\' && i + 1 < spec.length) {
      const map: Record<string, string> = { t: '\t', n: '\n', '0': '', '\\': '\\' };
      out.push(map[spec[i + 1]] ?? spec[i + 1]);
      i += 2;
    } else { out.push(spec[i]); i++; }
  }
  return out.length > 0 ? out : [''];
}

/** Split `text` into lines on `sep` (a single char), dropping one trailing separator. */
function splitLines(text: string, sep: string): string[] {
  if (text === '') return [];
  const body = text.endsWith(sep) ? text.slice(0, -1) : text;
  return body.split(sep);
}

const pasteCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    string: ['d', 'delimiters'],
    boolean: ['s', 'serial', 'z', 'zero-terminated'],
    alias: { delimiters: 'd', serial: 's', 'zero-terminated': 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const name = io.args[0] ?? 'paste';
  const delims = flags.d !== undefined ? parseDelims(String(flags.d)) : ['\t'];
  const serial = Boolean(flags.s);
  const zero = Boolean(flags.z);
  const lineSep = zero ? '\0' : '\n';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  const exitCode = 0;
  let stdinAborted = false;

  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    const sources = positionals.length > 0 ? positionals : ['-'];

    // Fast path: a single stdin source in merge mode (no -s, no -z) is just a
    // line passthrough — stream it (constant memory) so `producer | paste | head`
    // terminates instead of buffering an unbounded input.
    if (!serial && !zero && sources.length === 1 && sources[0] === '-') {
      const sink = new CoalescingWriter(out);
      try {
        for await (const { line } of streamLines(io.stdin)) {
          await sink.push(line + '\n');
        }
        await sink.flush();
      } catch (e) {
        if (isBrokenPipe(e)) { stdinAborted = true; }
        else throw e;
      }
      return exitCode;
    }

    // Read stdin at most once (shared by all `-` sources).
    let stdinText: string | null = null;
    const readStdin = async (): Promise<string> => {
      if (stdinText === null) stdinText = await readAllText(io.stdin);
      return stdinText;
    };

    // GNU opens/reads all inputs before producing output; a missing file aborts
    // with no output at all (exit 1).
    const fileLines: string[][] = [];
    const dashIndices: number[] = [];
    for (const src of sources) {
      if (src === '-') {
        dashIndices.push(fileLines.length);
        fileLines.push(splitLines(await readStdin(), lineSep));
      } else {
        let text: string;
        try { text = await readFileText(io, src); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: ${src}: ${msg}\n`);
          return 1;
        }
        fileLines.push(splitLines(text, lineSep));
      }
    }

    if (serial) {
      // One output line per source: that source's lines joined by cycling delims.
      // Multiple `-` share one stdin read, so only the first `-` sees any lines;
      // later `-` sources are empty (splitLines('') === []).
      let firstDashUsed = false;
      const outLines = fileLines.map((lines, idx) => {
        if (dashIndices.includes(idx)) {
          if (firstDashUsed) lines = [];
          firstDashUsed = true;
        }
        return lines.map((l, i) => (i === 0 ? l : delims[(i - 1) % delims.length] + l)).join('');
      });
      if (outLines.length > 0) await writeString(out, outLines.join(lineSep) + lineSep);
      return exitCode;
    }

    // Merge: multiple `-` sources read the SHARED stdin round-robin per row, so
    // for each row the dash columns consume consecutive stdin lines.
    const stdinLines = dashIndices.length > 0 ? fileLines[dashIndices[0]] : [];
    const numDashes = dashIndices.length;
    const dashRank = new Map<number, number>();
    dashIndices.forEach((srcIdx, rank) => dashRank.set(srcIdx, rank));

    const nonDashMax = fileLines.reduce(
      (m, lines, idx) => (dashRank.has(idx) ? m : Math.max(m, lines.length)),
      0,
    );
    const dashRows = numDashes > 0 ? Math.ceil(stdinLines.length / numDashes) : 0;
    const maxRows = Math.max(nonDashMax, dashRows);

    const rows: string[] = [];
    for (let r = 0; r < maxRows; r++) {
      let row = '';
      for (let f = 0; f < fileLines.length; f++) {
        if (f > 0) row += delims[(f - 1) % delims.length];
        const rank = dashRank.get(f);
        if (rank !== undefined) row += stdinLines[r * numDashes + rank] ?? '';
        else row += fileLines[f][r] ?? '';
      }
      rows.push(row);
    }
    if (rows.length > 0) await writeString(out, rows.join(lineSep) + lineSep);
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(pasteCommand);
export { pasteCommand };
