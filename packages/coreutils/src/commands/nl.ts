/**
 * `nl` — number lines.
 *
 * Supported:
 *   - `-b a` number all lines; `-b t` number only non-empty lines (default `t`).
 *   - `-w N` number field width (default 6).
 *   - `-s STR` separator between number and line (default TAB).
 *   - operands: file paths; `-` (or none) reads stdin.
 *
 * Non-numbered lines are emitted with blank padding in place of the number.
 */
import { defineCommand, parseArgs, readAllText, writeString } from '../harness.ts';
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

const nlCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['b', 'w', 's', 'body-numbering', 'number-width', 'number-separator'],
    alias: { 'body-numbering': 'b', 'number-width': 'w', 'number-separator': 's' },
  });
  const name = io.args[0] ?? 'nl';
  const bodyStyle = flags.b !== undefined ? String(flags.b) : 't'; // a=all, t=non-empty, n=none
  const width = flags.w !== undefined ? Number(flags.w) : 6;
  const sep = flags.s !== undefined ? String(flags.s) : '\t';

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;

  try {
    const sources = positionals.length > 0 ? positionals : ['-'];
    let lineNo = 1;
    const blank = ' '.repeat(width);
    for (const src of sources) {
      let text: string;
      if (src === '-') text = await readAllText(io.stdin);
      else {
        try { text = await readFileText(io, src); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: ${src}: ${msg}\n`);
          exitCode = 1;
          continue;
        }
      }
      if (text === '') continue;
      const hasTrailing = text.endsWith('\n');
      const body = hasTrailing ? text.slice(0, -1) : text;
      const lines = body.split('\n');
      const outParts: string[] = [];
      for (const line of lines) {
        const numberThis = bodyStyle === 'a' || (bodyStyle === 't' && line !== '');
        if (numberThis) {
          outParts.push(String(lineNo++).padStart(width, ' ') + sep + line);
        } else {
          outParts.push(blank + line);
        }
      }
      await writeString(out, outParts.join('\n') + (hasTrailing ? '\n' : ''));
    }
    return exitCode;
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
};

export default defineCommand(nlCommand);
export { nlCommand };
