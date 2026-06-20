/**
 * `uniq` — filter adjacent matching lines.
 *
 * Supported:
 *   - `-c` prefix each line with its repeat count.
 *   - `-d` only print duplicated lines (one per group); `-u` only unique lines.
 *   - `-i` ignore case when comparing.
 *   - `-f N` skip the first N fields; `-s N` skip the first N chars (after fields).
 *   - operands: [INPUT [OUTPUT]] — INPUT `-`/none = stdin. (OUTPUT to a path
 *     is accepted but written to stdout; file output is not used by the shell.)
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, streamLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFileLines(io: CommandIO, path: string): Promise<string[]> {
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
    const text = new TextDecoder().decode(buf);
    if (text === '') return [];
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return body.split('\n');
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/** Drop the first `fields` whitespace-delimited fields, then the first `chars` chars. */
function comparand(line: string, fields: number, chars: number, ignoreCase: boolean): string {
  let s = line;
  if (fields > 0) {
    // Skip leading blanks then `fields` runs of non-blank+blank.
    let i = 0;
    let skipped = 0;
    while (skipped < fields && i < s.length) {
      while (i < s.length && /\s/.test(s[i])) i++;
      while (i < s.length && !/\s/.test(s[i])) i++;
      skipped++;
    }
    s = s.slice(i);
  }
  if (chars > 0) s = s.slice(chars);
  return ignoreCase ? s.toLowerCase() : s;
}

const uniqCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    boolean: ['c', 'd', 'u', 'i', 'count', 'repeated', 'unique', 'ignore-case'],
    string: ['f', 's', 'skip-fields', 'skip-chars'],
    alias: { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i', 'skip-fields': 'f', 'skip-chars': 's' },
  });
  const name = io.args[0] ?? 'uniq';
  const showCount = Boolean(flags.c);
  const onlyDup = Boolean(flags.d);
  const onlyUniq = Boolean(flags.u);
  const ignoreCase = Boolean(flags.i);
  const skipFields = flags.f !== undefined ? Number(flags.f) : 0;
  const skipChars = flags.s !== undefined ? Number(flags.s) : 0;

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;

  // Render an emitted group (its representative line + repeat count) per flags,
  // or null when the group is suppressed (-d/-u). Streamed group-at-a-time so
  // `producer | uniq | head` drains incrementally instead of buffering all input.
  const render = (line: string, count: number): string | null => {
    const isDup = count > 1;
    const keep = onlyDup ? isDup : onlyUniq ? !isDup : true;
    if (!keep) return null;
    return showCount ? `${String(count).padStart(7, ' ')} ${line}` : line;
  };

  try {
    const input = positionals[0];

    if (input === undefined || input === '-') {
      const sink = new CoalescingWriter(out);
      let groupLine: string | null = null;
      let groupKey = '';
      let groupCount = 0;
      try {
        for await (const { line } of streamLines(io.stdin)) {
          const key = comparand(line, skipFields, skipChars, ignoreCase);
          if (groupCount > 0 && key === groupKey) { groupCount++; continue; }
          if (groupCount > 0) {
            const r = render(groupLine!, groupCount);
            if (r !== null) await sink.push(r + '\n');
          }
          groupLine = line; groupKey = key; groupCount = 1;
        }
        if (groupCount > 0) {
          const r = render(groupLine!, groupCount);
          if (r !== null) await sink.push(r + '\n');
        }
        await sink.flush();
      } catch (e) {
        if (isBrokenPipe(e)) { stdinAborted = true; return 0; }
        throw e;
      }
      return 0;
    }

    let lines: string[];
    try { lines = await readFileLines(io, input); }
    catch (e) {
      const msg = (e as { message?: string }).message ?? 'No such file or directory';
      await writeString(err, `${name}: ${input}: ${msg}\n`);
      return 1;
    }

    const outLines: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const key = comparand(lines[i], skipFields, skipChars, ignoreCase);
      let count = 1;
      while (i + count < lines.length && comparand(lines[i + count], skipFields, skipChars, ignoreCase) === key) count++;
      const r = render(lines[i], count);
      if (r !== null) outLines.push(r);
      i += count;
    }
    if (outLines.length > 0) await writeString(out, outLines.join('\n') + '\n');
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(uniqCommand);
export { uniqCommand };
