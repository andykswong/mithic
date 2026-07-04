/**
 * `head` — output the first part of files.
 *
 * Supported:
 *   - `-n N` / `--lines=N`: first N lines (default 10). Legacy `-N` (e.g. `-5`).
 *   - `-c N` / `--bytes=N`: first N bytes.
 *   - `-n -N` / `-c -N`: all but the LAST N lines/bytes (GNU negative form).
 *   - size suffixes on `-c`/`-n`: `b`=512, `k`/`K`=1024, `KB`=1000, `m`/`M`=1048576,
 *     `MB`=10^6, and `G/GB/T/TB/P/PB/E/EB/Z/ZB/Y/YB`.
 *   - operands: file paths; `-` (or none) reads stdin.
 *   - multiple files: print `==> NAME <==` headers (unless `-q`); `-v` forces headers.
 *   - `-q` / `--quiet` / `--silent`: never print headers.
 *
 * Early termination (parity finding H5): for the ordinary (positive, from-start)
 * limits `head` reads INCREMENTALLY and stops the instant its `-c`/`-n` limit is
 * reached — it never buffers the whole input. When it stops early on stdin it
 * CANCELS the stream so the upstream producer sees a broken pipe (EPIPE); this
 * lets `yes | head -n3` and `head -c4 /dev/zero` terminate instead of spinning.
 * The negative forms (`-c -N` / `-n -N`) are inherently whole-input (you cannot
 * know the last N until EOF), so they buffer with the shared byte cap.
 */
import { defineCommand, parseArgs, readAll, writeBytes, writeString, exitWith, optionError, fsErrorText } from '../harness.ts';
import type { CommandFn, CommandIO } from '../harness.ts';

const LIMIT = -1; // sentinel: a limit was reached, stop reading

/**
 * Canonical POSIX errno text for an `fs/*` failure. Over the real kernel the
 * error carries a POSIX errno `code` (e.g. `ENOENT`) with a provider-specific
 * message; {@link fsErrorText} only maps the lowercase VFS codes, so translate
 * the errno first and fall back to it for the in-memory unit-test path.
 */
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

/** A parsed `-c`/`-n` count: magnitude plus whether it was a `-N` (from-end) value. */
interface Count { n: number; fromEnd: boolean; }

/**
 * Parse a head count operand: an optional leading `-` (from-end), a decimal
 * magnitude, and an optional GNU size suffix. Returns undefined if malformed.
 */
function parseCount(raw: string): Count | undefined {
  let s = raw;
  let fromEnd = false;
  if (s.startsWith('-')) { fromEnd = true; s = s.slice(1); }
  const m = /^([0-9]+)([a-zA-Z]*)$/.exec(s);
  if (!m) return undefined;
  const mult = suffixMultiplier(m[2]);
  if (mult === undefined) return undefined;
  return { n: Number(m[1]) * mult, fromEnd };
}

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

async function headFileLines(io: CommandIO, fd: number, n: number, out: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  if (n <= 0) return;
  let seen = 0;
  for (;;) {
    const chunk = (await io.syscall('fs/read', { fd, len: 65536 })) as Uint8Array;
    if (!chunk || chunk.byteLength === 0) break; // EOF
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

/** All-but-last-N bytes of a whole buffer. */
function headBytesFromEnd(bytes: Uint8Array, n: number): Uint8Array {
  if (n <= 0) return bytes;
  const end = Math.max(0, bytes.byteLength - n);
  return bytes.subarray(0, end);
}

/** All-but-last-N lines of a whole buffer (a trailing `\n` does not add a line). */
function headLinesFromEnd(bytes: Uint8Array, n: number): Uint8Array {
  if (n <= 0) return bytes;
  // Line-start offsets: byte after each newline that is itself followed by data.
  const starts: number[] = [0];
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x0a && i + 1 < bytes.byteLength) starts.push(i + 1);
  }
  const keep = starts.length - n; // number of leading lines to keep
  if (keep <= 0) return new Uint8Array();
  return bytes.subarray(0, starts[keep]);
}

/**
 * Legacy `-N` prefilter that is OPERAND-AWARE: a bare `-<digits>` token is the
 * classic `head -5` line count ONLY when it is not the value of a preceding
 * `-n`/`-c` option (which may legitimately be negative, e.g. `head -n -3`).
 * Returns the surviving args (with the legacy token removed) and the count.
 */
function extractLegacy(args: string[]): { filtered: string[]; legacyN?: number } {
  let legacyN: number | undefined;
  const filtered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { filtered.push(...args.slice(i)); break; }
    // A separated value flag consumes the next token verbatim (never legacy).
    if (a === '-n' || a === '-c' || a === '--lines' || a === '--bytes') {
      filtered.push(a);
      if (args[i + 1] !== undefined) { filtered.push(args[++i]); }
      continue;
    }
    const m = /^-([0-9]+)$/.exec(a);
    if (m) { legacyN = Number(m[1]); continue; }
    filtered.push(a);
  }
  return { filtered, legacyN };
}

