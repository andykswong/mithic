/**
 * `tac` — concatenate and print files in reverse (line order).
 *
 * Reads all input (stdin or files), reverses the line order, writes to stdout.
 * A trailing newline on the last line is preserved correctly.
 */
import { defineCommand, parseArgs, readAll, writeString, writeLine } from '../harness.ts';
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

const tacCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const name = io.args[0] ?? 'tac';
  const { positionals } = parseArgs(io.args.slice(1), {});
  const sources = positionals.length > 0 ? positionals : ['-'];

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  try {
    for (const src of sources) {
      let bytes: Uint8Array;
      if (src === '-') {
        bytes = await readAll(io.stdin);
      } else {
        try {
          bytes = await readFile(io, src);
        } catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeLine(err, `${name}: ${src}: ${msg}`);
          exitCode = 1;
          continue;
        }
      }
      const text = new TextDecoder().decode(bytes);
      if (text === '') continue;
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const lines = body.split('\n').reverse();
      // Reversed: each line gets a newline; the original trailing newline is
      // now at the start, which means every line in the reversed output gets \n.
      await writeString(out, lines.join('\n') + '\n');
    }
    return exitCode;
  } finally {
    await out.close().catch(() => { /* already closed */ });
    await err.close().catch(() => { /* already closed */ });
  }
};

export default defineCommand(tacCommand);
export { tacCommand };
