/**
 * Command-authoring harness for `@mithic/coreutils`.
 *
 * A coreutils command is, at its core, a {@link CommandFn}: a function over a
 * {@link CommandIO} (parsed argv + env + cwd + stdio streams + a syscall hook)
 * that returns an exit code. {@link defineCommand} wraps a `CommandFn` into the
 * `export default async (boot) => {…}` guest module the kernel launches, so each
 * command file is just its own logic plus one `export default defineCommand(fn)`.
 *
 * This module also provides the small reusable helpers every command needs:
 * a POSIX-style getopt parser ({@link parseArgs}), stdin readers
 * ({@link readAll} / {@link readAllText} / {@link readLines}), stdout/stderr
 * writers ({@link writeBytes} / {@link writeString} / {@link writeLine}), and
 * {@link exitWith} for the error-and-exit-code idiom.
 */
import { createGuest } from '@mithic/guest-runtime';

/**
 * The I/O surface a command operates over. `args[0]` is the command name
 * (argv[0]); positional operands and flags follow in `args[1..]`. Streams are
 * the guest's wired stdio; `syscall` reaches kernel services (notably `fs/*`).
 */
export interface CommandIO {
  /** Full argv: `args[0]` is the command name, `args[1..]` are operands/flags. */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  /** Kernel syscall hook — e.g. `syscall('fs/open', { path, oflags })`. */
  syscall: (call: string, args: Record<string, unknown>) => Promise<unknown>;
  /**
   * POSIX `isatty(fd)`: true when fd 0/1/2 is an interactive terminal rather than a
   * pipe/redirect. Lets a command switch output format by destination the way GNU
   * does — notably `ls`, which is multi-column to a TTY but one-per-line to a pipe.
   * False for any non-tty fd (the common batch/pipeline case). Optional so existing
   * test helpers that build a partial `CommandIO` still typecheck; a command reads it
   * as `io.isatty?.(1) ?? false` (defaulting to the pipe/batch behavior).
   */
  isatty?: (fd: number) => boolean;
}

/** A command's core logic: operate on {@link CommandIO}, return an exit code. */
export type CommandFn = (io: CommandIO) => Promise<number>;

// ── argument parsing ─────────────────────────────────────────────────────────

/** Options controlling {@link parseArgs}. */
export interface ParseOptions {
  /** Flag names that are booleans (no value): e.g. `n` for `-n`, `number` for `--number`. */
  boolean?: string[];
  /** Flag names that take a string value: e.g. `o` for `-o val` / `-oval` / `--out=val`. */
  string?: string[];
  /** Boolean flags whose repeats accumulate as a count (e.g. `-vvv` → 3). */
  count?: string[];
  /** Map of alias name → canonical name (e.g. `{ number: 'n' }` so `--number` sets `n`). */
  alias?: Record<string, string>;
  /**
   * How to treat a flag not present in `boolean`/`string`/`count`/`alias`:
   *   - `'ignore'` (default) — record it as `true` (legacy permissive behavior);
   *   - `'error'` — collect it in {@link ParsedArgs.unknown} so the command can
   *     emit GNU's `invalid option` diagnostic + exit non-zero (bash/coreutils
   *     reject unknown flags, exit 1/2). Recommended for GNU parity.
   */
  unknown?: 'ignore' | 'error';
}

/** The result of {@link parseArgs}: positional operands and a flag bag. */
export interface ParsedArgs {
  /** Non-flag operands, in order. A lone `-` is a positional (stdin convention). */
  positionals: string[];
  /** Flag values: boolean flags → `true`, counted flags → number, string flags → string. */
  flags: Record<string, string | number | boolean>;
  /**
   * Undeclared flags seen when `unknown: 'error'` — as they appeared on the command
   * line (`-Z`, `--bad`), in order. Empty otherwise. A command checks this and emits
   * `<name>: invalid option -- 'Z'` / `unrecognized option '--bad'` + exit 1/2.
   */
  unknown: string[];
}

