/**
 * `fold` — wrap each input line to fit a given width.
 *
 * Supported:
 *   - `-w N` / `--width=N`: wrap at N columns (default 80).
 *   - `-s` / `--spaces`: break at the last blank within the width when possible.
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * Wrapping is by character count (no tab-column expansion).
 */
import { CoalescingWriter, defineCommand, isBrokenPipe, parseArgs, streamLines, writeString } from '../harness.ts';
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

export function foldLine(line: string, width: number, atSpaces: boolean): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > width) {
    let cut = width;
    if (atSpaces) {
      // Find the last blank at or before the width boundary.
      const slice = rest.slice(0, width);
      const lastSpace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
      if (lastSpace > 0) cut = lastSpace + 1; // keep the blank with the wrapped chunk
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

const foldCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['w', 'width'],
    boolean: ['s', 'spaces'],
    alias: { width: 'w', spaces: 's' },
  });
  const name = io.args[0] ?? 'fold';
  const width = flags.w !== undefined ? Number(flags.w) : 80;
  const atSpaces = Boolean(flags.s);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let stdinAborted = false;

  try {
    if (!(width > 0)) {
      await writeString(err, `${name}: invalid number of columns\n`);
      return 1;
    }
    const sources = positionals.length > 0 ? positionals : ['-'];
    for (const src of sources) {
      if (src === '-') {
        // Stream stdin; each input line wraps independently. Coalesce writes.
        const sink = new CoalescingWriter(out);
        try {
          for await (const { line, eol } of streamLines(io.stdin)) {
            await sink.push(foldLine(line, width, atSpaces).join('\n') + (eol ? '\n' : ''));
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
      const outParts: string[] = [];
      for (const line of lines) outParts.push(...foldLine(line, width, atSpaces));
      await writeString(out, outParts.join('\n') + (hasTrailing ? '\n' : ''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
};

export default defineCommand(foldCommand);
export { foldCommand };
