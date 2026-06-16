import type {
  Capability,
  ProcessInit,
  ProcessLimits,
  Signal,
  SyscallRequest,
} from '@mithic/protocol';
import { isProcessExit, isProcessReady, isSyscallResponse } from '@mithic/protocol';
import type { Runtime, ProcessHandle } from '@mithic/runtime';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { CapabilityManager } from './capability-manager.ts';
import { IpcBroker } from './ipc-broker.ts';
import { ProcessManager } from './process-manager.ts';
import type { WaitResult } from './process-manager.ts';
import { SyscallDispatcher } from './syscall-dispatch.ts';

export interface KernelOptions {
  runtime: Runtime;
  vfs: FileSystemProvider;
  /**
   * How to actually start a guest module. The kernel constructs the boot wiring
   * (control + stdio MessagePorts, ProcessInit) and hands it to the launcher.
   * Defaults to a runtime-backed launcher that falls back to an in-process
   * dynamic-import bootstrap when the host has no usable Worker (e.g. Node).
   */
  launcher?: GuestLauncher;
  /**
   * Optional launcher for runtimes where `capabilities.directPipes === false`
   * (e.g. QuickJS). The kernel calls `relayLauncher.launchRelay()` instead of the
   * normal port-transfer path, passing pipe write/read hooks and a kernel-owned
   * `onSyscall` callback so the launcher can relay I/O over whatever bridge the
   * backend supports (e.g. `__isola_syscall` in QuickJS).
   * Required when using a non-transferable runtime backend.
   */
  relayLauncher?: RelayLauncher;
}

/**
 * Result of routing a guest syscall through the kernel on the relay path.
 * Mirrors the shape of {@link SyscallResponse} minus the request id, which the
 * kernel owns internally.
 */
export type RelaySyscallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/**
 * I/O relay context provided to a `RelayLauncher` for non-transferable backends.
 * The launcher drives pipe data through these callbacks instead of transferring ports.
 *
 * SECURITY: the launcher is NEVER given the raw `SyscallDispatcher` or a pid it
 * can pass to `dispatch`. Instead it relays the guest's raw syscall via
 * {@link onSyscall}, which the KERNEL implements by routing through its dispatcher
 * with the correct, kernel-owned pid. Capability enforcement therefore always runs
 * inside the kernel, identically to the transfer path — a launcher cannot forge a
 * pid or bypass capability checks.
 */
export interface RelayContext {
  code: string | URL;
  init: ProcessInit;
  /**
   * Route a guest syscall through the kernel. The kernel binds the correct pid
   * internally and dispatches through its `SyscallDispatcher`, so all capability
   * checks run in-kernel. The launcher supplies only the guest's raw `call`+`args`.
   */
  onSyscall(call: string, args: Record<string, unknown>): Promise<RelaySyscallResult>;
  /** Push a chunk to stdout (fd 1). */
  writeStdout(chunk: Uint8Array): void;
  /** Push a chunk to stderr (fd 2). */
  writeStderr(chunk: Uint8Array): void;
  /** Close stdout (signals EOF). */
  closeStdout(): void;
  /** Close stderr (signals EOF). */
  closeStderr(): void;
  /** Notify the kernel that the process exited. */
  notifyExit(code: number): void;
}

/**
 * Launcher for runtime backends that cannot transfer MessagePorts
 * (`capabilities.directPipes === false`, e.g. QuickJS).
 * Drives I/O via the relay callbacks in {@link RelayContext} instead of ports.
 */
export interface RelayLauncher {
  launchRelay(runtime: Runtime, ctx: RelayContext): Promise<ProcessHandle>;
  kill?(runtime: Runtime, handle: ProcessHandle, signal: Signal): void;
}

