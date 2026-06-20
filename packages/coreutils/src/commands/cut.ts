/**
 * `cut` — remove sections from each line.
 *
 * Supported:
 *   - `-f LIST` with `-d DELIM` (default TAB); `-s` only lines containing delim.
 *   - `-c LIST` select characters; `-b LIST` select bytes.
 *   - LIST ranges: `1,3`, `1-3`, `2-`, `-3` (combinable, e.g. `1,4-6,9-`).
 *   - `--output-delimiter=STR` (field mode joins with STR instead of `-d`).
 *   - operands: file paths; `-` (or none) reads stdin.
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, streamLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

// Note: `readFileText` (below) handles file operands; stdin is streamed.

/** A selection range; `to === Infinity` means "to end of line". 1-based inclusive. */
interface Range { from: number; to: number; }

/** Parse a cut LIST like "1,4-6,9-" into normalized, sorted, merged ranges. */
export function parseList(spec: string): Range[] {
  const ranges: Range[] = [];
  for (const part of spec.split(',')) {
    if (part === '') continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-');
      const from = a === '' ? 1 : Number(a);
      const to = b === '' ? Infinity : Number(b);
      ranges.push({ from, to });
    } else {
      const n = Number(part);
      ranges.push({ from: n, to: n });
    }
  }
  ranges.sort((x, y) => x.from - y.from);
  return ranges;
}

function selected(index1: number, ranges: Range[]): boolean {
  return ranges.some((r) => index1 >= r.from && index1 <= r.to);
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
  | { kind: 'fields'; ranges: Range[]; delim: string; outDelim: string; onlyDelim: boolean }
  | { kind: 'chars'; ranges: Range[] }
  | { kind: 'bytes'; ranges: Range[] };

function cutLine(line: string, mode: Mode): string | null {
  if (mode.kind === 'fields') {
    if (!line.includes(mode.delim)) {
      return mode.onlyDelim ? null : line; // -s suppresses lines without the delim
    }
    const parts = line.split(mode.delim);
    const picked: string[] = [];
    for (let i = 0; i < parts.length; i++) if (selected(i + 1, mode.ranges)) picked.push(parts[i]);
    return picked.join(mode.outDelim);
  }
  // chars and bytes operate on code points / bytes; treat chars as code points.
  const units = mode.kind === 'chars' ? [...line] : Array.from(new TextEncoder().encode(line), (b) => b);
  if (mode.kind === 'chars') {
    const arr = units as string[];
    let out = '';
    for (let i = 0; i < arr.length; i++) if (selected(i + 1, mode.ranges)) out += arr[i];
    return out;
  }
  const bytes = units as number[];
  const picked: number[] = [];
  for (let i = 0; i < bytes.length; i++) if (selected(i + 1, mode.ranges)) picked.push(bytes[i]);
  return new TextDecoder().decode(new Uint8Array(picked));
}

const cutCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['f', 'c', 'b', 'd', 'output-delimiter'],
    boolean: ['s', 'only-delimited'],
    alias: { 'only-delimited': 's' },
  });
  const name = io.args[0] ?? 'cut';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let stdinAborted = false;

  try {
    const delim = flags.d !== undefined ? String(flags.d) : '\t';
    const onlyDelim = Boolean(flags.s);
    let mode: Mode;
    if (flags.b !== undefined) {
      mode = { kind: 'bytes', ranges: parseList(String(flags.b)) };
    } else if (flags.c !== undefined) {
      mode = { kind: 'chars', ranges: parseList(String(flags.c)) };
    } else if (flags.f !== undefined) {
      const outDelim = flags['output-delimiter'] !== undefined ? String(flags['output-delimiter']) : delim;
      mode = { kind: 'fields', ranges: parseList(String(flags.f)), delim, outDelim, onlyDelim };
    } else {
      await writeString(err, `${name}: you must specify a list of bytes, characters, or fields\n`);
      return 1;
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