/**
 * A small POSIX/getopt-style argument parser. Supports:
 *   - short boolean flags and clustering: `-a`, `-abc` (= `-a -b -c`)
 *   - short value flags: `-o val` or `-oval` (value = rest of the cluster)
 *   - long flags: `--flag`, `--flag=val`, `--flag val`
 *   - `--` terminator: every following arg is a positional
 *   - a lone `-` is a positional (the stdin convention), never a flag
 *   - counted flags: repeats of a `count` flag accumulate (`-vvv` → 3)
 *   - aliases: a long/alias name resolves to its canonical flag name
 *
 * `args` is the operand list — pass `io.args.slice(1)` (argv without the name).
 * Unknown flags are recorded as `true` (boolean) rather than throwing, so a
 * command can decide how strict to be.
 */
export function parseArgs(args: string[], options: ParseOptions = {}): ParsedArgs {
  // `options.boolean` is documentational: any short/long flag not declared as a
  // `string` (value-taking) flag is treated as boolean, so we only need the
  // string set to decide whether a flag consumes a value.
  const strings = new Set(options.string ?? []);
  const counts = new Set(options.count ?? []);
  const alias = options.alias ?? {};
  const canonical = (name: string): string => alias[name] ?? name;
  // When `unknown: 'error'`, a flag is "known" iff it is declared (or an alias). The
  // allowlist is the union of the declared boolean/string/count names, their aliases,
  // and the aliases' canonical targets (so `--number`→`n` counts `n` as known too).
  const strict = options.unknown === 'error';
  const known = new Set<string>([
    ...(options.boolean ?? []), ...(options.string ?? []), ...(options.count ?? []),
    ...Object.keys(alias), ...Object.values(alias),
  ]);
  const unknown: string[] = [];
  const isKnown = (name: string): boolean => known.has(name) || known.has(canonical(name));

  const positionals: string[] = [];
  const flags: Record<string, string | number | boolean> = {};

  const setBool = (name: string): void => {
    const key = canonical(name);
    if (counts.has(key)) flags[key] = (typeof flags[key] === 'number' ? (flags[key] as number) : 0) + 1;
    else flags[key] = true;
  };
  const setValue = (name: string, value: string): void => { flags[canonical(name)] = value; };

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; } // terminator: rest are positionals
    if (arg === '-' || !arg.startsWith('-')) { positionals.push(arg); continue; }

    if (arg.startsWith('--')) {
      // Long flag: --flag, --flag=val
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (eq >= 0) {
        if (strict && !isKnown(name)) { unknown.push('--' + name); continue; }
        setValue(name, body.slice(eq + 1));
        continue;
      }
      if (strings.has(canonical(name)) || strings.has(name)) {
        // Value-taking long flag with separate value: --flag val
        const next = args[i + 1];
        if (next !== undefined) { setValue(name, next); i++; } else { setValue(name, ''); }
      } else if (strict && !isKnown(name)) {
        unknown.push('--' + name);
      } else {
        setBool(name);
      }
      continue;
    }

    // Short flag cluster: -abc, -ovalue, -o value
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      const key = canonical(ch);
      if (strings.has(key) || strings.has(ch)) {
        const rest = cluster.slice(j + 1);
        if (rest.length > 0) { setValue(ch, rest); }
        else { const next = args[i + 1]; if (next !== undefined) { setValue(ch, next); i++; } else { setValue(ch, ''); } }
        break; // value flag consumes the rest of the cluster
      }
      if (strict && !isKnown(ch)) { unknown.push('-' + ch); continue; }
      setBool(ch);
    }
  }
  // Anything after a `--` terminator.
  for (; i < args.length; i++) positionals.push(args[i]);

  return { positionals, flags, unknown };
}

const ENCODER = new TextEncoder();

/**
 * Canonical POSIX/GNU errno text for a caught filesystem error, mapped from the
 * VFS `FileSystemError.code` (the stable contract) rather than its human message
 * (which varies by provider — memory/opfs say "File not found: <path>", node-fs
 * leaks the raw node message). A command formats `<cmd>: <path>: <fsErrorText(e)>`
 * to match `cat: foo: No such file or directory`. Falls back to the error's own
 * message for an unrecognized/non-FS error.
 */
