/**
 * Minimal guest-entry harness for `@mithic/jq`, mirroring `@mithic/coreutils`'s
 * `defineCommand` shape but local to this package (jq is its own package and
 * only needs this one wrapper). {@link defineCommand} turns a {@link CommandFn}
 * — pure logic over a {@link CommandIO} (argv + env + stdio) returning an exit
 * code — into the `export default async (boot) => {…}` guest module the kernel
 * launches via `createGuest`.
 */
import { createGuest } from '@mithic/guest-runtime';

/** The I/O surface the jq command operates over (argv, env, cwd, stdio). */
export interface CommandIO {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  syscall: (call: string, args: Record<string, unknown>) => Promise<unknown>;
}

/** The command's core logic: operate on {@link CommandIO}, return an exit code. */
export type CommandFn = (io: CommandIO) => Promise<number>;

const ENCODER = new TextEncoder();

/** Read a ReadableStream fully and decode it as UTF-8 text. */
export async function readAllText(stream: ReadableStream<Uint8Array>): Promise<string> {
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
  return new TextDecoder().decode(out);
}

/** Write a string (UTF-8) to a stream writer, with no added newline. */
export function writeString(writer: WritableStreamDefaultWriter<Uint8Array>, text: string): Promise<void> {
  return writer.write(ENCODER.encode(text));
}

/** Write a string followed by a single `\n`. */
export function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, text: string): Promise<void> {
  return writer.write(ENCODER.encode(text + '\n'));
}

/** Turn a {@link CommandFn} into the kernel-launched guest default export. */
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
      try {
        const w = io.stderr.getWriter();
        await writeLine(w, `jq: ${(err as Error).message}`);
        await w.close().catch(() => { /* already closed */ });
      } catch { /* stderr unusable */ }
      code = 1;
    }

    await closeStream(io.stdout);
    await closeStream(io.stderr);
    guest.exit(code);
  };
}

async function closeStream(stream: WritableStream<Uint8Array>): Promise<void> {
  if (stream.locked) return;
  try { await stream.close(); } catch { /* already closed */ }
}
