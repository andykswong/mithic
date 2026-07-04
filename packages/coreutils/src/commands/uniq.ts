/**
 * `uniq` — filter adjacent matching lines.
 *
 * Supported:
 *   - `-c` prefix each line with its repeat count.
 *   - `-d` only print duplicated lines (one per group); `-u` only unique lines.
 *   - `-D` / `--all-repeated[=METHOD]` print ALL lines of duplicated groups
 *     (METHOD: `none` default, `prepend`, `separate`).
 *   - `--group[=METHOD]` print all groups incl. singletons, blank-separated
 *     (METHOD: `separate` default, `prepend`, `append`, `both`).
 *   - `-i` ignore case when comparing.
 *   - `-f N` skip the first N fields; `-s N` skip the first N chars (after fields).
 *   - `-w N` compare at most N chars (after -f/-s).
 *   - `-z` NUL line delimiter (input and output).
 *   - operands: [INPUT [OUTPUT]] — INPUT `-`/none = stdin. (OUTPUT to a path
 *     is accepted but written to stdout; file output is not used by the shell.)
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, optionError, writeString, exitWith, fsErrorText } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Canonical POSIX errno text for an `fs/*` failure (see head.ts for rationale). */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory', EACCES: 'Permission denied', EEXIST: 'File exists',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ENOSPC: 'No space left on device',
  EIO: 'Input/output error',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
}

/** Split a byte stream into records on `\n` (or `\0` when `zero`). Bounded per-line. */
async function* streamRecords(
  stream: ReadableStream<Uint8Array>,
  zero: boolean,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sep = zero ? '\0' : '\n';
  let carry = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      carry += decoder.decode(value, { stream: true });
      let idx = carry.indexOf(sep);
      while (idx !== -1) {
        yield carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        idx = carry.indexOf(sep);
      }
    }
    carry += decoder.decode();
    if (carry !== '') yield carry;
  } finally {
    reader.releaseLock();
  }
}