export interface SpawnInit {
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  ppid?: number;
  capabilities?: Capability[];
  captureStdout?: boolean;
  captureStderr?: boolean;
  limits?: ProcessLimits;
  /**
   * Pre-wired stdio ports (dup2-style fd injection, tech design §3.6). When set,
   * the kernel transfers these GUEST-side ports as the guest's preopens instead
   * of minting fresh internal pipes:
   *   - `stdin`  — a pipe READ end the guest reads from (fd 0).
   *   - `stdout` — a pipe WRITE end the guest writes to (fd 1).
   *   - `stderr` — a pipe WRITE end the guest writes to (fd 2).
   * Used by {@link Kernel.runPipeline} to connect stage i's stdout to stage i+1's
   * stdin with a single zero-hop MessageChannel (no kernel relay in the data path).
   * A supplied `stdout`/`stderr` cannot be captured (`captureStdout`/`captureStderr`
   * is ignored for an injected stream, since the kernel does not own its read end).
   */
  stdin?: MessagePort;
  stdout?: MessagePort;
  stderr?: MessagePort;
}

export interface SpawnResult {
  pid: number;
  /** Resolves to captured stdout bytes if `captureStdout` was set. */
  stdout?: Promise<Uint8Array>;
  /** Resolves to captured stderr bytes if `captureStderr` was set. */
  stderr?: Promise<Uint8Array>;
}

/** One stage of a pipeline. `captureStdout` is only honored for the LAST stage. */
export interface PipelineStage {
  code: string | URL;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  capabilities?: Capability[];
  limits?: ProcessLimits;
  /** Capture this stage's stdout. Only meaningful on the final stage (others are piped). */
  captureStdout?: boolean;
  /** Capture this stage's stderr (each stage keeps its own stderr). */
  captureStderr?: boolean;
}

export interface PipelineResult {
  /** PID of each stage, in order. */
  pids: number[];
  /** Exit code of each stage, in order. */
  exitCodes: number[];
  /** Captured stdout of the final stage if it set `captureStdout`. */
  lastStdout?: Promise<Uint8Array>;
  /** Captured stderr per stage where `captureStderr` was set. */
  stderr: Array<Promise<Uint8Array> | undefined>;
}

/**
 * The wiring the kernel passes to a launcher. `control`/`stdio` are the GUEST
 * sides of each MessageChannel and must be transferred into the sandbox in the
 * order the bootstrap expects: transfer = [control, stdin, stdout, stderr].
 */
export interface LaunchContext {
  code: string | URL;
  init: ProcessInit;
  control: MessagePort;
  stdio: MessagePort[];
}

/** Starts a guest module against the kernel-built boot wiring. */
export interface GuestLauncher {
  launch(runtime: Runtime, ctx: LaunchContext): Promise<ProcessHandle>;
  kill?(runtime: Runtime, handle: ProcessHandle, signal: Signal): void;
}

/**
 * The Isola kernel: a singleton that ties together process lifecycle, IPC,
 * capabilities, and syscall dispatch over a pluggable {@link Runtime} backend.
 *
 * Control-plane wiring (transferable backends): the kernel mints a control
 * MessageChannel and keeps `port1` (the kernel side). The guest's `port2` is
 * transferred as `transfer[0]`. The guest sends BOTH syscall requests and
 * lifecycle messages (`ready`/`exit`) over that control port, so the kernel
 * listens on its retained side, discriminates with the protocol guards, routes
 * syscalls through the dispatcher, and posts {@link SyscallResponse}s back.
 * stdio pipes are transferred as `transfer[1..3]`.
 */
export class Kernel {
  readonly processes = new ProcessManager();
  readonly capabilities = new CapabilityManager();
  readonly ipc = new IpcBroker();
  readonly dispatcher: SyscallDispatcher;

  #runtime: Runtime;
  #launcher: GuestLauncher;
  #relayLauncher: RelayLauncher | undefined;
  #cwds = new Map<number, string>();

  constructor(options: KernelOptions) {
    this.#runtime = options.runtime;
    this.dispatcher = new SyscallDispatcher({
      vfs: options.vfs,
      caps: this.capabilities,
      cwdOf: (pid) => this.#cwds.get(pid) ?? '/',
      ipc: this.ipc,
    });
    this.#launcher = options.launcher ?? new DefaultGuestLauncher();
    this.#relayLauncher = options.relayLauncher;
  }

