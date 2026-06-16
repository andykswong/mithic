/**
 * Shell process entry — the guest module that runs inside an Isola sandbox.
 *
 * The kernel launches this with the script to execute passed as a guest
 * argument (argv[1]) or, failing that, read from stdin. It builds an
 * {@link Executor} whose stdout sink writes to the guest's `isola.stdout`
 * stream, runs the parsed program, and exits with the program's status.
 *
 * KernelClient note: the current kernel exposes no process-spawn syscall, so a
 * shell guest cannot fork children. The executor therefore runs builtins (incl.
 * `echo`/`cat`) in-process and wires pipelines internally. The KernelClient here
 * is a stub whose `spawn` rejects — external-command pipelines aren't reachable
 * yet (they will be once a `process/spawn` syscall lands).
 */
import { createGuest } from '@mithic/guest-runtime';
import type { Guest } from '@mithic/guest-runtime';
import { Executor } from './executor.ts';
import type { KernelClient } from './kernel-client.ts';
import { parse } from './parser.ts';

/** A KernelClient stub for guests that cannot spawn (no process syscall yet). */
const NO_SPAWN_CLIENT: KernelClient = {
  async spawn() {
    throw Object.assign(new Error('process/spawn unsupported in this sandbox'), { code: 'ENOSYS' });
  },
  async wait(pid: number) {
    return { pid, code: 0 };
  },
};

/** Read the guest's stdin stream fully into a string. */
async function readAll(guest: Guest): Promise<string> {
  const reader = guest.stdin.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

export default async function main(boot: unknown): Promise<void> {
  const guest = createGuest(boot as Parameters<typeof createGuest>[0]);
  const writer = guest.stdout.getWriter();
  const errWriter = guest.stderr.getWriter();
  const encoder = new TextEncoder();

  // Buffer output and flush in order (writers are async); collect into queues.
  const writes: Promise<void>[] = [];
  const onStdout = (s: string): void => { writes.push(writer.write(encoder.encode(s))); };
  const onStderr = (s: string): void => { writes.push(errWriter.write(encoder.encode(s))); };

  let code = 0;
  try {
    // Script source: argv[1] (argv[0] is the program name), else read stdin.
    const script = guest.args.length > 1 ? guest.args.slice(1).join(' ') : await readAll(guest);

    const executor = new Executor(
      NO_SPAWN_CLIENT,
      { cwd: guest.cwd, env: { ...guest.env } },
      { onStdout, onStderr },
    );
    code = await executor.run(parse(script));
  } catch (err) {
    onStderr(`shell: ${(err as Error).message}\n`);
    code = 1;
  }

  await Promise.all(writes);
  await writer.close().catch(() => { /* already closed */ });
  await errWriter.close().catch(() => { /* already closed */ });
  guest.exit(code);
}