async function readFileRecords(io: CommandIO, path: string, zero: boolean): Promise<string[]> {
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
    const sep = zero ? '\0' : '\n';
    if (text === '') return [];
    const body = text.endsWith(sep) ? text.slice(0, -1) : text;
    return body.split(sep);
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/**
 * Parse a `-f`/`-s`/`-w` count like GNU's `xstrtoumax`: optional leading
 * whitespace, an optional `+`, then decimal digits (leading zeros allowed). A
 * non-numeric value, a negative value, or a trailing size suffix is rejected —
 * matching GNU (`uniq -w 2k` is an error). Returns undefined on any of those.
 */
function parseCount(raw: string): number | undefined {
  const m = /^\s*\+?(\d+)$/.exec(raw);
  if (!m) return undefined;
  return Number(m[1]);
}

/** Drop the first `fields` whitespace-delimited fields, then the first `chars` chars, then cap at `width` chars. */
function comparand(line: string, fields: number, chars: number, width: number, ignoreCase: boolean): string {
  let s = line;
  if (fields > 0) {
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
  if (width >= 0) s = s.slice(0, width);
  return ignoreCase ? s.toLowerCase() : s;
}

type AllRepMethod = 'none' | 'prepend' | 'separate';
type GroupMethod = 'separate' | 'prepend' | 'append' | 'both';

const uniqCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  // `--all-repeated` and `--group` take an OPTIONAL argument (only via `=`), so
  // pre-extract them: parseArgs would otherwise consume the following token as a
  // string-flag value. A `--all-repeated=X` sets the method; a bare form leaves
  // it undefined. `undefined` sentinel: the flag was absent.
  const rawArgs = io.args.slice(1);
  let allRepArg: string | undefined | 'PRESENT';
  let groupArg: string | undefined | 'PRESENT';
  const preFiltered: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--') { preFiltered.push(...rawArgs.slice(i)); break; }
    if (a === '--all-repeated') { allRepArg = 'PRESENT'; continue; }
    if (a.startsWith('--all-repeated=')) { allRepArg = a.slice('--all-repeated='.length); continue; }
    if (a === '--group') { groupArg = 'PRESENT'; continue; }
    if (a.startsWith('--group=')) { groupArg = a.slice('--group='.length); continue; }
    preFiltered.push(a);
  }

  const parsed = parseArgs(preFiltered, {
    boolean: ['c', 'd', 'u', 'i', 'z', 'D', 'count', 'repeated', 'unique', 'ignore-case', 'zero-terminated'],
    string: ['f', 's', 'w', 'skip-fields', 'skip-chars', 'check-chars'],
    alias: {
      count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i',
      'skip-fields': 'f', 'skip-chars': 's', 'check-chars': 'w', 'zero-terminated': 'z',
    },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const name = io.args[0] ?? 'uniq';
  const showCount = Boolean(flags.c);
  const onlyDup = Boolean(flags.d);
  const onlyUniq = Boolean(flags.u);
  const ignoreCase = Boolean(flags.i);
  const zero = Boolean(flags.z);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;

  try {
    if (parsed.unknown.length) return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    // GNU validates the numeric argument to -f/-s/-w and errors (exit 1) on a
    // non-numeric, negative, or suffixed value rather than silently no-op'ing.
    let skipFields = 0, skipChars = 0, width = -1;
    if (flags.f !== undefined) {
      const v = parseCount(String(flags.f));
      if (v === undefined) return await exitWith(err, 1, `${name}: ${flags.f}: invalid number of fields to skip`);
      skipFields = v;
    }
    if (flags.s !== undefined) {
      const v = parseCount(String(flags.s));
      if (v === undefined) return await exitWith(err, 1, `${name}: ${flags.s}: invalid number of bytes to skip`);
      skipChars = v;
    }
    if (flags.w !== undefined) {
      const v = parseCount(String(flags.w));
      if (v === undefined) return await exitWith(err, 1, `${name}: ${flags.w}: invalid number of bytes to compare`);
      width = v;
    }
    // `-D` (bare, no arg) / `--all-repeated[=METHOD]`: print every line of each
    // duplicated group. The short `-D` never takes an argument.
    const allRepeated = Boolean(flags.D) || allRepArg !== undefined;
    let allRepMethod: AllRepMethod = 'none';
    if (allRepArg !== undefined && allRepArg !== 'PRESENT') {
      const v = allRepArg;
      if (v === 'none') allRepMethod = 'none';
      else if (v === 'prepend') allRepMethod = 'prepend';
      else if (v === 'separate') allRepMethod = 'separate';
      else return await exitWith(err, 1, `${name}: invalid argument ‘${v}’ for ‘--all-repeated’\nValid arguments are:\n  - ‘none’\n  - ‘prepend’\n  - ‘separate’\nTry '${name} --help' for more information.`);
    }

    // `--group[=METHOD]`: print all groups (incl. singletons), blank-separated.
    const grouping = groupArg !== undefined;
    let groupMethod: GroupMethod = 'separate';
    if (groupArg !== undefined && groupArg !== 'PRESENT') {
      const v = groupArg;
      if (v === 'separate') groupMethod = 'separate';
      else if (v === 'prepend') groupMethod = 'prepend';
      else if (v === 'append') groupMethod = 'append';
      else if (v === 'both') groupMethod = 'both';
      else return await exitWith(err, 1, `${name}: invalid argument ‘${v}’ for ‘--group’\nValid arguments are:\n  - ‘prepend’\n  - ‘append’\n  - ‘separate’\n  - ‘both’\nTry '${name} --help' for more information.`);
    }

    // GNU rejects incompatible combinations.
    if (allRepeated && showCount) {
      return await exitWith(err, 1, `${name}: printing all duplicated lines and repeat counts is meaningless\nTry '${name} --help' for more information.`);
    }
    if (grouping && (showCount || onlyDup || onlyUniq || allRepeated)) {
      return await exitWith(err, 1, `${name}: --group is mutually exclusive with -c/-d/-D/-u\nTry '${name} --help' for more information.`);
    }

    const sep = zero ? '\0' : '\n';

    // Emit a single group's output for the ordinary / -c / -d / -u / -D modes.
    // Returns the text to push (possibly empty) or null when the group is
    // wholly suppressed (so the group-separator logic can skip it).
    const renderGroup = (line: string, count: number, groupLines: string[]): string | null => {
      const isDup = count > 1;
      if (allRepeated) {
        if (!isDup) return null;
        return groupLines.map((l) => l + sep).join('');
      }
      // With both `-d` and `-u` a line must be BOTH duplicated and unique →
      // never (GNU prints nothing). Otherwise each flag restricts on its own.
      const keep = onlyDup && onlyUniq ? false : onlyDup ? isDup : onlyUniq ? !isDup : true;
      if (!keep) return null;
      const body = showCount ? `${String(count).padStart(7, ' ')} ${line}` : line;
      return body + sep;
    };

    const sink = new CoalescingWriter(out);

    // The core group-collapsing loop, source-agnostic (records is an async or
    // sync iterable of the input lines).
    const process = async (records: AsyncIterable<string> | Iterable<string>): Promise<void> => {
      let groupLine: string | null = null;
      let groupKey = '';
      let groupCount = 0;
      let groupLines: string[] = [];
      // For --all-repeated: track whether any emitted group came before (for
      // `separate`, insert a blank between consecutive dup groups). For --group:
      // track whether any output was written yet (for `separate`/`prepend`).
      let emittedGroups = 0;

      const flushGroup = async (): Promise<void> => {
        if (groupCount === 0) return;
        if (grouping) {
          // `separate`: blank before every group but the first.
          // `prepend`/`both`: blank before every group.
          // `append`: blank after every group (handled below).
          const before = groupMethod === 'prepend' || groupMethod === 'both' || (emittedGroups > 0 && groupMethod === 'separate');
          if (before) await sink.push(sep);
          await sink.push(groupLines.map((l) => l + sep).join(''));
          if (groupMethod === 'append') await sink.push(sep);
          emittedGroups++;
          return;
        }
        const r = renderGroup(groupLine!, groupCount, groupLines);
        if (r === null) return;
        if (allRepeated) {
          const before = allRepMethod === 'prepend' || (emittedGroups > 0 && allRepMethod === 'separate');
          if (before) await sink.push(sep);
        }
        await sink.push(r);
        emittedGroups++;
      };

      for await (const line of records) {
        const key = comparand(line, skipFields, skipChars, width, ignoreCase);
        if (groupCount > 0 && key === groupKey) { groupCount++; groupLines.push(line); continue; }
        await flushGroup();
        groupLine = line; groupKey = key; groupCount = 1; groupLines = [line];
      }
      await flushGroup();
      // `--group=both` prepends a blank to every group AND appends a single blank
      // after the last group (so the inter-group blank is not doubled).
      if (grouping && groupMethod === 'both' && emittedGroups > 0) await sink.push(sep);
      await sink.flush();
    };

    const input = positionals[0];
    if (input === undefined || input === '-') {
      try {
        await process(streamRecords(io.stdin, zero));
      } catch (e) {
        if (isBrokenPipe(e)) { stdinAborted = true; return 0; }
        throw e;
      }
      return 0;
    }

    let lines: string[];
    try { lines = await readFileRecords(io, input, zero); }
    catch (e) {
      await writeString(err, `${name}: ${input}: ${errnoText(e)}\n`);
      return 1;
    }
    await process(lines);
    return 0;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(uniqCommand);
export { uniqCommand };