  async spawn(code: string | URL, init: SpawnInit = {}): Promise<SpawnResult> {
    // Non-transferable runtimes (e.g. QuickJS) use the relay path.
    if (!this.#runtime.capabilities.directPipes) {
      return this.#spawnRelay(code, init);
    }
    if (!this.#runtime.capabilities.transferable) {
      throw new Error('Kernel currently requires a transferable runtime backend');
    }

    const ppid = init.ppid ?? 0;
    const pid = this.processes.allocate(ppid);
    const cwd = init.cwd ?? '/';
    this.#cwds.set(pid, cwd);

    // Capabilities: narrow against the parent unless spawned by the kernel (ppid 0).
    const requested = init.capabilities ?? [];
    const granted = ppid === 0 ? requested : this.capabilities.narrow(ppid, requested);
    this.capabilities.grant(pid, granted);

    // Control channel: kernel keeps port1, guest gets port2 as transfer[0].
    const control = new MessageChannel();
    const kernelSide = control.port1;
    const guestControl = control.port2;

    // stdio pipes. Guest preopen indices: 0=stdin, 1=stdout, 2=stderr.
    // stdin: guest reads (read end); kernel keeps write end.
    // stdout/stderr: guest writes (write end); kernel keeps read end.
    //
    // An injected port (init.stdin/stdout/stderr) is transferred straight to the
    // guest — that's the zero-hop pipeline path where the peer stage owns the
    // other end. The kernel does not retain a read end for an injected stream, so
    // capture is only possible for kernel-owned (minted) streams.
    const stdinReadPort = init.stdin ?? this.ipc.createPipe().readPort;

    let stdoutWritePort: MessagePort;
    let stdout: Promise<Uint8Array> | undefined;
    if (init.stdout) {
      stdoutWritePort = init.stdout;
    } else {
      const stdoutPipe = this.ipc.createPipe();
      stdoutWritePort = stdoutPipe.writePort;
      stdout = init.captureStdout ? drainPort(stdoutPipe.readPort) : undefined;
    }

    let stderrWritePort: MessagePort;
    let stderr: Promise<Uint8Array> | undefined;
    if (init.stderr) {
      stderrWritePort = init.stderr;
    } else {
      const stderrPipe = this.ipc.createPipe();
      stderrWritePort = stderrPipe.writePort;
      stderr = init.captureStderr ? drainPort(stderrPipe.readPort) : undefined;
    }

    const stdio: MessagePort[] = [stdinReadPort, stdoutWritePort, stderrWritePort];

    const processInit: ProcessInit = {
      type: 'init',
      entry: typeof code === 'string' ? 'inline' : code,
      args: init.args ?? [],
      env: init.env ?? {},
      cwd,
      pid,
      ppid,
      capabilities: granted,
      preopens: {
        0: { type: 'pipe' },
        1: { type: 'pipe' },
        2: { type: 'pipe' },
      },
    };

    // Wire the kernel-side control port BEFORE launching so no message is lost.
    this.#wireControl(pid, kernelSide);

    const handle = await this.#launcher.launch(this.#runtime, {
      code,
      init: processInit,
      control: guestControl,
      stdio,
    });

    this.#handles.set(pid, handle);

    // Surface bootstrap errors from the worker main channel as a crash exit.
    this.#runtime.onMessage(handle, (msg: unknown) => {
      if (msg && typeof msg === 'object' && '__isola_error' in msg) {
        if (this.processes.get(pid)?.state !== 'DEAD') this.processes.markExit(pid, 1);
      }
    });

    return { pid, stdout, stderr };
  }

  /**
   * Run a pipeline of `cmd1 | cmd2 | … | cmdN` stages with zero-hop data flow.
   *
   * For N stages the kernel mints N-1 pipes. Stage i's stdout WRITE end and stage
   * i+1's stdin READ end are the two ends of one MessageChannel, transferred
   * directly into the respective guests — the bytes hop guest→guest with no kernel
   * relay in the data path (the kernel only ever touches the control plane).
   * This is dup2 fd wiring per tech design §3.6.
   *
   * All stages are spawned concurrently (a pipeline runs its members in parallel,
   * connected by pipes), then the kernel awaits every stage's exit and collects
   * the exit codes in order. The final stage's stdout can be captured.
   */
  async runPipeline(stages: PipelineStage[]): Promise<PipelineResult> {
    if (stages.length === 0) throw new Error('runPipeline requires at least one stage');

    // Mint the inter-stage pipes: pipe i connects stage i (stdout) → stage i+1 (stdin).
    const pipes = Array.from({ length: stages.length - 1 }, () => this.ipc.createPipe());

    const pids: number[] = [];
    const stderr: Array<Promise<Uint8Array> | undefined> = [];
    const spawned = await Promise.all(
      stages.map((stage, i) => {
        const isLast = i === stages.length - 1;
        const init: SpawnInit = {
          args: stage.args,
          env: stage.env,
          cwd: stage.cwd,
          capabilities: stage.capabilities,
          limits: stage.limits,
          captureStderr: stage.captureStderr,
          // Stage i (i>0) reads from the read end of pipe i-1.
          stdin: i > 0 ? pipes[i - 1].readPort : undefined,
          // Stage i (i<last) writes into the write end of pipe i.
          stdout: !isLast ? pipes[i].writePort : undefined,
          // Final stage may capture stdout (it keeps a kernel-owned stdout pipe).
          captureStdout: isLast ? stage.captureStdout : false,
        };
        return this.spawn(stage.code, init);
      })
    );

    for (const s of spawned) { pids.push(s.pid); stderr.push(s.stderr); }
    const lastStdout = spawned[spawned.length - 1]?.stdout;

    // Await every stage and collect exit codes in stage order.
    const waits = await Promise.all(pids.map((pid) => this.wait(pid)));
    const exitCodes = waits.map((w) => w.code);

    return { pids, exitCodes, lastStdout, stderr };
  }

  /**
   * Relay spawn path for runtimes where `capabilities.directPipes === false`
   * (e.g. QuickJS). Instead of transferring MessagePorts into the guest, the
   * kernel keeps all pipe endpoints and relays data through the `RelayContext`
   * callbacks that the launcher bridges to its backend-specific I/O mechanism.
   *
   * The relay captures stdout/stderr by accumulating chunks in a buffer and
   * resolving the capture promise when `closeStdout()`/`closeStderr()` is called.
   */
  async #spawnRelay(code: string | URL, init: SpawnInit): Promise<SpawnResult> {
    if (!this.#relayLauncher) {
      throw new Error(
        'Non-transferable runtime requires a relayLauncher (e.g. QuickJSGuestLauncher)'
      );
    }

    const ppid = init.ppid ?? 0;
    const pid = this.processes.allocate(ppid);
    const cwd = init.cwd ?? '/';
    this.#cwds.set(pid, cwd);

    const requested = init.capabilities ?? [];
    const granted = ppid === 0 ? requested : this.capabilities.narrow(ppid, requested);
    this.capabilities.grant(pid, granted);

    const processInit: ProcessInit = {
      type: 'init',
      entry: typeof code === 'string' ? 'inline' : code,
      args: init.args ?? [],
      env: init.env ?? {},
      cwd,
      pid,
      ppid,
      capabilities: granted,
      limits: init.limits,
      preopens: {
        0: { type: 'pipe' },
        1: { type: 'pipe' },
        2: { type: 'pipe' },
      },
    };

    // Collect stdout/stderr in-memory; resolve when the process closes the pipe.
    // Bound total buffered bytes per stream to avoid an unbounded host-OOM vector:
    // a runaway guest writing forever would otherwise grow host memory without limit.
    // Mirrors the transfer path's `drainPort` credit bound (1<<24). Honors
    // `init.limits?.maxOutputBytes` when set, else a 64MB default.
    const maxOutputBytes = init.limits?.maxOutputBytes ?? RELAY_MAX_OUTPUT_BYTES;
    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let stdoutResolve: ((v: Uint8Array) => void) | undefined;
    let stderrResolve: ((v: Uint8Array) => void) | undefined;

    const stdout: Promise<Uint8Array> | undefined = init.captureStdout
      ? new Promise<Uint8Array>((res) => { stdoutResolve = res; })
      : undefined;
    const stderr: Promise<Uint8Array> | undefined = init.captureStderr
      ? new Promise<Uint8Array>((res) => { stderrResolve = res; })
      : undefined;

    // Once either stream exceeds the cap, stop accumulating, flag overflow, and
    // terminate the process so the guest cannot keep driving host allocations.
    const onOverflow = (): void => {
      if (outputOverflow) return;
      outputOverflow = true;
      // Resolve captures with whatever was buffered up to the cap (truncated).
      stdoutResolve?.(concat(stdoutChunks));
      stderrResolve?.(concat(stderrChunks));
      this.kill(pid, 'SIGKILL');
    };

    const relayCtx: RelayContext = {
      code,
      init: processInit,
      onSyscall: (call, args) => this.#relaySyscall(pid, call, args),
      writeStdout(chunk) {
        if (outputOverflow) return;
        if (stdoutBytes + chunk.byteLength > maxOutputBytes) {
          const room = maxOutputBytes - stdoutBytes;
          if (room > 0) { stdoutChunks.push(chunk.subarray(0, room)); stdoutBytes += room; }
          onOverflow();
          return;
        }
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.byteLength;
      },
      writeStderr(chunk) {
        if (outputOverflow) return;
        if (stderrBytes + chunk.byteLength > maxOutputBytes) {
          const room = maxOutputBytes - stderrBytes;
          if (room > 0) { stderrChunks.push(chunk.subarray(0, room)); stderrBytes += room; }
          onOverflow();
          return;
        }
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
      },
      closeStdout() { stdoutResolve?.(concat(stdoutChunks)); },
      closeStderr() { stderrResolve?.(concat(stderrChunks)); },
      notifyExit: (code) => { this.#exit(pid, code); },
    };

    this.processes.markReady(pid);

    const handle = await this.#relayLauncher.launchRelay(this.#runtime, relayCtx);
    this.#handles.set(pid, handle);

    return { pid, stdout, stderr };
  }

  /**
   * Kernel-owned syscall routing for the relay path. The launcher passes the
   * guest's raw `call`+`args`; the kernel binds the correct, kernel-owned `pid`
   * and dispatches through its own `SyscallDispatcher`, so all capability checks
   * run in-kernel — identical to the transfer path. The launcher can neither
   * forge the pid nor reach the dispatcher directly.
   */
  async #relaySyscall(
    pid: number,
    call: string,
    args: Record<string, unknown>
  ): Promise<RelaySyscallResult> {
    const { response } = await this.dispatcher.dispatch(pid, { id: 0, call, args });
    return response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error };
  }

  #handles = new Map<number, ProcessHandle>();

  #wireControl(pid: number, kernelSide: MessagePort): void {
    kernelSide.start?.();
    kernelSide.onmessage = (e: MessageEvent) => {
      const msg = e.data as unknown;
      if (isProcessReady(msg)) {
        this.processes.markReady(pid);
        return;
      }
      if (isProcessExit(msg)) {
        this.#exit(pid, msg.code);
        return;
      }
      // A syscall response from the guest would be malformed here; the guest
      // sends REQUESTS. Discriminate a request: it has id + call + args.
      if (isSyscallRequestMsg(msg)) {
        void this.dispatcher.dispatch(pid, msg).then(({ response, transfer }) => {
          // The dispatcher may attach transferables (e.g. fs/pipe ports). It also
          // may return a Uint8Array result whose buffer should be transferred.
          const list = transfer
            ? transfer
            : response.ok && response.result instanceof Uint8Array
              ? [response.result.buffer as ArrayBuffer]
              : [];
          kernelSide.postMessage(response, list);
        });
        return;
      }
      // Ignore stray syscall responses / unknown frames.
      if (isSyscallResponse(msg)) return;
    };
    // The guest may not emit an explicit 'ready'; treat first contact as running.
    this.processes.markReady(pid);
  }

  #exit(pid: number, code: number): void {
    if (this.processes.get(pid)?.state === 'DEAD') return;
    this.processes.markExit(pid, code);
    this.dispatcher.closeProcess(pid);
    this.capabilities.revoke(pid);
    this.ipc.releaseByPid(pid);
    this.#cwds.delete(pid);
  }

  /** Wait for a process to exit and reap it. */
  wait(pid: number): Promise<WaitResult> {
    return this.processes.wait(pid);
  }

  /** Send a signal to a process. SIGKILL tears down the sandbox. */
  kill(pid: number, signal: Signal = 'SIGKILL'): void {
    const handle = this.#handles.get(pid);
    this.processes.signal(pid, signal);
    if (signal === 'SIGKILL') {
      if (handle) {
        if (this.#launcher.kill) this.#launcher.kill(this.#runtime, handle, signal);
        else this.#runtime.kill(handle, signal);
      }
      this.#exit(pid, 137);
    } else if (handle) {
      this.#runtime.kill(handle, signal);
    }
  }
}

