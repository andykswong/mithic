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
import { createGuest, portToReadable, portToWritable, pumpStreamToPort } from '@mithic/guest-runtime';
import type { Guest } from '@mithic/guest-runtime';
import { Executor } from './executor.ts';
import type { OutputSink } from './output-sink.ts';
import type {
  CoprocHandle,
  DuplexFd,
  FsClient,
  KernelClient,
  PipelineRunResult,
  PipelineStageParams,
  SpawnHandle,
  SpawnStreamHandle,
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
      return new TextDecoder().decode(await this.fsReadBytes!(fd));
    },
    // FIX 2 (item A): read the whole fd as RAW bytes (no UTF-8 round-trip). `fsRead`
    // decodes this to a string; a `< file` stdin redirect uses `fsReadBytes`
    // directly so a binary file reaches the command byte-exact.
    async fsReadBytes(fd): Promise<Uint8Array> {
      const meta = metaOf(buffers).get(fd);
      if (!meta) return new Uint8Array();
      const open = (await guest.syscall('fs/open', { path: meta.path, oflags: { read: true } })) as { fd: number };
      const chunks: Uint8Array[] = [];
      for (;;) {
        // `fs/read` resolves to a `Uint8Array` of bytes DIRECTLY (not a `{ data }`
        // wrapper). Tolerate both shapes so reading a `<` redirect source returns
        // the file contents instead of empty.
        const r = await guest.syscall('fs/read', { fd: open.fd, len: 65536 });
        const data = (r instanceof Uint8Array ? r : (r as { data?: Uint8Array } | undefined)?.data) ?? undefined;
        if (!data || data.byteLength === 0) break;
        chunks.push(data);
      }
      await guest.syscall('fs/close', { fd: open.fd });
      let total = 0; for (const c of chunks) total += c.byteLength;
      const buf = new Uint8Array(total); let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return buf;
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
      // A `/dev/udp/...` target is DATAGRAM-oriented (no `\n`, no EOF), so the
      // line-oriented `readLine` below is wrong for it: the executor reads via
      // `readDatagram` (one `fs/read` = one datagram, latin1-preserving) instead.
      // Anchor to the `/dev/udp` mount PREFIX (not a bare substring) so a regular
      // file whose path merely contains `/dev/udp/` is not misclassified.
      const datagram = path === '/dev/udp' || path.startsWith('/dev/udp/');
      let pending = ''; // bytes read past the last delivered line (TCP `readLine` only)
      // A datagram fd is a BINARY byte channel: `echo -ne "\xNN…" >&3` produces a
      // string of byte-valued code units (U+0000–U+00FF), so latin1-encode (each
      // code unit → one byte) to put those bytes on the wire EXACTLY — symmetric
      // with the latin1 `readDatagram` below. `enc.encode` (UTF-8) would expand a
      // byte ≥ 0x80 to two bytes (0xFF → 0xC3 0xBF), corrupting a binary datagram.
      // TCP `write` keeps UTF-8 (`enc.encode`) — a byte stream is text-oriented in
      // the existing `readLine` model and its e2e sends only ASCII.
      const writeBytes = datagram
        ? (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; }
        : (s: string): Uint8Array => enc.encode(s);
      return {
        datagram,
        async write(s: string): Promise<void> {
          await guest.syscall('fs/write', { fd, data: writeBytes(s) });
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
        // ONE datagram per read, binary-exact. Each byte becomes one UTF-16 code
        // unit (latin1), so `$response` holds the raw bytes losslessly and a
        // `printf '%s'` / `od` renders them back byte-for-byte. NO `\n`/pending
        // logic — a datagram is a complete message, not a byte stream.
        async readDatagram(): Promise<string | undefined> {
          const r = await guest.syscall('fs/read', { fd, len: 65536 });
          const data = (r instanceof Uint8Array ? r : (r as { data?: Uint8Array } | undefined)?.data) ?? undefined;
          if (!data || data.byteLength === 0) return undefined;
          let s = '';
          for (const b of data) s += String.fromCharCode(b);
          return s;
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
export function makeKernelClient(guest: Guest, onStderr: (s: string) => void): KernelClient {
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
        // D8: forward an fd-0 stdin source (a `<` / `<<` / `<<<` redirect) as the
        // first (only) stage's `fds[0]` action so the kernel pipe-feeds the child
        // and closes stdin (EOF). Without this a stdin-reading external (e.g.
        // `grep foo < file`) blocks forever waiting for an EOF that never comes.
        const stage: Record<string, unknown> = {
          path: params.code instanceof URL ? params.code.href : String(params.code),
          argv: [name, ...rest],
          env: params.env,
          cwd: params.cwd,
        };
        if (params.fds) stage.fds = params.fds;
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
    // A1: live-stream spawn. `process/spawn` with `fds:{1:{action:'pipe'}}`
    // makes the kernel mint a stdout pipe, give the child the write end, and
    // transfer the READ end back to the shell — surfaced here as a live
    // ReadableStream via B5's port-carrying syscall. The caller pipes it into
    // its own stdout so a large/unbounded final stage streams (no buffer-all).
    // On relay backends no port is transferred (pipe-fd spawns ENOSYS-gate), so
    // we degrade to a buffered `spawn` and return `stdout: undefined`.
    async spawnStream(params: SpawnParams): Promise<SpawnStreamHandle> {
      const [name, ...rest] = params.args ?? [];
      // Streamed fd-0 (a compound-pipeline stage's inherited live stdin): mint a
      // kernel pipe, inject its READ end as the child's fd 0 (dup2 + portFds +
      // transfer), and pump the shell-realm stdin stream into the WRITE end in
      // realm. Mirrors spawnCoproc's child-stdin wiring. Only on a transferable
      // backend (fs/pipe returns ports); else fall through to the fds[0] path.
      // The transferred read port is ports[0] in `transfer` ↔ portFds[0]=0; the
      // fd-1/fd-2 `{action:'pipe'}` read ends are a SEPARATE direction (kernel
      // mints them and returns them to the shell in `ports`) — no slot collision.
      const transfer: MessagePort[] = [];
      let stdinWritePort: MessagePort | undefined;
      const baseFds: Record<number, unknown> = { ...(params.fds ?? {}) };
      if (params.stdinStream) {
        const sp = await guest.syscallPorts('fs/pipe', {});
        const rd = sp.ports[0];
        const wr = sp.ports[1];
        if (rd && wr) {
          baseFds[0] = { action: 'dup2' };
          stdinWritePort = wr;
          transfer.push(rd); // ports[0] in transfer ↔ portFds[0]=0
        } else {
          for (const p of [rd, wr]) p?.close();
        }
      }
      const stage: Record<string, unknown> = {
        path: params.code instanceof URL ? params.code.href : String(params.code),
        argv: [name, ...rest],
        env: params.env,
        cwd: params.cwd,
        // Bug B: pipe BOTH stdout (fd 1, live stream) and stderr (fd 2, buffered)
        // back to the shell. Object-key order ⇒ ports[0] = fd1 read, ports[1] =
        // fd2 read. The stderr port is drained to bytes so the executor can write
        // a failing command's diagnostics to the shell's stderr after it exits.
        // D8: fds[0] (a redirect-fed stdin source) is merged in before fd 1/2 so
        // it does NOT take a transferred-port slot (open/bytes are kernel-driven);
        // a streamed fd-0 sets baseFds[0] = {action:'dup2'} (a transferred port).
        fds: { ...baseFds, 1: { action: 'pipe' }, 2: { action: 'pipe' } },
      };
      if (stdinWritePort) stage.portFds = [0];
      try {
        const { result, ports } = await guest.syscallPorts(
          'process/spawn',
          stage,
          transfer.length ? { transfer } : undefined,
        );
        const pid = (result as { pid: number }).pid;
        // The kernel transfers the stdout read end as ports[0] and the stderr read
        // end as ports[1]. On a relay backend ports is empty → fall back to buffered.
        const readPort = ports[0];
        const errPort = ports[1];
        if (!readPort) {
          // No stdout port came back (a backend that accepted the injected stdin
          // port but returned no fd-1 pipe — no current backend does this). We
          // must NOT start the stdin pump here: it would lock the stream and the
          // buffered fallback's `drainReadable` would then throw on a locked
          // stream. `bufferedParams()` re-drains the (still-unlocked) stream into
          // an fds[0] bytes spec, so close the unused write port first.
          stdinWritePort?.close();
          const buffered = await this.spawn(await bufferedParams());
          let bytes: Uint8Array | undefined;
          if (buffered.stdout) bytes = await buffered.stdout;
          exitCodes.set(pid, exitCodes.get(buffered.pid) ?? 0);
          // Adapt the buffered bytes into a one-shot ReadableStream for a uniform
          // caller, or leave undefined so the caller writes the captured bytes.
          if (bytes && bytes.byteLength > 0) {
            const b = bytes;
            return { pid, stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } }), stderr: buffered.stderr };
          }
          return { pid, stderr: buffered.stderr };
        }
        // Committed to the streaming path (stdout port present). NOW that the
        // child is live (its fd-0 read end grants credit), pump the shell-realm
        // stdin stream into the write end via `pumpStreamToPort` (credit-windowed,
        // NO flush-timer throttle — see its doc for why `pipeTo(portToWritable)`
        // throttles a high-rate small-chunk producer to a de facto hang). A
        // downstream that closes early (EPIPE) or an errored source ends the pump
        // and cancels the source upstream. Started here (not before the !readPort
        // check) so the buffered-fallback path never sees a locked stream.
        if (stdinWritePort && params.stdinStream) {
          void pumpStreamToPort(params.stdinStream, stdinWritePort);
        }
        const stderr = errPort ? drainReadable(portToReadable(errPort)) : undefined;
        return { pid, stdout: portToReadable(readPort), stderr };
      } catch (e) {
        if (isNotFound(e)) {
          const pid = synthPid--;
          onStderr(`shell: ${name}: command not found\n`);
          exitCodes.set(pid, 127);
          return { pid };
        }
        // A relay backend rejects pipe-fd spawns (ENOSYS). Degrade to a buffered
        // `spawn`, first materializing any streamed stdin into an fds[0] bytes
        // spec so the child still receives it. Any minted stdin write port is
        // closed by the buffered path never using it (GC-safe).
        stdinWritePort?.close();
        const bp = await bufferedParams();
        const buffered = await this.spawn(bp);
        let bytes: Uint8Array | undefined;
        if (buffered.stdout) bytes = await buffered.stdout;
        exitCodes.set(buffered.pid, exitCodes.get(buffered.pid) ?? 0);
        if (bytes && bytes.byteLength > 0) {
          const b = bytes;
          return { pid: buffered.pid, stdout: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } }), stderr: buffered.stderr };
        }
        return { pid: buffered.pid, stderr: buffered.stderr };
      }

      // Build SpawnParams for the buffered `spawn` fallback: drain a streamed
      // stdin into an fds[0] bytes spec (a ReadableStream is not a SpawnParams
      // stdin source), else pass params unchanged. Called at most once per spawn.
      async function bufferedParams(): Promise<SpawnParams> {
        if (!params.stdinStream) return params;
        const data = await drainReadable(params.stdinStream);
        return { ...params, stdinStream: undefined, fds: { ...(params.fds ?? {}), 0: { action: 'bytes', data } } };
      }
    },
    // A2: start a coproc. Mint two kernel pipes via `fs/pipe`:
    //   c2s: child writes (its stdout) → shell reads.  Shell keeps c2s READ end.
    //   s2c: shell writes → child reads (its stdin).    Shell keeps s2c WRITE end.
    // Spawn the child with the OTHER ends injected at fd 1 (c2s write) and fd 0
    // (s2c read) via port-injecting `process/spawn` (fds dup2 + portFds).
    //
    // On a RELAY backend `fs/pipe` transfers no ports (the kernel keeps the ends
    // and hands back fd numbers). A relay guest therefore cannot inject the child's
    // stdio itself; it takes the `process/coproc` path instead — the kernel mints
    // and wires both pipes and returns two relay fds the shell drives by fd
    // (`pipe/read`/`pipe/write`/`pipe/close`), adapted to the same CoprocHandle.
    async spawnCoproc(params: SpawnParams): Promise<CoprocHandle> {
      const c2s = await guest.syscallPorts('fs/pipe', {});
      const c2sRead = c2s.ports[0];
      const c2sWrite = c2s.ports[1];
      // Relay backend: the probe pipe came back port-less. Close its kernel-held
      // ends (by fd) and take the kernel-orchestrated `process/coproc` path.
      if (!c2sRead || !c2sWrite) {
        const probe = c2s.result as { readfd?: number; writefd?: number };
        if (probe?.readfd !== undefined) void guest.syscall('pipe/close', { fd: probe.readfd }).catch(() => {});
        if (probe?.writefd !== undefined) void guest.syscall('pipe/close', { fd: probe.writefd }).catch(() => {});
        return spawnCoprocRelay(guest, params);
      }
      const s2c = await guest.syscallPorts('fs/pipe', {});
      const s2cRead = s2c.ports[0];
      const s2cWrite = s2c.ports[1];
      if (!s2cRead || !s2cWrite) {
        for (const p of [c2sRead, c2sWrite, s2cRead, s2cWrite]) p?.close();
        throw Object.assign(new Error('coproc: requires a transferable backend'), { code: 'ENOSYS' });
      }
      const [name, ...rest] = params.args ?? [];
      // Inject child fd 0 = s2cRead (stdin), fd 1 = c2sWrite (stdout). portFds
      // maps transferred ports[i] → child fd; order must match `transfer`.
      const spawnArgs: Record<string, unknown> = {
        path: params.code instanceof URL ? params.code.href : String(params.code),
        argv: [name, ...rest],
        env: params.env,
        cwd: params.cwd,
        fds: { 0: { action: 'dup2' }, 1: { action: 'dup2' } },
        portFds: [0, 1],
      };
      const { result } = await guest.syscallPorts('process/spawn', spawnArgs, {
        transfer: [s2cRead, c2sWrite],
      });
      const pid = (result as { pid: number }).pid;

      // Shell-retained ends, adapted to streams. Read child stdout line-by-line
      // from c2sRead; write child stdin to s2cWrite.
      const readable = portToReadable(c2sRead);
      const writable = portToWritable(s2cWrite);
      const reader = readable.getReader();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let pending = '';
      let eof = false;
      return {
        pid,
        async readLine(): Promise<string | undefined> {
          for (;;) {
            const nl = pending.indexOf('\n');
            if (nl >= 0) { const line = pending.slice(0, nl); pending = pending.slice(nl + 1); return line; }
            if (eof) { if (pending.length > 0) { const l = pending; pending = ''; return l; } return undefined; }
            const { value, done } = await reader.read();
            if (done) { eof = true; continue; }
            if (value && value.byteLength > 0) pending += dec.decode(value, { stream: true });
          }
        },
        async write(s: string): Promise<void> {
          await writer.write(enc.encode(s));
        },
        close(): void {
          void reader.cancel().catch(() => { /* closed */ });
          void writer.close().catch(() => { /* closed */ });
        },
      };
    },
    // D4: deliver a signal to a real child pid via `process/kill`. Synthetic
    // (negative / >=100000) pids have no kernel process — skip them (the shell
    // job table is updated best-effort by killJob regardless).
    kill(pid: number, signal: string): void {
      if (pid <= 0 || pid >= 100000) return;
      void guest.syscall('process/kill', { pid, signal }).catch(() => { /* already gone */ });
    },
    async wait(pid: number) {
      const recorded = exitCodes.get(pid);
      if (recorded !== undefined) return { pid, code: recorded };
      // A1/D4: a REAL pid (from spawnStream / direct spawn) has no pre-recorded
      // code — await its exit via the kernel. Synthetic (negative) pids never
      // reach here without a recorded code.
      if (pid > 0) {
        try {
          const r = (await guest.syscall('process/wait', { pid })) as { code?: number } | undefined;
          const code = r?.code ?? 0;
          exitCodes.set(pid, code);
          return { pid, code };
        } catch {
          return { pid, code: 0 };
        }
      }
      return { pid, code: 0 };
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
            // D8: first-stage fd-0 stdin source (later stages read the inter-stage
            // pipe). The kernel pipe-feeds an `open`/`bytes` fd-0 action.
            if (s.fds) stage.fds = s.fds;
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

/**
 * A2 (relay coproc): start a coproc on a RELAY backend. The shell cannot hold
 * MessagePorts, so instead of minting `fs/pipe` ends + injecting them into the
 * child, it asks the kernel to do the whole duplex via `process/coproc`: the
 * kernel mints the bidirectional pipe pair, wires the child's stdin/stdout to its
 * own held ends, and returns two relay fd NUMBERS — `readfd` (read child stdout)
 * and `writefd` (write child stdin). The shell drives those by fd via
 * `pipe/read`/`pipe/write`/`pipe/close`, adapted to the same {@link CoprocHandle}
 * (`readLine`/`write`/`close`) the executor consumes on every backend.
 */
async function spawnCoprocRelay(guest: Guest, params: SpawnParams): Promise<CoprocHandle> {
  const [name, ...rest] = params.args ?? [];
  const result = (await guest.syscall('process/coproc', {
    path: params.code instanceof URL ? params.code.href : String(params.code),
    argv: [name, ...rest],
    env: params.env,
    cwd: params.cwd,
  })) as { pid: number; readfd: number; writefd: number };
  const { pid, readfd, writefd } = result;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let pending = '';
  let eof = false;
  let closed = false;
  return {
    pid,
    async readLine(): Promise<string | undefined> {
      for (;;) {
        const nl = pending.indexOf('\n');
        if (nl >= 0) { const line = pending.slice(0, nl); pending = pending.slice(nl + 1); return line; }
        if (eof) { if (pending.length > 0) { const l = pending; pending = ''; return l; } return undefined; }
        // Relay `pipe/read` resolves to `{ data: number[] }` (a plain array so it
        // JSON-clones across the QuickJS bridge). Empty array = EOF (peer closed).
        const r = (await guest.syscall('pipe/read', { fd: readfd, len: 65536 })) as { data?: number[] | Uint8Array };
        const raw = r?.data;
        const bytes = raw instanceof Uint8Array ? raw : Array.isArray(raw) ? new Uint8Array(raw) : undefined;
        if (!bytes || bytes.byteLength === 0) { eof = true; continue; }
        pending += dec.decode(bytes, { stream: true });
      }
    },
    async write(s: string): Promise<void> {
      // The kernel encodes a string, but send bytes to match the byte-relay shape.
      await guest.syscall('pipe/write', { fd: writefd, data: enc.encode(s) });
    },
    close(): void {
      if (closed) return;
      closed = true;
      void guest.syscall('pipe/close', { fd: writefd }).catch(() => { /* closed */ });
      void guest.syscall('pipe/close', { fd: readfd }).catch(() => { /* closed */ });
    },
  };
}

/** Bug B: drain a `ReadableStream<Uint8Array>` fully into a single Uint8Array. */
async function drainReadable(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) chunks.push(value);
    }
  } catch { /* stream errored — return what we have */ }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
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
  // The `writeBytes` path forwards raw bytes straight to the guest writer — a
  // guest's stdout reaches the sandbox stream byte-exact (no UTF-8 round-trip).
  const writes: Promise<void>[] = [];
  const onStdout: OutputSink = Object.assign(
    (s: string): void => { writes.push(writer.write(encoder.encode(s))); },
    { writeBytes: (b: Uint8Array): void => { writes.push(writer.write(b)); } },
  );
  const onStderr: OutputSink = Object.assign(
    (s: string): void => { writes.push(errWriter.write(encoder.encode(s))); },
    { writeBytes: (b: Uint8Array): void => { writes.push(errWriter.write(b)); } },
  );

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
    // (default) stdin. When the script comes from `-c` / a file, the guest's
    // stdin stream stays UNCONSUMED — surface it live to the executor so plain
    // `read` / `read -t` work over it (A3 Tier 2). When the script IS stdin, it
    // is drained here and there is no live stdin to offer.
    let script: string;
    let stdinStream: ReadableStream<Uint8Array> | undefined;
    if (cli.commandString !== undefined) {
      script = cli.commandString;
      stdinStream = guest.stdin;
    } else if (cli.scriptFile !== undefined) {
      try {
        script = await Promise.resolve(fsClient.fsRead(fsClient.fsOpen(cli.scriptFile, { read: true })));
      } catch {
        onStderr(`${cli.name ?? 'sh'}: ${cli.scriptFile}: No such file or directory\n`);
        await Promise.all(writes);
        guest.exit(127);
        return;
      }
      stdinStream = guest.stdin;
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
      // command resolver maps it (or returns ENOENT). The FsClient adapter
      // routes redirect I/O and glob through the guest's fs/* syscalls.
      { onStdout, onStderr, resolve: (name) => name, fs: fsClient, stdinStream },
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

    // This guest is never an interactive REPL — it runs a `-c` string, a script
    // FILE, or piped stdin. Bash enables history expansion (`!`) only for
    // interactive shells, so a script's `#!/bin/bash` shebang line (and any literal
    // `!`) must NOT be treated as a history event here. Default it off; an explicit
    // `set -H` in the script can still re-enable it.
    executor.setOption('histexpand', false);

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