/**
 * Which of `-c`/`-n` appeared LAST on the command line — GNU is last-wins when
 * both are given (`head -c5 -n2` → line mode, `head -n2 -c5` → byte mode).
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

const headCommand: CommandFn = async (io: CommandIO): Promise<number> => {
  const rawArgs = io.args.slice(1);
  const name = io.args[0] ?? 'head';
  const { filtered, legacyN } = extractLegacy(rawArgs);

  const parsed = parseArgs(filtered, {
    string: ['n', 'c', 'lines', 'bytes'],
    boolean: ['q', 'v', 'z', 'quiet', 'silent', 'verbose', 'zero-terminated'],
    alias: { lines: 'n', bytes: 'c', quiet: 'q', silent: 'q', verbose: 'v', 'zero-terminated': 'z' },
    unknown: 'error',
  });
  const { positionals, flags } = parsed;

  const out = io.stdout.getWriter();
  const err = io.stderr.getWriter();
  let exitCode = 0;
  let printed = 0;
  let stdinHitLimit = false;

  try {
    if (parsed.unknown.length) return await exitWith(err, 1, optionError(name, parsed.unknown[0]));
    // GNU is last-wins when both `-c` and `-n` are supplied; otherwise byte mode
    // iff `-c` is present at all.
    const last = lastCountFlag(filtered);
    const byteMode = flags.c !== undefined && (flags.n === undefined || last === 'c');
    let count: Count;
    if (byteMode) {
      const parsed = parseCount(String(flags.c));
      if (parsed === undefined) return await exitWith(err, 1, `${name}: invalid number of bytes: ‘${flags.c}’`);
      count = parsed;
    } else if (flags.n !== undefined) {
      const parsed = parseCount(String(flags.n));
      if (parsed === undefined) return await exitWith(err, 1, `${name}: invalid number of lines: ‘${flags.n}’`);
      count = parsed;
    } else {
      count = { n: legacyN !== undefined ? legacyN : 10, fromEnd: false };
    }

    const sources = positionals.length > 0 ? positionals : ['-'];
    const wantHeaders = Boolean(flags.v) || (sources.length > 1 && !flags.q);

    for (const src of sources) {
      if (src === '-') {
        // stdin never fails to "open" — emit its header first.
        if (wantHeaders) {
          await writeString(out, `${printed > 0 ? '\n' : ''}==> standard input <==\n`);
        }
        printed++;
        if (count.fromEnd) {
          const bytes = await readAll(io.stdin);
          const piece = byteMode ? headBytesFromEnd(bytes, count.n) : headLinesFromEnd(bytes, count.n);
          await writeBytes(out, piece);
        } else {
          const r = byteMode
            ? await headStdinBytes(io.stdin, Math.max(0, count.n), out)
            : await headStdinLines(io.stdin, count.n, out);
          if (r === LIMIT) stdinHitLimit = true;
        }
      } else {
        // GNU opens the file FIRST and only prints the `==> NAME <==` header on
        // success — a file it cannot open produces no header (and no `printed`
        // bump), so the byte stream and later files' headers stay correct.
        let fd: number;
        try {
          ({ fd } = (await io.syscall('fs/open', { path: src, oflags: {} })) as { fd: number });
        } catch (e) {
          await writeString(err, `${name}: cannot open '${src}' for reading: ${errnoText(e)}\n`);
          exitCode = 1;
          continue;
        }
        if (wantHeaders) {
          await writeString(out, `${printed > 0 ? '\n' : ''}==> ${src} <==\n`);
        }
        printed++;
        try {
          if (count.fromEnd) {
            const bytes = await readFileFully(io, fd);
            const piece = byteMode ? headBytesFromEnd(bytes, count.n) : headLinesFromEnd(bytes, count.n);
            await writeBytes(out, piece);
          } else if (byteMode) {
            await headFileBytes(io, fd, Math.max(0, count.n), out);
          } else {
            await headFileLines(io, fd, count.n, out);
          }
        } finally {
          await io.syscall('fs/close', { fd }).catch(() => { /* best effort */ });
        }
      }
    }
  } finally {
    await out.close().catch(() => {});
    await err.close().catch(() => {});
    if (stdinHitLimit) await io.stdin.cancel().catch(() => {});
  }
  return exitCode;
};

/** Read an already-opened fd fully into one buffer (for the from-end forms). */
async function readFileFully(io: CommandIO, fd: number): Promise<Uint8Array> {
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
}

export default defineCommand(headCommand);
export { headCommand };
