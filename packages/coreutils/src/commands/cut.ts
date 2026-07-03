/**
 * `cut` — remove sections from each line.
 *
 * Supported:
 *   - `-f LIST` with `-d DELIM` (default TAB); `-s` only lines containing delim.
 *   - `-c LIST` select characters; `-b LIST` select bytes.
 *   - LIST ranges: `1,3`, `1-3`, `2-`, `-3` (combinable, e.g. `1,4-6,9-`).
 *   - `--complement` inverts the selection.
 *   - `--output-delimiter=STR` (field mode joins with STR instead of `-d`; in
 *     char/byte mode STR is inserted between the merged selected runs).
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * LIST validation mirrors GNU: bad values / decreasing ranges / a bare `-` / a
 * position of 0 all fail loud (exit 1) with GNU's diagnostic. Only one of
 * `-b/-c/-f` may be given; `-d`/`-s` require `-f`.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, optionError, parseArgs, streamLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

// Note: `readFileText` (below) handles file operands; stdin is streamed.

/** A selection range; `to === Infinity` means "to end of line". 1-based inclusive. */
interface Range { from: number; to: number; }

/** A LIST parse failure: `message` is GNU's diagnostic (no trailing newline). */
export class ListError extends Error {}

/**
 * GNU cut quotes an offending token with U+2018/U+2019 curly quotes, e.g.
 * `invalid field value ‘x’`.
 */
function quote(s: string): string { return `‘${s}’`; }

/**
 * Parse a cut LIST like "1,4-6,9-" into normalized, sorted, merged ranges.
 * `field` selects GNU's wording (field vs byte/character). Throws {@link ListError}
 * on any malformed token, matching GNU's diagnostics exactly.
 */
export function parseList(spec: string, field: boolean): Range[] {
  const invalidValue = field ? 'invalid field value' : 'invalid byte/character position';
  const numberedFrom1 = field ? 'fields are numbered from 1' : 'byte/character positions are numbered from 1';
  const invalidRange = field ? 'invalid field range' : 'invalid byte or character range';

  // GNU treats a single blank like a comma as an item separator; two adjacent
  // separators (or a leading/trailing one) yield an empty item = position 0,
  // which GNU rejects with "numbered from 1".
  const parts = spec.split(/[,\s]/);
  const ranges: Range[] = [];
  for (const part of parts) {
    if (part === '') throw new ListError(numberedFrom1);
    if (part.includes('-')) {
      const dash = part.indexOf('-');
      const a = part.slice(0, dash);
      const b = part.slice(dash + 1);
      // A range must not itself contain another dash (e.g. `1--2`, `1-2-`).
      if (b.includes('-')) throw new ListError(invalidRange);
      if (a === '' && b === '') throw new ListError('invalid range with no endpoint: -');
      const from = a === '' ? 1 : parsePos(a, invalidValue, numberedFrom1);
      const to = b === '' ? Infinity : parsePos(b, invalidValue, numberedFrom1);
      if (to < from) throw new ListError('invalid decreasing range');
      ranges.push({ from, to });
    } else {
      const n = parsePos(part, invalidValue, numberedFrom1);
      ranges.push({ from: n, to: n });
    }
  }
  ranges.sort((x, y) => x.from - y.from);
  return ranges;
}

/** Parse a single 1-based position, validating like GNU (`>= 1`, all digits). */
function parsePos(tok: string, invalidValue: string, numberedFrom1: string): number {
  if (!/^\d+$/.test(tok)) throw new ListError(`${invalidValue} ${quote(tok)}`);
  const n = Number(tok);
  if (n === 0) throw new ListError(numberedFrom1);
  return n;
}

/**
 * Reduce a selection to the merged, ascending list of covered runs (adjacent /
 * overlapping ranges merged), optionally complemented against `[1, max]`. Used
 * for char/byte output-delimiter placement. `Infinity` upper bounds are clamped
 * to `max` (the line's unit count).
 */
function selectedRuns(ranges: Range[], complement: boolean, max: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const from = r.from;
    const to = Math.min(r.to, max);
    if (from > max || to < from) continue;
    // GNU merges two selected ranges only when they OVERLAP (share an index),
    // not when merely adjacent — so `1-2,3-4` stays two runs but `1-2,2-3` is one.
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  if (!complement) return merged;
  // Complement: the gaps between the merged runs across [1, max].
  const out: Array<[number, number]> = [];
  let cursor = 1;
  for (const [from, to] of merged) {
    if (from > cursor) out.push([cursor, from - 1]);
    cursor = to + 1;
  }
  if (cursor <= max) out.push([cursor, max]);
  return out;
}

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

type Mode =
  | { kind: 'fields'; ranges: Range[]; complement: boolean; delim: string; outDelim: string; onlyDelim: boolean }
  | { kind: 'chars'; ranges: Range[]; complement: boolean; outDelim: string | null }
  | { kind: 'bytes'; ranges: Range[]; complement: boolean; outDelim: string | null };

function fieldSelected(index1: number, ranges: Range[], complement: boolean): boolean {
  const hit = ranges.some((r) => index1 >= r.from && index1 <= r.to);
  return complement ? !hit : hit;
}

