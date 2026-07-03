/**
 * `rev` — reverse the characters of each line.
 *
 * Supported:
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - Reverses by Unicode code point. A trailing newline is preserved.
 */
import { CoalescingWriter, defineCommand, fsErrorText, isBrokenPipe, parseArgs, streamLines, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Canonical POSIX errno text for an `fs/*` failure. Over the real kernel the
 * error carries a POSIX errno `code` (e.g. `ENOENT`) with a provider-specific
 * message; {@link fsErrorText} maps only the VFS codes, so translate the errno
 * first and fall back to it for the VFS-code path used by the unit tests.
 */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EACCES: 'Permission denied',
  EISDIR: 'Is a directory',
  ENOTDIR: 'Not a directory',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
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

function revLine(line: string): string {
  return [...line].reverse().join('');
}

function revText(text: string): string {
  if (text === '') return '';
  // BSD `rev` terminates every output line with a newline, even when the input's
  // final line was unterminated.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n').map((l) => revLine(l) + '\n').join('');
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
          // BSD `rev` always newline-terminates each output line.
          for await (const { line } of streamLines(io.stdin)) {
            await sink.push(revLine(line) + '\n');
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
          await writeString(err, `${name}: ${src}: ${errnoText(e)}\n`);
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
