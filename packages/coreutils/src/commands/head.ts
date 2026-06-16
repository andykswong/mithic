/**
 * `head` — output the first part of files.
 *
 * Supported:
 *   - `-n N` / `--lines=N`: first N lines (default 10). Legacy `-N` (e.g. `-5`).
 *   - `-c N` / `--bytes=N`: first N bytes.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: print `==> NAME <==` headers (unless `-q`); `-v` forces headers.
 *   - `-q` / `--quiet` / `--silent`: never print headers.
 */
import { defineCommand, parseArgs, readAll, writeBytes, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

async function readFile(io: CommandIO, path: string): Promise<Uint8Array> {
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
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
  } finally {
    await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
  }
}

/** First `n` lines of bytes, preserving the trailing newline of the last kept line. */
function headLines(bytes: Uint8Array, n: number): Uint8Array {
  if (n <= 0) return new Uint8Array();
  let seen = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      seen++;
      if (seen === n) return bytes.subarray(0, i + 1);
    }
  }
  return bytes; // fewer than n lines: everything
}

const headCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  // Pull out a legacy `-N` numeric flag (e.g. `-5`) before generic parsing.
  const rawArgs = io.args.slice(1);
  let legacyN: number | undefined;
  const filtered = rawArgs.filter((a) => {
    const m = /^-([0-9]+)$/.exec(a);
    if (m) { legacyN = Number(m[1]); return false; }
    return true;
  });

  const { positionals, flags } = parseArgs(filtered, {
    string: ['n', 'c', 'lines', 'bytes'],
    boolean: ['q', 'v', 'quiet', 'silent', 'verbose'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v' },
  });
  const name = io.args[0] ?? 'head';

  const byteMode = flags.c !== undefined;
  const count = byteMode
    ? Number(flags.c)
    : flags.n !== undefined ? Number(flags.n) : legacyN !== undefined ? legacyN : 10;

  const sources = positionals.length > 0 ? positionals : ['-'];
  const wantHeaders = Boolean(flags.v) || (sources.length > 1 && !flags.q);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let printed = 0;

  try {
    for (const src of sources) {
      let bytes: Uint8Array;
      if (src === '-') {
        bytes = await readAll(io.stdin);
      } else {
        try { bytes = await readFile(io, src); }
        catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: cannot open '${src}' for reading: ${msg}\n`);
          exitCode = 1;
          continue;
        }
      }
      if (wantHeaders) {
        const label = src === '-' ? 'standard input' : src;
        await writeString(out, `${printed > 0 ? '\n' : ''}==> ${label} <==\n`);
      }
      printed++;
      const piece = byteMode ? bytes.subarray(0, Math.max(0, count)) : headLines(bytes, count);
      await writeBytes(out, piece);
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(headCommand);
export { headCommand };
