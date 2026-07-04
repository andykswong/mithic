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
import { defineCommand, parseArgs, writeBytes, writeString, exitWith, fsErrorText } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

/** Canonical POSIX errno text for an `fs/*` failure (see head.ts for rationale). */
const ERRNO_TEXT: Record<string, string> = {
  ENOENT: 'No such file or directory', EACCES: 'Permission denied', EEXIST: 'File exists',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EXDEV: 'Invalid cross-device link',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ENOSPC: 'No space left on device',
  EIO: 'Input/output error',
};
function errnoText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  return (code && ERRNO_TEXT[code]) ?? fsErrorText(err);
}

/**
 * GNU size suffixes shared by `head`/`tail`. Lowercase `k`/`m` are accepted
 * (legacy) but lowercase `g`… are NOT — only the uppercase single letters and
 * the two-letter `xB` (base-1000) forms. Returns the multiplier or undefined.
 */
function suffixMultiplier(suf: string): number | undefined {
  const KB = 1000;
  const K = 1024;
  switch (suf) {
    case '': return 1;
    case 'b': return 512;
    case 'k': case 'K': return K;
    case 'KB': return KB;
    case 'm': case 'M': return K * K;
    case 'MB': return KB * KB;
    case 'G': return K ** 3;
    case 'GB': return KB ** 3;
    case 'T': return K ** 4;
    case 'TB': return KB ** 4;
    case 'P': return K ** 5;
    case 'PB': return KB ** 5;
    case 'E': return K ** 6;
    case 'EB': return KB ** 6;
    case 'Z': return K ** 7;
    case 'ZB': return KB ** 7;
    case 'Y': return K ** 8;
    case 'YB': return KB ** 8;
    default: return undefined;
  }
}

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

/**
 * Parse a tail count operand: an optional leading sign (`+N` = from the start,
 * `-N`/`N` = the last N), a decimal magnitude, and an optional GNU size suffix.
 * Returns undefined on a malformed value so the caller can emit GNU's diagnostic.
 */
function parseCount(raw: string): CountSpec | undefined {
  let s = raw;
  let fromStart = false;
  if (s.startsWith('+')) { fromStart = true; s = s.slice(1); }
  else if (s.startsWith('-')) { s = s.slice(1); }
  const m = /^([0-9]+)([a-zA-Z]*)$/.exec(s);
  if (!m) return undefined;
  const mult = suffixMultiplier(m[2]);
  if (mult === undefined) return undefined;
  return { n: Number(m[1]) * mult, fromStart };
}

/**
 * Legacy `-N` prefilter that is OPERAND-AWARE: a bare `-<digits>[suffix]` token
 * is the classic `tail -5` line count ONLY when it is not the value of a
 * preceding `-n`/`-c` option. Returns the surviving args (legacy token removed)
 * plus the raw legacy string (so the caller reuses parseCount for the suffix).
 */
function extractLegacy(args: string[]): { filtered: string[]; legacy?: string } {
  let legacy: string | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { filtered.push(...args.slice(i)); break; }
    if (a === '-n' || a === '-c' || a === '--lines' || a === '--bytes') {
      filtered.push(a);
      if (args[i + 1] !== undefined) filtered.push(args[++i]);
      continue;
    }
    const m = /^-([0-9]+[a-zA-Z]*)$/.exec(a);
    if (m) { legacy = m[1]; continue; }
    filtered.push(a);
  }
  return { filtered, legacy };
}

/**
 * Which of `-c`/`-n` appeared LAST on the command line — GNU is last-wins when
 * both are given (`tail -c5 -n2` → line mode, `tail -n2 -c5` → byte mode).
 * parseArgs collapses both into `flags.c`/`flags.n` and loses the order, so scan
 * the (legacy-filtered) argv directly. Returns 'c', 'n', or undefined (neither).
 */
function lastCountFlag(args: string[]): 'c' | 'n' | undefined {
  let last: 'c' | 'n' | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '-c' || a === '--bytes' || a.startsWith('--bytes=') || (a.startsWith('-c') && !a.startsWith('--'))) {
      last = 'c';
      if ((a === '-c' || a === '--bytes') && args[i + 1] !== undefined) i++;
      continue;
    }
    if (a === '-n' || a === '--lines' || a.startsWith('--lines=') || (a.startsWith('-n') && !a.startsWith('--'))) {
      last = 'n';
      if ((a === '-n' || a === '--lines') && args[i + 1] !== undefined) i++;
      continue;
    }
  }
  return last;
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
  const name = io.args[0] ?? 'tail';
  const { filtered, legacy } = extractLegacy(io.args.slice(1));
  const { positionals, flags } = parseArgs(filtered, {
    string: ['n', 'c', 'lines', 'bytes'],
    boolean: ['q', 'v', 'quiet', 'silent', 'verbose', 'f', 'follow'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', follow: 'f' },
  });

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let printed = 0;

  try {
    // GNU is last-wins when both `-c` and `-n` are supplied; otherwise byte mode
    // iff `-c` is present at all.
    const last = lastCountFlag(filtered);
    const byteMode = flags.c !== undefined && (flags.n === undefined || last === 'c');
    let spec: CountSpec;
    if (byteMode) {
      const parsed = parseCount(String(flags.c));
      if (parsed === undefined) return await exitWith(err, 1, `${name}: invalid number of bytes: ‘${flags.c}’`);
      spec = parsed;
    } else if (flags.n !== undefined) {
      const parsed = parseCount(String(flags.n));
      if (parsed === undefined) return await exitWith(err, 1, `${name}: invalid number of lines: ‘${flags.n}’`);
      spec = parsed;
    } else if (legacy !== undefined) {
      const parsed = parseCount('-' + legacy);
      if (parsed === undefined) return await exitWith(err, 1, `${name}: invalid number of lines: ‘${legacy}’`);
      spec = parsed;
    } else {
      spec = { n: 10, fromStart: false };
    }
    // GNU quirk: the `+` "from-start" mode is STICKY across mixed/repeated count
    // options — if ANY count flag used `+` (e.g. `-n +2 -c 3`), the winning count is
    // from-start too (`-c 3` behaves like `-c +3`). The last flag sets unit + number;
    // a `+` anywhere sets the mode.
    if (!spec.fromStart) {
      const cPlus = flags.c !== undefined && String(flags.c).trimStart().startsWith('+');
      const nPlus = flags.n !== undefined && String(flags.n).trimStart().startsWith('+');
      if (cPlus || nPlus) spec = { n: spec.n, fromStart: true };
    }

    const sources = positionals.length > 0 ? positionals : ['-'];
    const wantHeaders = Boolean(flags.v) || (sources.length > 1 && !flags.q);

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
        await writeString(err, `${name}: cannot open '${src}' for reading: ${errnoText(e)}\n`);
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