/**
 * Default cap on total buffered relay output per stream (stdout/stderr) when
 * `limits.maxOutputBytes` is unset. Matches the transfer path's drainPort credit
 * bound (1<<24 = 16MiB)... but relays may legitimately produce more, so default
 * to 64MiB. Beyond this the relay stops buffering and terminates the guest.
 */
const RELAY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function isSyscallRequestMsg(x: unknown): x is SyscallRequest {
  return typeof x === 'object' && x !== null
    && 'id' in x && typeof (x as { id: unknown }).id === 'number'
    && 'call' in x && typeof (x as { call: unknown }).call === 'string'
    && 'args' in x;
}

/** Read a kernel-side pipe read-port to EOF and concatenate the bytes. */
function drainPort(readPort: MessagePort): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    readPort.start?.();
    // Grant generous credit upfront so the writer never stalls.
    readPort.postMessage({ type: 'credit', bytes: 1 << 24 });
    readPort.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; chunk?: Uint8Array; code?: string };
      if (msg?.type === 'data' && msg.chunk) {
        chunks.push(msg.chunk);
      } else if (msg?.type === 'end') {
        readPort.close();
        resolve(concat(chunks));
      } else if (msg?.type === 'error') {
        readPort.close();
        reject(new Error(msg.code ?? 'EPIPE'));
      }
    };
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * Default launcher. On hosts with a usable Worker (browser/iframe), it spawns
 * via the runtime. Otherwise (Node), it bootstraps the guest module in-process
 * by dynamically importing it and invoking its default export with the SAME
 * boot object shape the worker bootstrap builds. The control plane is identical:
 * the guest still talks over the transferred control MessagePort.
 */
