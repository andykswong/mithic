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
  FsClient,
  KernelClient,
  PipelineRunResult,
  PipelineStageParams,
  SpawnHandle,
  SpawnParams,
} from './kernel-client.ts';
import { parse } from './parser.ts';

/**
 * Build an {@link FsClient} over the guest `fs/*` syscalls. Used for redirect
 * I/O and glob/pathname expansion. Best-effort: when the shell lacks a `vfs`
 * capability, the syscalls reject and the adapter surfaces the error to the
 * caller (redirects fail loudly; glob falls back to the literal pattern).
 *
 * The adapter is intentionally synchronous-looking for fsOpen/fsWrite/fsClose
 * (queuing async syscalls and tracking the pending chain) but exposes async
 * fsRead/fsReaddir/fsStat where the executor awaits results.
 */
function makeFsClient(guest: Guest): FsClient & { flush(): Promise<void> } {
  const buffers = new Map<number, string>();
  let synthFd = 1000;
  const pending: Array<Promise<unknown>> = [];

  const client: FsClient & { flush(): Promise<void> } = {
    flush: async () => { await Promise.all(pending); },
    fsOpen(path, flags): number {
      const fd = synthFd++;
      buffers.set(fd, '');
      // record open intent; actual write happens on close for write modes
      metaOf(buffers).set(fd, { path, flags });
      return fd;
    },
    fsWrite(fd, data): void {
      buffers.set(fd, (buffers.get(fd) ?? '') + data);
    },
    async fsRead(fd): Promise<string> {
      const meta = metaOf(buffers).get(fd);
      if (!meta) return '';
      const open = (await guest.syscall('fs/open', { path: meta.path, oflags: { read: true } })) as { fd: number };
      const chunks: Uint8Array[] = [];
      for (;;) {
        // `fs/read` resolves to a `Uint8Array` of bytes DIRECTLY (not a `{ data }`
        // wrapper). Tolerate both shapes so reading a `<` redirect source returns
        // the file contents instead of an empty string.
        const r = await guest.syscall('fs/read', { fd: open.fd, len: 65536 });
        const data = (r instanceof Uint8Array ? r : (r as { data?: Uint8Array } | undefined)?.data) ?? undefined;
        if (!data || data.byteLength === 0) break;
        chunks.push(data);
      }
      await guest.syscall('fs/close', { fd: open.fd });
      let total = 0; for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total); let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return new TextDecoder().decode(buf);
    },
    fsClose(fd): void {
      const meta = metaOf(buffers).get(fd);
      const data = buffers.get(fd) ?? '';
      buffers.delete(fd);
      if (meta && (meta.flags.write || meta.flags.append)) {
        const p = (async () => {
          const open = (await guest.syscall('fs/open', {
            path: meta.path,
            oflags: { write: !meta.flags.append, append: meta.flags.append, create: true, truncate: !meta.flags.append },
          })) as { fd: number };
          await guest.syscall('fs/write', { fd: open.fd, data: new TextEncoder().encode(data) });
          await guest.syscall('fs/close', { fd: open.fd });
        })();
        pending.push(p);
      }
    },
    async fsReaddir(path): Promise<string[]> {
      // `fs/readdir` resolves to a `DirEntry[]` (array of `{ name, type }`)
      // directly — NOT a `{ entries }` wrapper. Tolerate both shapes plus bare
      // string entries so glob/pathname expansion sees real directory contents.
      const r = await guest.syscall('fs/readdir', { path });
      const entries = (Array.isArray(r) ? r : (r as { entries?: unknown }).entries) as
        | Array<{ name: string } | string>
        | undefined;
      return (entries ?? []).map((e) => (typeof e === 'string' ? e : e.name));
    },
    async fsStat(path): Promise<{ dir: boolean } | undefined> {
      try {
        const r = (await guest.syscall('fs/stat', { path })) as { type?: string; isDir?: boolean };
        // `fs/stat` reports the VFS `DescriptorType` — a directory is `'directory'`
        // (not `'dir'`). Honor an explicit `isDir` if present, else match the type.
        return { dir: r.isDir ?? (r.type === 'directory' || r.type === 'dir') };
      } catch { return undefined; }
    },
  };
  return client;
}

