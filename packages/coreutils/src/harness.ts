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
}

/** The result of {@link parseArgs}: positional operands and a flag bag. */
export interface ParsedArgs {
  /** Non-flag operands, in order. A lone `-` is a positional (stdin convention). */
  positionals: string[];
  /** Flag values: boolean flags → `true`, counted flags → number, string flags → string. */
  flags: Record<string, string | number | boolean>;
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
      if (eq >= 0) { setValue(name, body.slice(eq + 1)); continue; }
      if (strings.has(canonical(name)) || strings.has(name)) {
        // Value-taking long flag with separate value: --flag val
        const next = args[i + 1];
        if (next !== undefined) { setValue(name, next); i++; } else { setValue(name, ''); }
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
      setBool(ch);
    }
  }
  // Anything after a `--` terminator.
  for (; i < args.length; i++) positionals.push(args[i]);

  return { positionals, flags };
}

// ── stdin readers ─────────────────────────────────────────────────────────────

/** Read a ReadableStream fully into a single Uint8Array. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); total += value.byteLength; }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/** Read a ReadableStream fully and decode it as UTF-8 text. */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await readAll(stream));
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

// ── stdout/stderr writers ─────────────────────────────────────────────────────

const ENCODER = new TextEncoder();

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