export function fsErrorText(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case 'no-entry': return 'No such file or directory';
    case 'access': return 'Permission denied';
    case 'exist': return 'File exists';
    case 'not-directory': return 'Not a directory';
    case 'is-directory': return 'Is a directory';
    case 'cross-device': return 'Invalid cross-device link';
    case 'not-empty': return 'Directory not empty';
    case 'invalid': return 'Invalid argument';
    case 'no-space': return 'No space left on device';
    case 'io': return 'Input/output error';
    default: {
      const msg = (err as { message?: string })?.message;
      return msg && msg.trim() !== '' ? msg : 'No such file or directory';
    }
  }
}

// ── stdin readers ─────────────────────────────────────────────────────────────

/**
 * Default byte cap for the buffering stdin readers ({@link readAll} /
 * {@link readAllText}): 256 MiB. This is the Tier-3 OOM backstop.
 *
 * Real Unix coreutils stream with bounded memory and terminate on an infinite
 * producer via SIGPIPE/EPIPE. Most filters here are converted to stream
 * (constant memory), but a few genuinely whole-input commands (`sort`, `tac`)
 * and a couple of entangled ones (`sed`, `awk`) still buffer their input. In
 * real Unix those rely on the OS OOM-killer/ulimit; our sandbox equivalent is
 * this hard cap, so they error cleanly instead of growing the HOST heap until
 * the process is OOM-killed (the bug: `cat /dev/urandom | base64 | head -c 10`
 * grew to 60 GB). 256 MiB matches the kernel's output-cap order of magnitude:
 * large enough for any legitimate one-shot input, small enough that a runaway
 * producer is stopped long before the host is endangered.
 */
export const READALL_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Thrown by {@link readAll} / {@link readAllText} when the input exceeds the
 * byte cap. {@link defineCommand}'s wrapper turns an uncaught throw into a
 * stderr diagnostic + non-zero exit, so a buffering command on an unbounded
 * producer reports `<cmd>: input too large` rather than OOM-killing the host.
 */
export class InputTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super('input too large');
    this.name = 'InputTooLargeError';
    this.limit = limit;
  }
}

/**
 * Read a ReadableStream fully into a single Uint8Array, with a hard byte cap
 * (default {@link READALL_MAX_BYTES}). If the accumulated input would exceed
 * `maxBytes`, the source is cancelled (stopping the upstream producer via
 * EPIPE) and an {@link InputTooLargeError} is thrown. Inputs at/under the cap
 * are returned unchanged.
 */
export async function readAll(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = READALL_MAX_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Stop the upstream producer (EPIPE) and refuse to buffer more.
          reader.releaseLock();
          await stream.cancel().catch(() => { /* best effort */ });
          throw new InputTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released on the cap path */ }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Read a ReadableStream fully and decode it as UTF-8 text (capped — see {@link readAll}). */
export async function readAllText(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number = READALL_MAX_BYTES,
): Promise<string> {
  return new TextDecoder().decode(await readAll(stream, maxBytes));
}

/**
 * Read a ReadableStream fully and split it into lines on `\n`. A single
 * trailing newline is dropped (so `"a\nb\n"` → `["a", "b"]`); a final line
 * with no trailing newline is kept (so `"a\nb"` → `["a", "b"]`). An empty
 * stream yields `[]`.
 */
export async function readLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await readAllText(stream);
  if (text === '') return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n');
}

/**
 * Incrementally yield lines from a byte stream WITHOUT buffering the whole input
 * — the key to not hanging on an unbounded producer (parity finding H5). Each
 * yielded item is `{ line, eol }` where `eol` is true when the line was
 * terminated by a `\n` in the input (so the final unterminated line, if any, has
 * `eol === false`). An empty stream yields nothing.
 *
 * The caller drives the generator: it reads only as much of `stream` as it pulls.
 * If the caller stops early (e.g. its downstream broke), it should `return` from
 * the loop and then `cancel()` the source stream so the upstream producer gets
 * EPIPE.
 */
