/**
 * Shell process entry — the guest module that runs inside an Mithic sandbox.
 *
 * The kernel launches this with the script to execute passed as a guest
 * argument (argv[1]) or, failing that, read from stdin. It builds an
 * {@link Executor} whose stdout sink writes to the guest's `mithic.stdout`
 * stream, runs the parsed program, and exits with the program's status.
 *
 * External commands: the shell forks CHILD processes via the kernel's
 * `process/spawn` / `process/pipeline` syscalls (see {@link makeKernelClient}).
 * Builtins still run in-process (builtin-first dispatch); only non-builtins
 * spawn. The kernel OWNS what commands exist — the shell spawns by NAME and the
 * kernel's command resolver maps it to guest code (or returns ENOENT).
 */
import { createGuest } from '@mithic/guest-runtime';
import type { Guest } from '@mithic/guest-runtime';
import { Executor } from './executor.ts';
import type {
  KernelClient,
  PipelineRunResult,
  PipelineStageParams,
  SpawnHandle,
  SpawnParams,
} from './kernel-client.ts';
import { parse } from './parser.ts';

/**
 * Build a real {@link KernelClient} backed by the guest's `process/*` syscalls.
 *
 * - `spawn` runs a single external command as a one-stage `process/pipeline`,
 *   capturing its stdout (the kernel returns the bytes), so the executor can
 *   write the child's output to the shell's own stdout.
 * - `runPipeline` issues a single `process/pipeline` syscall; the kernel wires
 *   the stages with zero-hop pipes, narrows each child's caps from the shell,
 *   resolves command names, and captures the final stage's stdout.
 * - `wait` returns the exit code recorded by the preceding spawn (the pipeline
 *   syscall already awaited the child's exit).
 *
 * Command NAME resolution is delegated to the kernel: the shell passes the bare
 * name as `path` and the kernel's resolver maps it (the shell does NOT itself
 * know what external commands exist).
 */
function makeKernelClient(guest: Guest): KernelClient {
  // pid -> exit code, recorded as each spawn/pipeline completes so a following
  // wait(pid) can report it without a second syscall.
  const exitCodes = new Map<number, number>();
  let synthPid = -1; // synthetic pids for spawns (the syscall returns bytes, not a live pid).

  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      const [name, ...rest] = params.args ?? [];
      const r = (await guest.syscall('process/pipeline', {
        stages: [{ path: params.code instanceof URL ? params.code.href : String(params.code), argv: [name, ...rest], env: params.env, cwd: params.cwd }],
      })) as { exitCodes: number[]; stdout: Uint8Array };
      const pid = synthPid--;
      exitCodes.set(pid, r.exitCodes[r.exitCodes.length - 1] ?? 0);
      return { pid, stdout: Promise.resolve(r.stdout) };
    },
    async wait(pid: number) {
      return { pid, code: exitCodes.get(pid) ?? 0 };
    },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const r = (await guest.syscall('process/pipeline', {
        stages: stages.map((s) => ({
          path: s.code instanceof URL ? s.code.href : String(s.code),
          argv: s.args ?? [],
          env: s.env,
          cwd: s.cwd,
        })),
      })) as { exitCodes: number[]; stdout: Uint8Array };
      const pids = stages.map(() => synthPid--);
      return {
        pids,
        exitCodes: r.exitCodes,
        lastStdout: Promise.resolve(r.stdout),
        stderr: stages.map(() => undefined),
      };
    },
  };
}

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
      makeKernelClient(guest),
      { cwd: guest.cwd, env: { ...guest.env } },
      // The shell resolves bare command names by deferring to the KERNEL: it
      // passes the name straight through as spawnable "code" and the kernel's
      // command resolver maps it (or returns ENOENT). The shell does not itself
      // enumerate external commands.
      { onStdout, onStderr, resolve: (name) => name },
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