function cutLine(line: string, mode: Mode): string | null {
  if (mode.kind === 'fields') {
    if (!line.includes(mode.delim)) {
      return mode.onlyDelim ? null : line; // -s suppresses lines without the delim
    }
    const parts = line.split(mode.delim);
    const picked: string[] = [];
    for (let i = 0; i < parts.length; i++) if (fieldSelected(i + 1, mode.ranges, mode.complement)) picked.push(parts[i]);
    return picked.join(mode.outDelim);
  }
  // chars and bytes operate on code points / bytes; treat chars as code points.
  const units: string[] | number[] = mode.kind === 'chars'
    ? [...line]
    : Array.from(new TextEncoder().encode(line), (b) => b);
  const runs = selectedRuns(mode.ranges, mode.complement, units.length);
  if (mode.kind === 'chars') {
    const arr = units as string[];
    const segments = runs.map(([from, to]) => arr.slice(from - 1, to).join(''));
    return segments.join(mode.outDelim ?? '');
  }
  const bytes = units as number[];
  const dec = new TextDecoder();
  const segments = runs.map(([from, to]) => dec.decode(new Uint8Array(bytes.slice(from - 1, to))));
  return segments.join(mode.outDelim ?? '');
}

const cutCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const parsed = parseArgs(io.args.slice(1), {
    string: ['f', 'c', 'b', 'd', 'output-delimiter'],
    boolean: ['s', 'only-delimited', 'complement', 'n'],
    alias: { 'only-delimited': 's' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;
  const name = io.args[0] ?? 'cut';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;

  const fail = async (msg: string): Promise<number> => {
    await writeString(err, `${msg}\nTry '${name} --help' for more information.\n`);
    return 1;
  };

  try {
    if (parsed.unknown.length) { await writeString(err, optionError(name, parsed.unknown[0]) + '\n'); return 1; }
    const delim = flags.d !== undefined ? String(flags.d) : '\t';
    const onlyDelim = Boolean(flags.s);
    const complement = Boolean(flags.complement);
    const modeCount = (flags.b !== undefined ? 1 : 0) + (flags.c !== undefined ? 1 : 0) + (flags.f !== undefined ? 1 : 0);
    if (modeCount > 1) return await fail(`${name}: only one list may be specified`);

    let mode: Mode;
    try {
      if (flags.b !== undefined) {
        if (flags.d !== undefined) return await fail(`${name}: an input delimiter makes sense\n\tonly when operating on fields`);
        if (onlyDelim) return await fail(`${name}: suppressing non-delimited lines makes sense\n\tonly when operating on fields`);
        const outDelim = flags['output-delimiter'] !== undefined ? String(flags['output-delimiter']) : null;
        mode = { kind: 'bytes', ranges: parseList(String(flags.b), false), complement, outDelim };
      } else if (flags.c !== undefined) {
        if (flags.d !== undefined) return await fail(`${name}: an input delimiter makes sense\n\tonly when operating on fields`);
        if (onlyDelim) return await fail(`${name}: suppressing non-delimited lines makes sense\n\tonly when operating on fields`);
        const outDelim = flags['output-delimiter'] !== undefined ? String(flags['output-delimiter']) : null;
        mode = { kind: 'chars', ranges: parseList(String(flags.c), false), complement, outDelim };
      } else if (flags.f !== undefined) {
        if (delim.length > 1) return await fail(`${name}: the delimiter must be a single character`);
        const outDelim = flags['output-delimiter'] !== undefined ? String(flags['output-delimiter']) : delim;
        mode = { kind: 'fields', ranges: parseList(String(flags.f), true), complement, delim, outDelim, onlyDelim };
      } else {
        await writeString(err, `${name}: you must specify a list of bytes, characters, or fields\n`);
        return 1;
      }
    } catch (e) {
      if (e instanceof ListError) return await fail(`${name}: ${e.message}`);
      throw e;
    }

    const sources = positionals.length > 0 ? positionals : ['-'];
    let exitCode = 0;
    for (const src of sources) {
      if (src === '-') {
        // Stream stdin line-by-line (each line is independent in cut), coalescing
        // writes so the pipeline drains incrementally instead of buffering all.
        const sink = new CoalescingWriter(out);
        try {
          for await (const { line, eol } of streamLines(io.stdin)) {
            const cut = cutLine(line, mode);
            if (cut !== null) await sink.push(cut + (eol ? '\n' : ''));
          }
          await sink.flush();
        } catch (e) {
          if (isBrokenPipe(e)) { stdinAborted = true; break; }
          throw e;
        }
        continue;
      }
      let text: string;
      try { text = await readFileText(io, src); }
      catch (e) {
        const msg = (e as { message?: string }).message ?? 'No such file or directory';
        await writeString(err, `${name}: ${src}: ${msg}\n`);
        exitCode = 1;
        continue;
      }
      if (text === '') continue;
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const lines = body.split('\n');
      const outLines: string[] = [];
      for (const line of lines) {
        const cut = cutLine(line, mode);
        if (cut !== null) outLines.push(cut);
      }
      if (outLines.length > 0) await writeString(out, outLines.join('\n') + (hasTrailing ? '\n' : ''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(cutCommand);
export { cutCommand };
