/**
 * `head` — output the first part of files.
 *
 * Supported:
 *   - `-n N` / `--lines=N`: first N lines (default 10). Legacy `-N` (e.g. `-5`).
 *   - `-c N` / `--bytes=N`: first N bytes.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: print `==> NAME <==` headers (unless `-q`); `-v` forces headers.
 *   - `-q` / `--quiet` / `--silent`: never print headers.
 *
 * Early termination (parity finding H5): `head` reads INCREMENTALLY and stops the
 * instant its `-c`/`-n` limit is reached — it never buffers the whole input. When
 * it stops early on stdin it CANCELS the stream so the upstream producer sees a
 * broken pipe (EPIPE) and stops too; this lets `yes | head -n3` and
 * `head -c4 /dev/zero` (a never-EOFing character device) terminate instead of
 * spinning forever.
 */
import { defineCommand, parseArgs, writeBytes, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const LIMIT = -1; // sentinel: a limit was reached, stop reading

/**
 * Stream the first `count` bytes of a fd, stopping as soon as `count` is
 * reached. Returns when the limit is hit OR the source EOFs; never reads past
 * `count` bytes (so a never-EOFing device like /dev/zero terminates).
 */
async function headFileBytes(io: CommandIO, fd: number, count: number, out: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  let remaining = count;
  while (remaining > 0) {
    const want = Math.min(remaining, 65536);
    const chunk = (await io.syscall('fs/read', { fd, len: want })) as Uint8Array;
    if (!chunk || chunk.byteLength === 0) break; // genuine EOF
    const piece = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    await writeBytes(out, piece);
    remaining -= piece.byteLength;
  }
}

/**
 * Stream the first `n` lines of a fd, stopping once the n-th newline lands.
 * Reads chunk-wise; never buffers the whole file. Terminates on EOF or limit.
 */
async function headFileLines(io: CommandIO, fd: number, n: number, out: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  if (n <= 0) return;
  let seen = 0;
  for (;;) {
    const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
    if (!chunk || chunk.byteLength === 0) break; // EOF
    // Find the byte offset just past the n-th newline, if it lands in this chunk.
    let cut = chunk.byteLength;
    for (let i = 0; i < chunk.byteLength; i++) {
      if (chunk[i] === 0x0a) {
        seen++;
        if (seen === n) { cut = i + 1; break; }
      }
    }
    await writeBytes(out, cut === chunk.byteLength ? chunk : chunk.subarray(0, cut));
    if (seen >= n) return;
  }
}

/**
 * Stream the first `count` bytes from stdin, then cancel the stream so the
 * upstream producer sees EPIPE. Returns LIMIT if it stopped at the limit (so the
 * caller can cancel stdin), or 0 if stdin EOFed first.
 */
async function headStdinBytes(stdin: ReadableStream<Uint8Array>, count: number, out: WritableStreamDefaultWriter<Uint8Array>): Promise<number> {
  if (count <= 0) return LIMIT;
  const reader = stdin.getReader();
  let remaining = count;
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) return 0;
      if (!value || value.byteLength === 0) continue;
      const piece = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      await writeBytes(out, piece);
      remaining -= piece.byteLength;
    }
    return LIMIT;
  } finally {
    reader.releaseLock();
  }
}

/** Stream the first `n` lines from stdin. Returns LIMIT if stopped at the limit. */
async function headStdinLines(stdin: ReadableStream<Uint8Array>, n: number, out: WritableStreamDefaultWriter<Uint8Array>): Promise<number> {
  if (n <= 0) return LIMIT;
  const reader = stdin.getReader();
  let seen = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return 0;
      if (!value || value.byteLength === 0) continue;
      let cut = value.byteLength;
      for (let i = 0; i < value.byteLength; i++) {
        if (value[i] === 0x0a) {
          seen++;
          if (seen === n) { cut = i + 1; break; }
        }
      }
      await writeBytes(out, cut === value.byteLength ? value : value.subarray(0, cut));
      if (seen >= n) return LIMIT;
    }
  } finally {
    reader.releaseLock();
  }
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
  let stdinHitLimit = false;

  try {
    for (const src of sources) {
      if (wantHeaders) {
        const label = src === '-' ? 'standard input' : src;
        await writeString(out, `${printed > 0 ? '\n' : ''}==> ${label} <==\n`);
      }
      printed++;
      if (src === '-') {
        const r = byteMode
          ? await headStdinBytes(io.stdin, Math.max(0, count), out)
          : await headStdinLines(io.stdin, count, out);
        if (r === LIMIT) stdinHitLimit = true;
      } else {
        let fd: number;
        try {
          ({ fd } = (await io.syscall('fs/open', { path: src, oflags: {} })) as { fd: number });
        } catch (e) {
          const msg = (e as { message?: string }).message ?? 'No such file or directory';
          await writeString(err, `${name}: cannot open '${src}' for reading: ${msg}\n`);
          exitCode = 1;
          continue;
        }
        try {
          if (byteMode) await headFileBytes(io, fd, Math.max(0, count), out);
          else await headFileLines(io, fd, count, out);
        } finally {
          await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
        }
      }
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    // If we stopped reading stdin early, cancel it so the upstream producer
    // receives a broken pipe (EPIPE) and stops, rather than spinning forever.
    if (stdinHitLimit) await io.stdin.cancel().catch(() => {});
  }
  return exitCode;
};

export default defineCommand(headCommand);
export { headCommand };
