/**
 * `tail` — output the last part of files.
 *
 * Supported:
 *   - `-n N` / `--lines=N`: last N lines (default 10). `-n +N` starts at line N.
 *   - `-c N` / `--bytes=N`: last N bytes. `-c +N` starts at byte N.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: `==> NAME <==` headers (unless `-q`).
 *   - `-q` / `--quiet` / `--silent`: never print headers.
 *
 * Not supported: `-f` (follow). tail reads to EOF and exits; there is no
 * streaming follow mode in a one-shot sandboxed process.
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

/** A count spec: either "last n" (fromStart=false) or "from index n" (1-based, fromStart=true). */
interface CountSpec { n: number; fromStart: boolean; }

function parseCount(raw: string): CountSpec {
  if (raw.startsWith('+')) return { n: Number(raw.slice(1)), fromStart: true };
  return { n: Number(raw), fromStart: false };
}

function tailLines(bytes: Uint8Array, spec: CountSpec): Uint8Array {
  // Offsets where each line starts (byte after each \n, plus 0).
  const starts: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && i + 1 < bytes.length) starts.push(i + 1);
  }
  if (spec.fromStart) {
    // `-n +N`: output starting from line N (1-based). +1 = whole file.
    const idx = Math.max(1, spec.n) - 1;
    if (idx >= starts.length) return new Uint8Array();
    return bytes.subarray(starts[idx]);
  }
  if (spec.n <= 0) return new Uint8Array();
  // count of lines = number of starts, but a trailing newline does not add an empty line
  const lineStarts = starts;
  const from = Math.max(0, lineStarts.length - spec.n);
  return bytes.subarray(lineStarts[from]);
}

function tailBytes(bytes: Uint8Array, spec: CountSpec): Uint8Array {
  if (spec.fromStart) {
    const idx = Math.max(1, spec.n) - 1;
    return idx >= bytes.length ? new Uint8Array() : bytes.subarray(idx);
  }
  if (spec.n <= 0) return new Uint8Array();
  return bytes.subarray(Math.max(0, bytes.length - spec.n));
}

const tailCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const { positionals, flags } = parseArgs(io.args.slice(1), {
    string: ['n', 'c', 'lines', 'bytes'],
    boolean: ['q', 'v', 'quiet', 'silent', 'verbose', 'f', 'follow'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', follow: 'f' },
  });
  const name = io.args[0] ?? 'tail';

  const byteMode = flags.c !== undefined;
  const spec = byteMode
    ? parseCount(String(flags.c))
    : flags.n !== undefined ? parseCount(String(flags.n)) : { n: 10, fromStart: false };

  const sources = positionals.length > 0 ? positionals : ['-'];
  const wantHeaders = Boolean(flags.v) || (sources.length > 1 && !flags.q);

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let printed = 0;

  try {
    if (flags.f) {
      await writeString(err, `${name}: -f (follow) is not supported; reading to EOF\n`);
    }
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
      const piece = byteMode ? tailBytes(bytes, spec) : tailLines(bytes, spec);
      await writeBytes(out, piece);
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(tailCommand);
export { tailCommand };