export async function* streamLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ line: string; eol: boolean }, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      carry += decoder.decode(value, { stream: true });
      let nl = carry.indexOf('\n');
      while (nl !== -1) {
        yield { line: carry.slice(0, nl), eol: true };
        carry = carry.slice(nl + 1);
        nl = carry.indexOf('\n');
      }
    }
    carry += decoder.decode(); // flush any pending multibyte tail
    if (carry !== '') yield { line: carry, eol: false };
  } finally {
    reader.releaseLock();
  }
}

/**
 * A thrown value is a broken-pipe (EPIPE) signal from a closed/errored
 * downstream. Recognizes the kernel pipe's `EPIPE` code, a WritableStream that
 * has been closed/aborted, and the conventional "broken pipe" message.
 */
export function isBrokenPipe(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const msg = (err as { message?: string })?.message ?? '';
  return code === 'EPIPE' || /EPIPE|broken pipe|closed|abort/i.test(msg);
}

/**
 * A small write coalescer for incremental (streaming) filters. `push()` appends
 * text to an internal buffer and only `await`s a real `write()` once the buffer
 * crosses {@link FLUSH_THRESHOLD} bytes; `flush()` drains the remainder.
 *
 * This avoids the trap where a per-line `await writer.write()` parks on the
 * pipe's flush timer (~one line per tick → seconds for large input). Coalescing
 * keeps per-line streaming semantics (output appears as input is consumed,
 * downstream EPIPE still surfaces on the next flush) while writing in efficient
 * blocks.
 *
 * CRITICAL: every individual `writer.write()` it emits is capped at
 * {@link FLUSH_THRESHOLD} bytes. The kernel pipe credit window is 64 KiB and a
 * writer parks for the WHOLE chunk size — a single `write()` larger than the
 * window can never be reserved and deadlocks against a normally-draining
 * consumer. A 32 KiB cap stays well under the window, so a filter that emits a
 * large block at once (e.g. `base64` producing ~87 KiB per 64 KiB input chunk)
 * still streams instead of hanging.
 */
export class CoalescingWriter {
  static readonly FLUSH_THRESHOLD = 32 * 1024;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #parts: string[] = [];
  #size = 0;

  constructor(writer: WritableStreamDefaultWriter<Uint8Array>) {
    this.#writer = writer;
  }

