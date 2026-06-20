/**
 * `rev` — reverse the characters of each line.
 *
 * Supported:
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - Reverses by Unicode code point. A trailing newline is preserved.
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

function revLine(line: string): string {
  return [...line].reverse().join('');
}

function revText(text: string): string {
  if (text === '') return '';
  const hasTrailing = text.endsWith('\n');
  const body = hasTrailing ? text.slice(0, -1) : text;
  const reversed = body.split('\n').map(revLine).join('\n');
  return hasTrailing ? reversed + '\n' : reversed;
}

const revCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals } = parseArgs(io.args.slice(1), {});
  const name = io.args[0] ?? 'rev';
  const sources = positionals.length > 0 ? positionals : ['-'];

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let stdinAborted = false;

  try {
    for (const src of sources) {
      if (src === '-') {
        // Stream stdin line-by-line (coalescing writes) so an unbounded producer
        // terminates once our downstream closes (broken pipe), rather than
        // buffering all of it. Coalescing avoids a per-line flush-timer crawl.
        const sink = new CoalescingWriter(out);
        try {
          for await (const { line, eol } of streamLines(io.stdin)) {
            await sink.push(revLine(line) + (eol ? '\n' : ''));
          }
          await sink.flush();
        } catch (e) {
          if (isBrokenPipe(e)) { stdinAborted = true; break; }
          throw e;
        }
      } else {
        let text: string;
        try { text = await readFileText(io, src); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: cannot open ${src}: ${msg}\n`);
          exitCode = 1;
          continue;
        }
        await writeString(out, revText(text));
      }
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinAborted) await io.stdin.cancel().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(revCommand);
export { revCommand };
