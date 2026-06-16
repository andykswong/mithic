/**
 * Command-authoring harness for `@mithic/curl`.
 *
 * Mirrors the `@mithic/coreutils` harness (intentionally — curl is a command of
 * the same shape) but is kept LOCAL so `@mithic/curl` depends only on
 * `@mithic/guest-runtime` at runtime, not on coreutils. A curl command is a
 * {@link CommandFn} over a {@link CommandIO} (parsed argv + env + cwd + stdio +
 * a syscall hook) returning an exit code; {@link defineCommand} wraps it into
 * the `export default async (boot) => {…}` guest module the kernel launches.
 *
 * curl reaches the network through ONE syscall — `net/fetch` — which the kernel
 * capability-gates by origin. The guest never holds a socket or `fetch`.
 */
import { createGuest } from '@mithic/guest-runtime';

/**
 * The I/O surface a command operates over. `args[0]` is the command name
 * (argv[0]); operands and flags follow. Streams are the guest's wired stdio;
 * `syscall` reaches kernel services (`net/fetch`, `fs/*`).
 */
export interface CommandIO {
  /** Full argv: `args[0]` is the command name, `args[1..]` are operands/flags. */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  /** Kernel syscall hook — e.g. `syscall('net/fetch', { method, url, headers })`. */
  syscall: (call: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** A command's core logic: operate on {@link CommandIO}, return an exit code. */
export type CommandFn = (io: CommandIO) => Promise<number>;

// ── argument parsing ─────────────────────────────────────────────────────────

/** Options controlling {@link parseArgs}. */
export interface ParseOptions {
  /** Flag names that are booleans (no value). */
  boolean?: string[];
  /** Flag names that take a string value (repeatable values accumulate as an array). */
  string?: string[];
  /** String flags whose repeats accumulate into an array (e.g. `-H` headers). */
  collect?: string[];
  /** Map of alias name → canonical name (e.g. `{ head: 'I' }`). */
  alias?: Record<string, string>;
}

/** The result of {@link parseArgs}: positional operands and a flag bag. */
export interface ParsedArgs {
  positionals: string[];
  /** Flag values: boolean → `true`; string → string; collected → string[]. */
  flags: Record<string, string | boolean | string[]>;
}

/**
 * A small getopt-style parser supporting short/long flags, clustering,
 * `-o val` / `-oval` / `--out=val` / `--out val`, the `--` terminator, a lone
 * `-` positional, aliases, and repeatable "collect" flags (e.g. `-H`).
 * `args` is the operand list — pass `io.args.slice(1)`.
 */
export function parseArgs(args: string[], options: ParseOptions = {}): ParsedArgs {
  const strings = new Set(options.string ?? []);
  const collect = new Set(options.collect ?? []);
  const alias = options.alias ?? {};
  const canonical = (name: string): string => alias[name] ?? name;
  for (const c of collect) strings.add(c);

  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  const setBool = (name: string): void => { flags[canonical(name)] = true; };
  const setValue = (name: string, value: string): void => {
    const key = canonical(name);
    if (collect.has(key)) {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      flags[key] = value;
    }
  };

  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { i++; break; }
    if (arg === '-' || !arg.startsWith('-')) { positionals.push(arg); continue; }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (eq >= 0) { setValue(name, body.slice(eq + 1)); continue; }
      if (strings.has(canonical(name)) || strings.has(name)) {
        const next = args[i + 1];
        if (next !== undefined) { setValue(name, next); i++; } else { setValue(name, ''); }
      } else {
        setBool(name);
      }
      continue;
    }

    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j++) {
      const ch = cluster[j];
      const key = canonical(ch);
      if (strings.has(key) || strings.has(ch)) {
        const rest = cluster.slice(j + 1);
        if (rest.length > 0) { setValue(ch, rest); }
        else { const next = args[i + 1]; if (next !== undefined) { setValue(ch, next); i++; } else { setValue(ch, ''); } }
        break;
      }
      setBool(ch);
    }
  }
  for (; i < args.length; i++) positionals.push(args[i]);

  return { positionals, flags };
}

// ── stdin/stdout helpers ───────────────────────────────────────────────────────

const ENCODER = new TextEncoder();

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

// ── guest entry wrapper ────────────────────────────────────────────────────────

/**
 * Turn a {@link CommandFn} into the guest module default export the kernel
 * launches: builds a {@link import('@mithic/guest-runtime').Guest} from `boot`,
 * runs the command with a {@link CommandIO} bound to the guest's stdio, closes
 * stdout/stderr, and calls `guest.exit(code)` (or `1` on a thrown error, which
 * is reported on stderr). Each command file ends with
 * `export default defineCommand(fn);` and builds to its own dist module.
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
      const name = io.args[0] ?? 'curl';
      try {
        const w = io.stderr.getWriter();
        await writeLine(w, `${name}: ${(err as Error).message}`);
        await w.close().catch(() => { /* already closed */ });
      } catch { /* stderr unusable */ }
      code = 1;
    }

    await closeStream(io.stdout);
    await closeStream(io.stderr);
    guest.exit(code);
  };
}

/** Close a WritableStream if still open; ignore "already closed/locked" errors. */
async function closeStream(stream: WritableStream<Uint8Array>): Promise<void> {
  if (stream.locked) return;
  try { await stream.close(); } catch { /* already closed */ }
}