  /** Buffer `text`; flush (and await) only once the buffer crosses the threshold. */
  async push(text: string): Promise<void> {
    if (text === '') return;
    this.#parts.push(text);
    this.#size += text.length;
    if (this.#size >= CoalescingWriter.FLUSH_THRESHOLD) await this.flush();
  }

  /** Write any buffered text, in writes capped at {@link FLUSH_THRESHOLD} bytes. */
  async flush(): Promise<void> {
    if (this.#parts.length === 0) return;
    const bytes = ENCODER.encode(this.#parts.join(''));
    this.#parts = [];
    this.#size = 0;
    // Cap each physical write to the threshold so no single write exceeds the
    // kernel pipe credit window (see the class doc — a >window write deadlocks).
    const cap = CoalescingWriter.FLUSH_THRESHOLD;
    for (let off = 0; off < bytes.byteLength; off += cap) {
      await this.#writer.write(bytes.subarray(off, Math.min(off + cap, bytes.byteLength)));
    }
  }
}

// ── stdout/stderr writers ─────────────────────────────────────────────────────

/** Write raw bytes to a stream writer. */
export function writeBytes(writer: WritableStreamDefaultWriter<Uint8Array>, bytes: Uint8Array): Promise<void> {
  return writer.write(bytes);
}

/** Write a string (UTF-8) to a stream writer, with no added newline. */
export function writeString(writer: WritableStreamDefaultWriter<Uint8Array>, text: string): Promise<void> {
  return writer.write(ENCODER.encode(text));
}

/** Write a string followed by a single `\n`. */
export function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, text: string): Promise<void> {
  return writer.write(ENCODER.encode(text + '\n'));
}

/**
 * GNU-style "invalid option" diagnostic for the first undeclared flag from
 * {@link ParsedArgs.unknown} (populated when `parseArgs(..., { unknown: 'error' })`).
 * A short `-Z` → `<cmd>: invalid option -- 'Z'`; a long `--bad` → `<cmd>:
 * unrecognized option '--bad'`, each followed by GNU's `Try '<cmd> --help' for more
 * information.` line. Returns the two-line message (no trailing newline). Commands do:
 *   `if (parsed.unknown.length) return exitWith(err, 1, optionError(name, parsed.unknown[0]));`
 */
export function optionError(cmd: string, badFlag: string): string {
  const line1 = badFlag.startsWith('--')
    ? `${cmd}: unrecognized option '${badFlag}'`
    : `${cmd}: invalid option -- '${badFlag.replace(/^-/, '')}'`;
  return `${line1}\nTry '${cmd} --help' for more information.`;
}

/**
 * The error-and-exit-code idiom: optionally write `errMsg` (with a newline) to
 * the given stderr writer, then resolve to `code`. Commands typically
 * `return exitWith(errWriter, 1, 'cat: foo: No such file or directory')`.
 */
export async function exitWith(
  errWriter: WritableStreamDefaultWriter<Uint8Array>,
  code: number,
  errMsg?: string,
): Promise<number> {
  if (errMsg !== undefined) await writeLine(errWriter, errMsg);
  return code;
}

// ── guest entry wrapper ────────────────────────────────────────────────────────

/**
 * Turn a {@link CommandFn} into the guest module default export the kernel
 * launches. The returned function:
 *   1. builds a {@link import('@mithic/guest-runtime').Guest} from `boot`,
 *   2. invokes the command with a {@link CommandIO} bound to the guest's stdio,
 *   3. closes stdout/stderr and calls `guest.exit(code)` with the returned code
 *      (or `1` if the command throws — the error is reported on stderr).
 *
 * Each command file ends with `export default defineCommand(myCommandFn);` and
 * builds (via the repo's preserveModules vite config) to its own dist module,
 * which the {@link import('./resolver.ts').createCoreutilsResolver} hands to the
 * kernel by URL.
 */
export function defineCommand(fn: CommandFn): (boot: unknown) => Promise<void> {
  return async function guestDefault(boot: unknown): Promise<void> {
    const guest = createGuest(boot as Parameters<typeof createGuest>[0]);
    const io: CommandIO = {
      args: guest.args,
      env: guest.env,
      cwd: guest.cwd,
      stdin: guest.stdin,
      stdout: guest.stdout,
      stderr: guest.stderr,
      syscall: (call, args) => guest.syscall(call, args),
      isatty: (fd) => guest.isatty(fd),
    };

    let code = 0;
    try {
      code = await fn(io);
    } catch (err) {
      // Surface an unexpected error on stderr and exit non-zero, mirroring a
      // crashing coreutil. Best-effort: stderr may already be closed.
      const name = io.args[0] ?? 'coreutils';
      try {
        const w = io.stderr.getWriter();
        await writeLine(w, `${name}: ${(err as Error).message}`);
        await w.close().catch(() => { /* already closed */ });
      } catch { /* stderr unusable */ }
      code = 1;
    }

    // Close the guest's stdio so downstream readers see EOF and the kernel can
    // collect captured output. A command that already closed its own writers
    // makes these no-ops (close on an already-closed stream rejects → ignored).
    await closeStream(io.stdout);
    await closeStream(io.stderr);
    guest.exit(code);
  };
}

/** Close a WritableStream if still open; ignore "already closed/locked" errors. */
async function closeStream(stream: WritableStream<Uint8Array>): Promise<void> {
  if (stream.locked) return; // a writer is still held by the command; it owns close
  try { await stream.close(); } catch { /* already closed */ }
}