export class DefaultGuestLauncher implements GuestLauncher {
  async launch(runtime: Runtime, ctx: LaunchContext): Promise<ProcessHandle> {
    if (typeof (globalThis as { Worker?: unknown }).Worker === 'function') {
      return runtime.spawn(ctx.code, {
        init: ctx.init,
        transfer: [ctx.control, ...ctx.stdio],
      });
    }
    return this.#launchInProcess(runtime, ctx);
  }

  kill(runtime: Runtime, handle: ProcessHandle, signal: Signal): void {
    runtime.kill(handle, signal);
  }

  async #launchInProcess(runtime: Runtime, ctx: LaunchContext): Promise<ProcessHandle> {
    // Reserve a handle id from the runtime's perspective for kill()/onMessage().
    const handle: ProcessHandle = { id: ctx.init.pid };

    const preopenPorts: Record<number, MessagePort> = {};
    ctx.stdio.forEach((port, i) => { if (port != null) preopenPorts[i] = port; });
    const boot = { control: ctx.control, init: ctx.init, preopenPorts };

    const defaultExport = await loadGuestDefault(ctx.code);
    // Fire-and-forget: the guest drives itself, signalling exit over control.
    Promise.resolve(defaultExport(boot)).catch(() => { /* guest crash surfaces via exit */ });
    return handle;
  }
}

type GuestDefault = (boot: unknown) => unknown | Promise<unknown>;

async function loadGuestDefault(code: string | URL): Promise<GuestDefault> {
  if (code instanceof URL) {
    const mod = await import(code.href);
    return mod.default as GuestDefault;
  }
  // Materialize the inline module so its ESM imports/exports resolve normally.
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'isola-guest-'));
  const file = join(dir, 'guest.mjs');
  await writeFile(file, code);
  const mod = await import(pathToFileURL(file).href);
  return mod.default as GuestDefault;
}
