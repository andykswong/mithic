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
import { defineCommand, parseArgs, writeBytes, writeString } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/**
 * Read stdin into the bytes tail must finally emit, in BOUNDED memory — the OOM
 * fix for `producer | tail`. For "last N" modes we retain only the tail:
 *   - last N bytes: a ring of ≤N bytes (drop the oldest as new bytes arrive).
 *   - last N lines: a ring of ≤N+1 line fragments (a line is at most one extra
 *     for the in-progress final line); we keep ≤N completed lines plus the tail.
 * For "from start" (`+N`) modes nothing is retained beyond the small skip prefix;
 * the bytes after the start point are emitted as they arrive.
 *
 * NOTE: tail of an INFINITE stdin in a last-N mode never reaches EOF and so never
 * emits — that is correct POSIX behavior; the point of the ring is that it does
 * so in O(N) memory instead of OOM-ing the host.
 */
async function tailStdin(
  stdin: ReadableStream<Uint8Array>,
  spec: CountSpec,
  byteMode: boolean,
  out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const reader = stdin.getReader();
  try {
    if (spec.fromStart) {
      // `-c +N` / `-n +N`: emit from the start point onward; bounded (no retention).
      await tailFromStart(reader, spec, byteMode, out);
      return;
    }
    if (byteMode) {
      // Ring of the last N bytes.
      const n = spec.n;
      if (n <= 0) return;
      const ring = new Uint8Array(n);
      let len = 0;       // bytes currently in the ring
      let start = 0;     // index of the oldest byte
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        for (let i = 0; i < value.byteLength; i++) {
          ring[(start + len) % n] = value[i];
          if (len < n) len++; else start = (start + 1) % n;
        }
      }
      const ordered = new Uint8Array(len);
      for (let i = 0; i < len; i++) ordered[i] = ring[(start + i) % n];
      await writeBytes(out, ordered);
      return;
    }
    // Ring of the last N lines (line = bytes up to and including a '\n', or the
    // final unterminated fragment). We retain at most N completed lines plus the
    // in-progress tail.
    const n = spec.n;
    if (n <= 0) return;
    const lines: Uint8Array[] = []; // completed lines (each ends with '\n')
    let pending: number[] = [];     // current line bytes (no '\n' yet)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      for (let i = 0; i < value.byteLength; i++) {
        pending.push(value[i]);
        if (value[i] === 0x0a) {
          lines.push(new Uint8Array(pending));
          if (lines.length > n) lines.shift();
          pending = [];
        }
      }
    }
    if (pending.length > 0) {
      lines.push(new Uint8Array(pending));
      if (lines.length > n) lines.shift();
    }
    for (const line of lines) await writeBytes(out, line);
  } finally {
    reader.releaseLock();
  }
}

/** Stream stdin emitting bytes/lines from a `+N` start point, in bounded memory. */
async function tailFromStart(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  spec: CountSpec,
  byteMode: boolean,
  out: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  if (byteMode) {
    // Emit from 1-based byte index N onward; skip the first N-1 bytes.
    let skip = Math.max(0, Math.max(1, spec.n) - 1);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (skip >= value.byteLength) { skip -= value.byteLength; continue; }
      const piece = skip > 0 ? value.subarray(skip) : value;
      skip = 0;
      await writeBytes(out, piece);
    }
    return;
  }
  // Emit from 1-based line index N onward; count newlines to find the start.
  const startLine = Math.max(1, spec.n);
  let line = 1; // 1-based line we are currently in
  let emitting = startLine <= 1;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (emitting) { await writeBytes(out, value); continue; }
    // Find where line `startLine` begins within this chunk.
    let i = 0;
    for (; i < value.byteLength; i++) {
      if (value[i] === 0x0a) {
        line++;
        if (line === startLine) { i++; break; }
      }
    }
    if (line === startLine) {
      emitting = true;
      if (i < value.byteLength) await writeBytes(out, value.subarray(i));
    }
  }
}

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
      if (src === '-') {
        if (wantHeaders) {
          await writeString(out, `${printed > 0 ? '\n' : ''}==> standard input <==\n`);
        }
        printed++;
        // Stream stdin through a bounded ring so an infinite producer uses O(N)
        // memory and never OOMs the host (it correctly never emits at EOF that
        // never comes — but it sits bounded, not unbounded).
        await tailStdin(io.stdin, spec, byteMode, out);
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = await readFile(io, src); }
      catch (e) {
        const msg = (e as { message?: string }).message ?? 'No such file or directory';
        await writeString(err, `${name}: cannot open '${src}' for reading: ${msg}\n`);
        exitCode = 1;
        continue;
      }
      if (wantHeaders) {
        await writeString(out, `${printed > 0 ? '\n' : ''}==> ${src} <==\n`);
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
