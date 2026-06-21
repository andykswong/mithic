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
  DuplexFd,
  FsClient,
  KernelClient,
  PipelineRunResult,
  PipelineStageParams,
  SpawnHandle,
  SpawnParams,
} from './kernel-client.ts';
import { parseCliArgs, VERSION, HELP } from './cli.ts';

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
    // STREAMING `exec N<>path` (e.g. `/dev/tcp/host/port`): open ONE real fd via
    // `fs/open {read,write}` and hold it open across `echo >&N` / `read -u N`.
    // The buffered file path above re-opens per op and drains to EOF on read,
    // which deadlocks on a socket (no EOF; the read depends on a write that has
    // not happened). Writes here hit the live fd immediately; reads accumulate
    // bytes until a newline. The fd's `fs/open` may reject (connection refused /
    // capability denied) — that rejection propagates out of `fsOpenDuplex`.
    async fsOpenDuplex(path): Promise<DuplexFd> {
      const opened = (await guest.syscall('fs/open', { path, oflags: { read: true, write: true } })) as { fd: number };
      const fd = opened.fd;
      const dec = new TextDecoder();
      const enc = new TextEncoder();
      let pending = ''; // bytes read past the last delivered line
      return {
        async write(s: string): Promise<void> {
          await guest.syscall('fs/write', { fd, data: enc.encode(s) });
        },
        async readLine(): Promise<string | undefined> {
          for (;;) {
            const nl = pending.indexOf('\n');
            if (nl >= 0) { const line = pending.slice(0, nl); pending = pending.slice(nl + 1); return line; }
            const r = await guest.syscall('fs/read', { fd, len: 65536 });
            const data = (r instanceof Uint8Array ? r : (r as { data?: Uint8Array } | undefined)?.data) ?? undefined;
            if (!data || data.byteLength === 0) {
              // EOF (peer closed). Flush any trailing partial line once.
              if (pending.length > 0) { const line = pending; pending = ''; return line; }
              return undefined;
            }
            pending += dec.decode(data, { stream: true });
          }
        },
        async close(): Promise<void> {
          await guest.syscall('fs/close', { fd }).catch(() => { /* already closed */ });
        },
      };
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
    // CLI/argv front-end (H1): argv[0] is the program name, argv[1..] are the
    // shell arguments. Recognises -c/-s/-e/-u/-x/-v/-C/--posix/--version/--help/--,
    // $0 override, and positional params per POSIX.
    const argv0 = guest.args[0] ?? 'sh';
    const env = { ...guest.env };
    const cli = parseCliArgs(guest.args.slice(1), argv0, env);

    if (cli.error) { onStderr(cli.error + '\n'); guest.exit(2); return; }
    if (cli.action === 'version') { onStdout(VERSION + '\n'); await Promise.all(writes); guest.exit(0); return; }
    if (cli.action === 'help') { onStdout(HELP); await Promise.all(writes); guest.exit(0); return; }

    const fsClient = makeFsClient(guest);

    // Script source: a `-c` command string, a script FILE read from the VFS, or
    // (default) stdin.
    let script: string;
    if (cli.commandString !== undefined) {
      script = cli.commandString;
    } else if (cli.scriptFile !== undefined) {
      try {
        script = await Promise.resolve(fsClient.fsRead(fsClient.fsOpen(cli.scriptFile, { read: true })));
      } catch {
        onStderr(`${cli.name ?? 'sh'}: ${cli.scriptFile}: No such file or directory\n`);
        await Promise.all(writes);
        guest.exit(127);
        return;
      }
    } else {
      script = await readAll(guest);
    }

    const executor = new Executor(
      makeKernelClient(guest, onStderr),
      {
        cwd: guest.cwd,
        env,
        positional: cli.positional,
        name: cli.name ?? argv0,
        pid: guest.pid,
      },
      // The shell resolves bare command names by deferring to the KERNEL: it
      // passes the name straight through as spawnable "code" and the kernel's
      // command resolver maps it (or returns ENOENT). The shell does not itself
      // enumerate external commands. The FsClient adapter routes redirect I/O
      // and glob through the guest's fs/* syscalls (best-effort; needs a vfs cap).
      { onStdout, onStderr, resolve: (name) => name, fs: fsClient },
    );
    // Seam 1 (C1 ↔ M16): wire kernel-delivered signals to the shell's trap
    // dispatch. The kernel posts `{event:'signal', payload:{signal}}` over the
    // pid's control port (Kernel.kill); the guest API surfaces it via onSignal.
    // The shell stores traps under the canonical NAME (INT/TERM/HUP/…, no `SIG`
    // prefix — see builtins.ts normalizeSignal), so strip the prefix here before
    // dispatching. A delivered signal with a registered trap fires the handler
    // and the shell keeps running; with no trap it is a no-op (the kernel's grace
    // timer still tears the process down for an UNHANDLED terminating signal).
    guest.onSignal((signal) => {
      const name = signal.toUpperCase().replace(/^SIG/, '');
      void executor.runTrap(name);
    });

    // Pre-set the requested options (POSIX mode + -e/-u/-x/-v/-C).
    if (cli.posix) executor.setOption('posix', true);
    for (const opt of cli.options) executor.setOption(opt, true);
    // `-v` (verbose): echo the input to stderr before running.
    if (executor.getOption('verbose')) onStderr(script.endsWith('\n') ? script : script + '\n');

    code = await executor.exec(script);
    await fsClient.flush();
    // Close any persistent numbered fds (e.g. a live `/dev/tcp` socket opened by
    // `exec N<>...`) so the underlying connection is torn down on shell exit.
    executor.closeAllFds();
  } catch (err) {
    onStderr(`shell: ${(err as Error).message}\n`);
    code = 1;
  }

  await Promise.all(writes);
  await writer.close().catch(() => { /* already closed */ });
  await errWriter.close().catch(() => { /* already closed */ });
  guest.exit(code);
}