function metaOf(buffers: Map<number, string>): Map<number, { path: string; flags: { read?: boolean; write?: boolean; append?: boolean; create?: boolean; truncate?: boolean } }> {
  const b = buffers as Map<number, string> & { _meta?: Map<number, { path: string; flags: { read?: boolean; write?: boolean; append?: boolean; create?: boolean; truncate?: boolean } }> };
  if (!b._meta) b._meta = new Map();
  return b._meta;
}

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
function makeKernelClient(guest: Guest, onStderr: (s: string) => void): KernelClient {
  // pid -> exit code, recorded as each spawn/pipeline completes so a following
  // wait(pid) can report it without a second syscall.
  const exitCodes = new Map<number, number>();
  let synthPid = -1; // synthetic pids for spawns (the syscall returns bytes, not a live pid).

  // A command NAME the kernel can't resolve rejects the `process/pipeline`
  // syscall with ENOENT. The shell delegates resolution to the kernel
  // (`resolve` always returns the bare name), so this rejection IS the
  // "command not found" signal. Map it to exit 127 and a stderr line instead of
  // letting it throw out of `executor.run()` — otherwise an unknown command
  // would abort the whole script rather than failing just that command.
  const isNotFound = (e: unknown): boolean => {
    const msg = (e as { message?: string })?.message ?? String(e);
    const code = (e as { code?: string; errno?: string }).code ?? (e as { errno?: string }).errno;
    return code === 'ENOENT' || /command not found|ENOENT|no such/i.test(msg);
  };

  return {
    async spawn(params: SpawnParams): Promise<SpawnHandle> {
      const [name, ...rest] = params.args ?? [];
      const pid = synthPid--;
      try {
        // Forward inline stdin (a `<` / `<<` / `<<<` redirect source) as the
        // first (only) stage's `stdinData` so the kernel feeds it to the child
        // and closes stdin (EOF). Without this a stdin-reading external (e.g.
        // `grep foo < file`) blocks forever waiting for an EOF that never comes.
        const stage: Record<string, unknown> = {
          path: params.code instanceof URL ? params.code.href : String(params.code),
          argv: [name, ...rest],
          env: params.env,
          cwd: params.cwd,
        };
        if (params.stdinData !== undefined) {
          stage.stdinData = new TextEncoder().encode(params.stdinData);
        }
        const r = (await guest.syscall('process/pipeline', {
          stages: [stage],
        })) as { exitCodes: number[]; stdout: Uint8Array };
        exitCodes.set(pid, r.exitCodes[r.exitCodes.length - 1] ?? 0);
        return { pid, stdout: Promise.resolve(r.stdout) };
      } catch (e) {
        if (!isNotFound(e)) throw e;
        onStderr(`shell: ${name}: command not found\n`);
        exitCodes.set(pid, 127);
        return { pid, stdout: Promise.resolve(new Uint8Array()) };
      }
    },
    async wait(pid: number) {
      return { pid, code: exitCodes.get(pid) ?? 0 };
    },
    async runPipeline(stages: PipelineStageParams[]): Promise<PipelineRunResult> {
      const pids = stages.map(() => synthPid--);
      try {
        const r = (await guest.syscall('process/pipeline', {
          stages: stages.map((s) => {
            const stage: Record<string, unknown> = {
              path: s.code instanceof URL ? s.code.href : String(s.code),
              argv: s.args ?? [],
              env: s.env,
              cwd: s.cwd,
            };
            // First-stage stdin redirect (later stages read the inter-stage pipe).
            if (s.stdinData !== undefined) stage.stdinData = new TextEncoder().encode(s.stdinData);
            return stage;
          }),
        })) as { exitCodes: number[]; stdout: Uint8Array };
        return {
          pids,
          exitCodes: r.exitCodes,
          lastStdout: Promise.resolve(r.stdout),
          stderr: stages.map(() => undefined),
        };
      } catch (e) {
        if (!isNotFound(e)) throw e;
        onStderr('shell: command not found\n');
        return {
          pids,
          exitCodes: stages.map(() => 127),
          lastStdout: Promise.resolve(new Uint8Array()),
          stderr: stages.map(() => undefined),
        };
      }
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
    // Remaining argv become positional params ($1..). With `-c SCRIPT a b`, the
    // POSIX convention applies; here we keep it simple: argv[1] is the script,
    // argv[2..] are positionals.
    const fromArgs = guest.args.length > 1;
    const script = fromArgs ? guest.args[1] : await readAll(guest);
    const positional = fromArgs ? guest.args.slice(2) : [];
    const fsClient = makeFsClient(guest);

    const executor = new Executor(
      makeKernelClient(guest, onStderr),
      {
        cwd: guest.cwd,
        env: { ...guest.env },
        positional,
        name: guest.args[0] ?? 'sh',
        pid: guest.pid,
      },
      // The shell resolves bare command names by deferring to the KERNEL: it
      // passes the name straight through as spawnable "code" and the kernel's
      // command resolver maps it (or returns ENOENT). The shell does not itself
      // enumerate external commands. The FsClient adapter routes redirect I/O
      // and glob through the guest's fs/* syscalls (best-effort; needs a vfs cap).
      { onStdout, onStderr, resolve: (name) => name, fs: fsClient },
    );
    code = await executor.run(parse(script));
    await fsClient.flush();
  } catch (err) {
    onStderr(`shell: ${(err as Error).message}\n`);
    code = 1;
  }

  await Promise.all(writes);
  await writer.close().catch(() => { /* already closed */ });
  await errWriter.close().catch(() => { /* already closed */ });
  guest.exit(code);
}
