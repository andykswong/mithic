import type {
  Capability,
  FdAction,
  KernelEvent,
  ProcessInit,
  ProcessLimits,
  Signal,
  SpawnArgs,
  SyscallRequest,
} from '@mithic/protocol';
import {
  isProcessExit,
  isProcessReady,
  isSyscallResponse,
  isTerminatingSignal,
  signalExitCode,
} from '@mithic/protocol';
import type { Runtime, ProcessHandle } from '@mithic/runtime';
import type { FileSystemProvider } from '@mithic/io/vfs';
import type { HttpClient } from '@mithic/io/net';
import { FetchHttpClient } from '@mithic/io/net';
import { CapabilityManager } from './capability-manager.ts';
import { IpcBroker } from './ipc-broker.ts';
import { ProcessManager } from './process-manager.ts';
import type { WaitResult } from './process-manager.ts';
import { SyscallDispatcher } from './syscall-dispatch.ts';
import type {
  DomMutateHandler,
  SpawnChildResult,
  PipelineStageSpec,
  PipelineChildResult,
} from './syscall-dispatch.ts';

export interface KernelOptions {
  runtime: Runtime;
  vfs: FileSystemProvider;
  /**
   * Optional handler for `dom/mutate` syscalls from guest processes. When set,
   * the kernel forwards batched DomMutation records from a guest to this handler
   * (typically `RemoteDomHost.applyMutations` bound to a container). When unset,
   * `dom/mutate` returns ENOSYS to the guest.
   */
  onDomMutate?: DomMutateHandler;
  /**
   * How to actually start a guest module. The kernel constructs the boot wiring
   * (control + stdio MessagePorts, ProcessInit) and hands it to the launcher.
   * Defaults to a runtime-backed launcher that falls back to an in-process
   * dynamic-import bootstrap when the host has no usable Worker (e.g. Node).
   */
  launcher?: GuestLauncher;
  /**
   * Resolve a bare command NAME (e.g. `cat`) to spawnable guest code for the
   * `process/spawn` syscall. Absolute paths (`/…`, `./…`) and URLs bypass this
   * and are spawned directly; a bare name with no resolver match yields ENOENT.
   * The kernel OWNS what commands exist — guests spawn by name and the kernel
   * resolves. Unset = only paths/URLs are spawnable by guests.
   */
  resolveCommand?: (name: string, cwd: string, env: Record<string, string>) => string | URL | undefined;
  /**
   * HTTP client backing the capability-gated `net/fetch` syscall. The kernel
   * checks the calling process's `net` capability for the request ORIGIN before
   * the client is ever invoked, so a guest can never reach an origin it lacks
   * capability for. Injectable so tests pass a mock ({@link MockHttpClient}) and
   * production passes `globalThis.fetch` via the default {@link FetchHttpClient}.
   * Defaults to a new `FetchHttpClient()`. Pass a no-op/disabled client (or wire
   * a network-less dispatcher directly) to disable network entirely.
   */
  httpClient?: HttpClient;
  /**
   * Optional launcher for runtimes where `capabilities.directPipes === false`
   * (e.g. QuickJS). The kernel calls `relayLauncher.launchRelay()` instead of the
   * normal port-transfer path, passing pipe write/read hooks and a kernel-owned
   * `onSyscall` callback so the launcher can relay I/O over whatever bridge the
   * backend supports (e.g. `__mithic_syscall` in QuickJS).
   * Required when using a non-transferable runtime backend.
   */
  relayLauncher?: RelayLauncher;
  /**
   * C1: grace window (ms) the kernel waits after delivering a TERMINATING signal
   * (SIGTERM/SIGINT/SIGHUP/…) before forcibly tearing the sandbox down. A guest
   * that installs `onSignal` and exits cleanly within this window reports its OWN
   * exit code; a guest that ignores the signal is killed with `128+signum`.
   * Defaults to {@link DEFAULT_SIGNAL_GRACE_MS}.
   */
  signalGraceMs?: number;
  /**
   * K4 (§8.2): heartbeat/health watchdog config. When enabled, the kernel pings
   * each guest's retained control port every `intervalMs` with a
   * `{event:'heartbeat'}` KernelEvent; the guest must reply with a
   * `{type:'heartbeat-ack'}` control message. After `maxMissed` consecutive
   * missed acks the process is declared hung and SIGKILLed (exit 137). Opt-in so
   * existing tests do not flake — unset means no heartbeat monitoring.
   */
  heartbeat?: HeartbeatOptions;
  /**
   * K1: invoked when a process is spawned with a HARD limit the active runtime
   * backend cannot enforce — `memoryMb` on a backend with `memoryLimit:false`
   * (Worker/iframe), or `cpuMs` on a backend with `cpuLimit:false`
   * (Worker/iframe/ivm). Rather than silently dropping the limit, the kernel
   * reports it here so callers can surface a clear diagnostic or refuse to run.
   * Defaults to a `console.warn`. (The kernel still enforces the limits it CAN
   * regardless of backend: timeoutMs/maxOutputBytes via the watchdog, and
   * networkDisabled/maxChildren at the syscall boundary.)
   */
  onLimitUnenforceable?: (pid: number, limit: 'memoryMb' | 'cpuMs', backend: string) => void;
}

/** K4: heartbeat/health-watchdog configuration (§8.2). */
export interface HeartbeatOptions {
  /** Ping interval in ms. Design default: 5000. */
  intervalMs: number;
  /** Consecutive missed acks before declaring the process hung. Design default: 3. */
  maxMissed: number;
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
  /**
   * C1/K3: register a sink for KernelEvents the kernel wants delivered to this
   * guest (`{event:'signal'}`, `{event:'dom/event'}`, `{event:'heartbeat'}`).
   * Relay backends have no transferable control port, so the launcher provides a
   * callback the kernel invokes; the launcher bridges the event into the guest
   * (e.g. by calling a guest-exposed `__mithic_kernel_event(json)` hook). Optional
   * — a launcher that cannot deliver events simply omits it (signals still compute
   * the 128+N exit code on teardown, but the guest's onSignal will not fire).
   */
  onKernelEvent?(sink: (event: KernelEvent) => void): void;
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
  /**
   * Inline stdin payload. When set (and `stdin` is NOT injected), the kernel
   * mints the stdin pipe, gives the child the read end, then writes these bytes
   * into the write end and closes it (EOF). Used for `cmd < file` / `cmd <<<`
   * where the shell has the stdin content in hand and the child must NOT block
   * waiting for a stdin that no peer stage will ever produce. Ignored when an
   * external `stdin` port is injected (the peer owns that stream).
   */
  stdinData?: Uint8Array;
  /**
   * GUI display placement for runtimes that render the guest (e.g. IframeRuntime).
   * `mode: 'inline'` places a visible iframe sized `width`x`height`; the default
   * `'hidden'` keeps it off-screen. Ignored by non-GUI runtimes. The kernel threads
   * this straight through to the launcher and runtime — see {@link DisplayOptions}.
   */
  display?: DisplayOptions;
}

/** GUI display placement, mirroring `SpawnOptions.display` on the runtime. */
export interface DisplayOptions {
  mode: 'hidden' | 'inline' | 'window' | 'fullscreen';
  width?: number;
  height?: number;
  title?: string;
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
  /** Parent pid for each stage (default 0 = kernel). Set for guest-requested pipelines. */
  ppid?: number;
  limits?: ProcessLimits;
  /** Capture this stage's stdout. Only meaningful on the final stage (others are piped). */
  captureStdout?: boolean;
  /** Capture this stage's stderr (each stage keeps its own stderr). */
  captureStderr?: boolean;
  /**
   * Inline stdin for this stage. Only honored on the FIRST stage (later stages
   * read from the previous stage's pipe). Used for `cmd < file` / `cmd <<<` so
   * the head of the pipeline gets its redirect content and an EOF.
   */
  stdinData?: Uint8Array;
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
  /** GUI display placement forwarded to the runtime's `spawn` (see {@link DisplayOptions}). */
  display?: DisplayOptions;
}

/** Starts a guest module against the kernel-built boot wiring. */
export interface GuestLauncher {
  launch(runtime: Runtime, ctx: LaunchContext): Promise<ProcessHandle>;
  kill?(runtime: Runtime, handle: ProcessHandle, signal: Signal): void;
}

/**
 * The Mithic kernel: a singleton that ties together process lifecycle, IPC,
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
  #signalGraceMs: number;
  #heartbeat: HeartbeatOptions | undefined;
  #onLimitUnenforceable: (pid: number, limit: 'memoryMb' | 'cpuMs', backend: string) => void;
  /** K1: per-process limits, consulted by the dispatcher for networkDisabled/maxChildren. */
  #limits = new Map<number, ProcessLimits>();

  constructor(options: KernelOptions) {
    this.#runtime = options.runtime;
    this.#signalGraceMs = options.signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS;
    this.#heartbeat = options.heartbeat;
    this.#onLimitUnenforceable = options.onLimitUnenforceable ?? defaultLimitDiagnostic;
    this.dispatcher = new SyscallDispatcher({
      vfs: options.vfs,
      caps: this.capabilities,
      cwdOf: (pid) => this.#cwds.get(pid) ?? '/',
      limitsOf: (pid) => this.#limits.get(pid),
      ipc: this.ipc,
      directPipes: options.runtime.capabilities.directPipes,
      onDomMutate: options.onDomMutate,
      resolveCommand: options.resolveCommand,
      httpClient: options.httpClient ?? new FetchHttpClient(),
      // Narrow spawn surface: the dispatcher gets ONLY this callback, never the
      // raw Kernel. It cannot forge a parent pid (the kernel-owned pid it was
      // dispatched with is passed straight through) and the kernel always
      // narrows the child's caps from the parent in #spawnChild.
      spawnChild: (parentPid, code, args, injectedPorts) =>
        this.#spawnChild(parentPid, code, args, injectedPorts),
      pipelineChild: (parentPid, stages) => this.#pipelineChild(parentPid, stages),
      waitChild: (pid) => this.wait(pid),
      ppidOf: (pid) => this.processes.get(pid)?.ppid ?? 0,
      chdir: (pid, path) => { this.#cwds.set(pid, path); },
      exitProcess: (pid, code) => { this.#exit(pid, code); },
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
    // K1: record limits so the dispatcher can enforce networkDisabled/maxChildren,
    // and surface a diagnostic for hard limits this backend cannot honor.
    this.#recordLimits(pid, init.limits);

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
    // stdin: an injected port (pipeline peer) wins. Otherwise mint a pipe and,
    // if the caller supplied inline `stdinData`, feed those bytes into the write
    // end and close it (EOF) so a stdin-reading child does not block forever.
    let stdinReadPort: MessagePort;
    if (init.stdin) {
      stdinReadPort = init.stdin;
    } else {
      const stdinPipe = this.ipc.createPipe();
      stdinReadPort = stdinPipe.readPort;
      if (init.stdinData !== undefined) {
        feedPort(stdinPipe.writePort, init.stdinData);
      }
      // else: legacy behavior — the kernel-owned write end is left unattached.
      // A child that reads stdin with neither an injected peer nor stdinData has
      // no producer; supply `stdinData` (e.g. an empty buffer) to deliver EOF.
    }

    // CAP-2: cap captured output and replenish credit as chunks are consumed so
    // the writer never permanently stalls (which previously hung the capture
    // promise and `wait()`). `maxOutputBytes` defaults to a sane 64MiB.
    const maxOutputBytes = init.limits?.maxOutputBytes ?? KERNEL_MAX_OUTPUT_BYTES;

    let stdoutWritePort: MessagePort;
    let stdout: Promise<Uint8Array> | undefined;
    if (init.stdout) {
      stdoutWritePort = init.stdout;
    } else {
      const stdoutPipe = this.ipc.createPipe();
      stdoutWritePort = stdoutPipe.writePort;
      if (init.captureStdout) {
        stdout = this.#drainPort(stdoutPipe.readPort, maxOutputBytes, pid);
      } else {
        // Not captured and kernel-owned: drain-and-discard so the guest's writer
        // gets credit and never blocks (a /dev/null fd). Without this, a child
        // spawned with default stdio that writes to fd 1 would stall on the first
        // write (no reader → no credit) and never reach exit. No cap kill here:
        // a discarded stream is bounded by replenishment, not buffering.
        void this.#drainPort(stdoutPipe.readPort, Infinity);
      }
    }

    let stderrWritePort: MessagePort;
    let stderr: Promise<Uint8Array> | undefined;
    if (init.stderr) {
      stderrWritePort = init.stderr;
    } else {
      const stderrPipe = this.ipc.createPipe();
      stderrWritePort = stderrPipe.writePort;
      if (init.captureStderr) {
        stderr = this.#drainPort(stderrPipe.readPort, maxOutputBytes, pid);
      } else {
        // /dev/null discard drain (see stdout above): keeps the writer unblocked.
        void this.#drainPort(stderrPipe.readPort, Infinity);
      }
    }

    const stdio: MessagePort[] = [stdinReadPort, stdoutWritePort, stderrWritePort];

    // Track injected write ports so #exit can signal EOF if the process exits
    // without closing them (abnormal exit / crash). Only track ports that were
    // injected (init.stdout / init.stderr) — kernel-owned pipes are drained
    // via drainPort which handles EOF separately.
    const injected: MessagePort[] = [];
    if (init.stdout) injected.push(stdoutWritePort);
    if (init.stderr) injected.push(stderrWritePort);
    if (injected.length > 0) this.#injectedWritePorts.set(pid, injected);

    const processInit: ProcessInit = {
      type: 'init',
      entry: typeof code === 'string' ? 'inline' : code,
      args: init.args ?? [],
      env: init.env ?? {},
      cwd,
      pid,
      ppid,
      capabilities: granted,
      // LIM-1: thread limits into ProcessInit so a backend that CAN enforce
      // memory/cpu (quickjs/ivm) sees them. The kernel-side watchdog enforces
      // timeoutMs/maxOutputBytes regardless of backend.
      limits: init.limits,
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
      display: init.display,
    });

    this.#handles.set(pid, handle);

    // LIM-1: arm the kernel-side wall-clock timeout watchdog (backend-agnostic).
    this.#armWatchdog(pid, init.limits);
    // K4: arm the heartbeat/health watchdog (opt-in via KernelOptions.heartbeat).
    this.#armHeartbeat(pid);

    // Surface bootstrap errors from the worker main channel as a crash exit.
    this.#runtime.onMessage(handle, (msg: unknown) => {
      if (msg && typeof msg === 'object' && '__mithic_error' in msg) {
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
          ppid: stage.ppid,
          limits: stage.limits,
          captureStderr: stage.captureStderr,
          // Stage i (i>0) reads from the read end of pipe i-1. The FIRST stage
          // may instead be fed inline `stdinData` (a redirect source).
          stdin: i > 0 ? pipes[i - 1].readPort : undefined,
          stdinData: i === 0 ? stage.stdinData : undefined,
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
    this.#recordLimits(pid, init.limits);

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
      // C1/K3: the launcher registers a sink so the kernel can deliver signal /
      // dom-event / heartbeat KernelEvents to the guest over the relay bridge.
      onKernelEvent: (sink) => { this.#relaySignalSinks.set(pid, sink); },
    };

    this.processes.markReady(pid);

    const handle = await this.#relayLauncher.launchRelay(this.#runtime, relayCtx);
    this.#handles.set(pid, handle);

    // LIM-1: arm the kernel-side wall-clock timeout watchdog (relay backend too).
    this.#armWatchdog(pid, init.limits);
    // K4: arm the heartbeat/health watchdog (opt-in).
    this.#armHeartbeat(pid);

    return { pid, stdout, stderr };
  }

  /**
   * Create a child process for a guest's `process/spawn` syscall. This is the
   * ONLY spawn surface exposed (via a narrow callback) to the SyscallDispatcher.
   *
   * Capability narrowing: the child inherits the PARENT's capabilities, narrowed
   * (a child can only ever hold a subset — `spawn()` runs them through
   * `capabilities.narrow(parentPid, …)`). A guest cannot widen a child's grants.
   *
   * fd actions (`SpawnArgs.fds`) are applied to wire the child's stdio:
   *   - `pipe`   — the kernel mints a fresh pipe. The child gets the guest-side
   *                end (fd 0 → read end; fd 1/2 → write end); the OTHER end is
   *                transferred back to the PARENT in `SpawnResult.pipes` so the
   *                parent can drive the child's stdin / drain its stdout/stderr.
   *   - `dup2` from an injected port — the guest passed a MessagePort it owns
   *                (e.g. a pipe end from `fs/pipe`) for this fd; the kernel uses
   *                it directly as the child's stdio (zero-hop guest↔guest pipe).
   *   - `inherit` / unset — the child gets a fresh kernel-owned stdio pipe (its
   *                output is not connected to the parent unless captured).
   *   - `close`  — the fd is left unwired (guest sees /dev/null semantics).
   *   - `open`   — DEFERRED: an fd backed by a VFS file open is not yet wired;
   *                treated as `inherit` for now (no silent data loss — the child
   *                simply gets a default stdio pipe).
   */
  async #spawnChild(
    parentPid: number,
    code: string | URL,
    args: SpawnArgs,
    injectedPorts: Map<number, MessagePort>,
  ): Promise<SpawnChildResult> {
    const fds = args.fds ?? {};
    const init: SpawnInit = {
      args: args.argv,
      env: args.env,
      cwd: args.cwd ?? this.#cwds.get(parentPid) ?? '/',
      ppid: parentPid,
      // Child inherits the parent's caps; spawn() narrows them against the
      // parent (a no-op for an equal set, but the narrow path is what enforces
      // that a child can never hold more than its parent).
      capabilities: this.capabilities.capabilities(parentPid),
    };

    // Parent-facing pipe ports to transfer back, and the pipes map for the result.
    const transfer: Transferable[] = [];
    const pipes: Record<number, 'transferred'> = {};

    for (const [fdStr, action] of Object.entries(fds)) {
      const fd = Number(fdStr);
      this.#applyFdAction(fd, action, init, injectedPorts, transfer, pipes);
    }

    const { pid } = await this.spawn(code, init);

    const result: SpawnChildResult = { pid };
    if (Object.keys(pipes).length > 0) result.pipes = pipes;
    if (transfer.length > 0) result.transfer = transfer;
    return result;
  }

  /**
   * Apply a single {@link FdAction} for the child's fd, mutating `init` to inject
   * the child-side stdio port and pushing any parent-facing pipe ports into
   * `transfer` / recording them in `pipes`.
   *
   * Only stdio fds 0/1/2 are supported for port injection and pipe actions.
   * fd >= 3 with a `pipe` or `dup2` action is not yet wired into the child's
   * preopen table; the kernel rejects such actions with EINVAL (pipe: both
   * freshly minted ports are closed to avoid a leak; dup2: the injected port is
   * closed). This is a deliberate, documented limitation — callers must not pass
   * fd >= 3 until the preopen-for-arbitrary-fds path is implemented.
   */
  #applyFdAction(
    fd: number,
    action: FdAction,
    init: SpawnInit,
    injectedPorts: Map<number, MessagePort>,
    transfer: Transferable[],
    pipes: Record<number, 'transferred'>,
  ): void {
    switch (action.action) {
      case 'pipe': {
        // Fix 4: fd >= 3 pipe actions are unsupported — the kernel has no path
        // to wire an arbitrary fd into a child's preopen table yet. Reject here
        // (throw so #spawnChild propagates EINVAL back to the dispatcher) rather
        // than silently minting and leaking two MessagePorts.
        if (fd > 2) {
          throw Object.assign(
            new Error(`process/spawn: pipe fd action on fd ${fd} is not supported (only fd 0–2)`),
            { errno: 'EINVAL' as const },
          );
        }
        const pipe = this.ipc.createPipe();
        if (fd === 0) {
          // Child reads stdin: child gets read end; parent gets write end.
          init.stdin = pipe.readPort;
          transfer.push(pipe.writePort);
        } else {
          // Child writes (fd 1/2): child gets write end; parent gets read end.
          if (fd === 1) init.stdout = pipe.writePort;
          else if (fd === 2) init.stderr = pipe.writePort;
          transfer.push(pipe.readPort);
        }
        pipes[fd] = 'transferred';
        break;
      }
      case 'dup2': {
        // The guest injected a port it owns for this fd (port-based dup2).
        const port = injectedPorts.get(fd);
        if (!port) break; // No port supplied: leave unwired (close-like).
        // Fix 4: fd >= 3 dup2 injection is unsupported — close the port so it
        // does not leak, then reject. The port was extracted from injectedPorts
        // which means it came from the guest's transfer list; the kernel is now
        // its owner and must close it if it cannot wire it.
        if (fd > 2) {
          try { port.close(); } catch { /* already closed */ }
          throw Object.assign(
            new Error(`process/spawn: dup2 fd injection on fd ${fd} is not supported (only fd 0–2)`),
            { errno: 'EINVAL' as const },
          );
        }
        if (fd === 0) init.stdin = port;
        else if (fd === 1) init.stdout = port;
        else if (fd === 2) init.stderr = port;
        break;
      }
      case 'inherit':
      case 'open':
      case 'close':
      default:
        // inherit/open/close: leave the child with default kernel-owned stdio
        // (spawn() mints fresh pipes for any fd not injected here). Injected
        // ports already in `injectedPorts` for this fd are wired too.
        if (injectedPorts.has(fd)) {
          const port = injectedPorts.get(fd)!;
          if (fd === 0) init.stdin = port;
          else if (fd === 1) init.stdout = port;
          else if (fd === 2) init.stderr = port;
        }
        break;
    }
  }

  /**
   * Run a guest-requested multi-stage pipeline (the `process/pipeline` syscall),
   * reusing the zero-hop {@link runPipeline} data path but with the CALLER as the
   * parent: every stage gets `ppid = parentPid` and its caps NARROWED from the
   * parent (children can only narrow). The final stage's stdout is captured and
   * returned to the dispatcher, which hands the bytes to the calling guest.
   */
  async #pipelineChild(
    parentPid: number,
    stages: Array<{ code: string | URL; spec: PipelineStageSpec }>,
  ): Promise<PipelineChildResult> {
    const parentCaps = this.capabilities.capabilities(parentPid);
    const parentCwd = this.#cwds.get(parentPid) ?? '/';
    const result = await this.runPipeline(
      stages.map(({ code, spec }, i) => ({
        code,
        args: spec.argv,
        env: spec.env,
        cwd: spec.cwd ?? parentCwd,
        // Children narrow from the parent; runPipeline → spawn applies the narrow.
        capabilities: parentCaps,
        ppid: parentPid,
        captureStdout: i === stages.length - 1,
        // Only the first stage may carry an inline stdin (redirect source).
        stdinData: i === 0 ? spec.stdinData : undefined,
      })),
    );
    const lastStdout = result.lastStdout ? await result.lastStdout : new Uint8Array();
    return { exitCodes: result.exitCodes, lastStdout };
  }

  /**
   * Kernel-owned syscall routing for the relay path. The launcher passes the
   * guest's raw `call`+`args`; the kernel binds the correct, kernel-owned `pid`
   * and dispatches through its own `SyscallDispatcher`, so all capability checks
   * run in-kernel — identical to the transfer path. The launcher can neither
   * forge the pid nor reach the dispatcher directly.
   *
   * If the dispatcher returns a non-empty `transfer` list (e.g. `fs/pipe` ports),
   * those transferables cannot cross the relay bridge — the relay context has no
   * postMessage transfer mechanism. Any minted ports MUST be closed here to avoid
   * leaks, and ENOSYS is returned to the guest instead.
   */
  async #relaySyscall(
    pid: number,
    call: string,
    args: Record<string, unknown>
  ): Promise<RelaySyscallResult> {
    const { response, transfer } = await this.dispatcher.dispatch(pid, { id: 0, call, args });
    // If the dispatch minted transferable ports (or other transferables), they
    // cannot be delivered over the relay bridge. Close every minted MessagePort
    // to prevent leaks and surface ENOSYS so the guest gets a clean error.
    if (transfer && transfer.length > 0) {
      for (const t of transfer) {
        if (t instanceof MessagePort) t.close();
      }
      return { ok: false, error: { code: 'ENOSYS', message: `${call} unsupported on non-transferable backend` } };
    }
    return response.ok
      ? { ok: true, result: response.result }
      : { ok: false, error: response.error };
  }

  #handles = new Map<number, ProcessHandle>();
  /**
   * C1/K3: per-process RETAINED kernel-side control port. The kernel keeps this
   * MessagePort so it can POST KernelEvents (`{event:'signal'}`, `{event:'dom/
   * event'}`, `{event:'heartbeat'}`) to a running guest. The transfer path stores
   * the minted `kernelSide` here; relay backends have no transferable port, so
   * signal events are delivered to the launcher via a registered callback instead.
   */
  #controlPorts = new Map<number, MessagePort>();
  /**
   * C1: relay-backend signal sinks. A relay launcher (non-transferable backend)
   * registers a callback per pid so the kernel can deliver `{event:'signal'}` to
   * the guest even without a transferable control port. Unset for the relay path =
   * the signal is recorded but not delivered to guest code (still computes 128+N).
   */
  #relaySignalSinks = new Map<number, (event: KernelEvent) => void>();
  /**
   * LIM-1: per-process wall-clock timeout watchdog timers. Started by `spawn`/
   * `#spawnRelay` when `limits.timeoutMs` is set, cleared in `#exit`. Backend-
   * agnostic — the kernel SIGKILLs an over-time process regardless of whether
   * the runtime enforces timeouts itself (Worker/iframe do not).
   */
  #watchdogs = new Map<number, ReturnType<typeof setTimeout>>();
  /** C1: per-process grace-window timers armed after a terminating signal is delivered. */
  #signalGraceTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** K4: per-process heartbeat interval timers and missed-ack counters. */
  #heartbeatTimers = new Map<number, ReturnType<typeof setInterval>>();
  #heartbeatMissed = new Map<number, number>();

  /**
   * K1: record a process's limits (for dispatcher-side networkDisabled/maxChildren
   * enforcement) and surface a diagnostic for any HARD limit this backend cannot
   * honor — `memoryMb` when `capabilities.memoryLimit` is false, `cpuMs` when
   * `capabilities.cpuLimit` is false — rather than silently dropping it.
   */
  #recordLimits(pid: number, limits: ProcessLimits | undefined): void {
    if (!limits) return;
    this.#limits.set(pid, limits);
    const caps = this.#runtime.capabilities;
    const backend = this.#runtime.constructor?.name ?? 'runtime';
    if (limits.memoryMb !== undefined && !caps.memoryLimit) {
      this.#onLimitUnenforceable(pid, 'memoryMb', backend);
    }
    if (limits.cpuMs !== undefined && !caps.cpuLimit) {
      this.#onLimitUnenforceable(pid, 'cpuMs', backend);
    }
  }

  /**
   * Arm a kernel-side wall-clock watchdog for `pid` if `limits.timeoutMs` is set.
   * On expiry, if the process is still alive, SIGKILL it — its `wait()` then
   * resolves with the SIGKILL exit status (137, nonzero). `unref()` (when
   * available) keeps the timer from holding the event loop open. Idempotent
   * per pid; cleared by `#clearWatchdog` on exit.
   */
  #armWatchdog(pid: number, limits: ProcessLimits | undefined): void {
    const timeoutMs = limits?.timeoutMs;
    if (timeoutMs === undefined || timeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.#watchdogs.delete(pid);
      if (this.processes.get(pid)?.state !== 'DEAD') {
        try { this.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.#watchdogs.set(pid, timer);
  }

  /** Clear a process's timeout watchdog (on exit). */
  #clearWatchdog(pid: number): void {
    const timer = this.#watchdogs.get(pid);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#watchdogs.delete(pid);
    }
  }
  /**
   * Per-process injected stdio write ports that must be signalled on exit.
   * When `spawn()` wires a pipeline stage (init.stdout is an injected write
   * port), the kernel keeps a reference here so `#exit` can send EOF to the
   * downstream reader if the process exits without closing its stdout.
   * Map value: array of [port, label] pairs for debugging clarity.
   */
  #injectedWritePorts = new Map<number, MessagePort[]>();

  #wireControl(pid: number, kernelSide: MessagePort): void {
    // C1/K3: RETAIN the kernel-side control port so the kernel can post
    // KernelEvents (signal / dom-event / heartbeat) to the running guest.
    this.#controlPorts.set(pid, kernelSide);
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
      // K4: heartbeat liveness ack. Resets the missed-ack counter.
      if (isHeartbeatAck(msg)) {
        this.#heartbeatMissed.set(pid, 0);
        return;
      }
      // A syscall response from the guest would be malformed here; the guest
      // sends REQUESTS. Discriminate a request: it has id + call + args.
      if (isSyscallRequestMsg(msg)) {
        // A guest may transfer ports with a syscall (e.g. injecting a pipe end
        // it owns into a `process/spawn` fd). Forward them to the dispatcher.
        const inPorts = e.ports && e.ports.length > 0 ? e.ports : undefined;
        void this.dispatcher.dispatch(pid, msg, inPorts).then(({ response, transfer }) => {
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
    // LIM-1: cancel the wall-clock watchdog (if any) so it cannot fire after the
    // process has already exited (and cannot leak a timer / re-kill a reused pid).
    this.#clearWatchdog(pid);
    // C1/K4: cancel any armed signal grace timer and heartbeat monitor.
    this.#clearSignalGrace(pid);
    this.#clearHeartbeat(pid);
    // C1/K3: drop the retained control port + relay signal sink.
    const ctrl = this.#controlPorts.get(pid);
    if (ctrl) {
      this.#controlPorts.delete(pid);
      // Do NOT close the port here: on the transfer path the guest still owns
      // its end and may post a final lifecycle frame; closing the kernel side
      // can race a pending message. The GC reclaims it once the guest end dies.
    }
    this.#relaySignalSinks.delete(pid);
    // Signal EOF on any injected write ports before the process is torn down.
    // If a pipeline stage exits abnormally without closing its stdout, the
    // downstream stage's portToReadable would hang forever waiting for an
    // {type:'end'} message. Posting it here ensures downstream readers always
    // observe end-of-stream even on an abnormal exit.
    const injected = this.#injectedWritePorts.get(pid);
    if (injected) {
      this.#injectedWritePorts.delete(pid);
      for (const port of injected) {
        try {
          port.postMessage({ type: 'end' });
          port.close();
        } catch {
          // Port may already be closed/neutered (e.g. real Worker path where
          // the port was transferred and the Worker was killed). Ignore.
        }
      }
    }
    this.processes.markExit(pid, code);
    this.dispatcher.closeProcess(pid);
    this.capabilities.revoke(pid);
    this.ipc.releaseByPid(pid);
    this.#cwds.delete(pid);
    this.#limits.delete(pid);
  }

  /**
   * Drain a kernel-side pipe READ port to EOF and concatenate the bytes,
   * enforcing a bounded `maxOutputBytes` so a guest writing without bound cannot
   * (a) hang the capture promise or (b) grow host memory without limit.
   *
   * CAP-2: the previous implementation granted a fixed credit window ONCE and
   * never replenished — a guest writing past it exhausted the writer's credit,
   * `write()` stalled forever, and this promise never resolved (hanging `wait()`
   * and any pipeline). Now we:
   *   - grant an initial credit window, and REPLENISH credit as each chunk is
   *     consumed, so the writer keeps flowing and never permanently stalls;
   *   - accumulate up to `maxOutputBytes` (truncating the chunk that crosses it);
   *   - on overflow, resolve with the truncated bytes, send EOF semantics by
   *     closing the port, and — when a `pid` is supplied — SIGKILL the process so
   *     it cannot keep driving host allocations. The promise ALWAYS resolves.
   * Pass `maxOutputBytes = Infinity` for a discard drain (no cap, no kill): the
   * writer is kept unblocked purely by credit replenishment.
   */
  #drainPort(readPort: MessagePort, maxOutputBytes: number, pid?: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let settled = false;
      readPort.start?.();
      // Sliding credit window. Grant a generous initial window, then REPLENISH
      // credit as bytes are consumed so a writer producing more than one window
      // keeps flowing (CAP-2: the previous code granted once and hung past it).
      // The window is large enough (16MiB) that a single large chunk up to that
      // size flows without a per-chunk-vs-window deadlock; replenishment then
      // sustains unbounded total throughput up to `maxOutputBytes`.
      const window = 1 << 24; // 16MiB window
      readPort.postMessage({ type: 'credit', bytes: window });
      const finish = (value: Uint8Array): void => {
        if (settled) return;
        settled = true;
        try { readPort.close(); } catch { /* already closed */ }
        resolve(value);
      };
      readPort.onmessage = (e: MessageEvent) => {
        const msg = e.data as { type?: string; chunk?: Uint8Array; code?: string };
        if (msg?.type === 'data' && msg.chunk) {
          if (settled) return;
          const chunk = msg.chunk;
          if (total + chunk.byteLength > maxOutputBytes) {
            // Overflow: keep only what fits, truncate, resolve, and kill the guest.
            const room = Math.max(0, maxOutputBytes - total);
            if (room > 0) { chunks.push(chunk.subarray(0, room)); total += room; }
            finish(concat(chunks));
            if (pid !== undefined) {
              try { this.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
            }
            return;
          }
          chunks.push(chunk);
          total += chunk.byteLength;
          // Replenish credit for the bytes we just consumed so the writer can
          // continue (this is what prevents the >window stall / hang).
          readPort.postMessage({ type: 'credit', bytes: chunk.byteLength });
        } else if (msg?.type === 'end') {
          finish(concat(chunks));
        } else if (msg?.type === 'error') {
          if (settled) return;
          settled = true;
          try { readPort.close(); } catch { /* already closed */ }
          reject(new Error(msg.code ?? 'EPIPE'));
        }
      };
    });
  }

  /** Wait for a process to exit and reap it. */
  wait(pid: number): Promise<WaitResult> {
    return this.processes.wait(pid);
  }

  /**
   * C1: send a signal to a process.
   *
   * - **SIGKILL**: hard sandbox teardown, NO event delivery (mirrors Unix). The
   *   process exits `137` (128+9) immediately.
   * - **Deliverable signals** (everything else): the kernel POSTs a
   *   `{event:'signal', payload:{signal}}` KernelEvent over the pid's retained
   *   control port so the guest's `onSignal` handler runs.
   *     - For a TERMINATING signal (SIGTERM/SIGINT/SIGHUP/SIGQUIT/SIGPIPE) the
   *       kernel arms a grace window: if the guest exits on its own within it, it
   *       reports its OWN exit code; otherwise the kernel tears the sandbox down
   *       with `128+signum` (SIGTERM→143, SIGINT→130, …).
   *     - For a NON-terminating signal (SIGUSR1/2, SIGCHLD, SIGCONT) the event is
   *       delivered and the process is left running — the guest decides what to do.
   *
   * Idempotent against an already-dead process (no-op).
   */
  kill(pid: number, signal: Signal = 'SIGKILL'): void {
    const proc = this.processes.get(pid);
    if (!proc || proc.state === 'DEAD') return;
    const handle = this.#handles.get(pid);

    // Always notify the process manager's signal listeners (SIGCHLD wiring etc.).
    this.processes.signal(pid, signal);

    if (signal === 'SIGKILL') {
      if (handle) {
        if (this.#launcher.kill) this.#launcher.kill(this.#runtime, handle, signal);
        else this.#runtime.kill(handle, signal);
      }
      this.#exit(pid, signalExitCode('SIGKILL')); // 137
      return;
    }

    // Deliver the signal as a control-port KernelEvent so the guest's onSignal runs.
    this.#deliverSignalEvent(pid, signal);

    if (!isTerminatingSignal(signal)) {
      // Non-terminating (SIGUSR1/2, SIGCHLD, SIGCONT): deliver only — never tear down.
      return;
    }

    // Terminating signal: give the guest a grace window to exit cleanly, then
    // forcibly tear it down with the 128+signum status if it ignored the signal.
    if (this.#signalGraceTimers.has(pid)) return; // a grace window is already pending
    const forced = signalExitCode(signal);
    const timer = setTimeout(() => {
      this.#signalGraceTimers.delete(pid);
      const still = this.processes.get(pid);
      if (!still || still.state === 'DEAD') return;
      if (handle) {
        if (this.#launcher.kill) this.#launcher.kill(this.#runtime, handle, 'SIGKILL');
        else this.#runtime.kill(handle, 'SIGKILL');
      }
      this.#exit(pid, forced);
    }, this.#signalGraceMs);
    (timer as { unref?: () => void }).unref?.();
    this.#signalGraceTimers.set(pid, timer);
  }

  /**
   * C1/K3: POST a KernelEvent (`signal` / `dom/event` / `heartbeat`) to a guest
   * over its retained control port. On relay (non-transferable) backends there is
   * no transferable port; a registered relay signal sink receives it instead.
   * No-op if the process has no retained port and no sink (already exited).
   */
  #postKernelEvent(pid: number, event: KernelEvent): void {
    const port = this.#controlPorts.get(pid);
    if (port) {
      try { port.postMessage(event); } catch { /* port neutered (guest gone) */ }
      return;
    }
    this.#relaySignalSinks.get(pid)?.(event);
  }

  /** C1: deliver a `{event:'signal'}` KernelEvent to a guest. */
  #deliverSignalEvent(pid: number, signal: Signal): void {
    this.#postKernelEvent(pid, { event: 'signal', payload: { signal } });
  }

  /**
   * K3: forward a host-captured DOM event (a user interaction on a mirrored
   * Remote-DOM element) to the owning guest as a `{event:'dom/event'}`
   * KernelEvent. The guest's remote-dom layer (`onDomEvent`) dispatches it to the
   * matching VNode listener — closing the host→guest half of the Remote DOM loop.
   */
  forwardDomEvent(pid: number, payload: { nodeId: number; eventType: string; payload?: Record<string, unknown> }): void {
    this.#postKernelEvent(pid, { event: 'dom/event', payload });
  }

  /** C1: cancel a pid's pending terminating-signal grace timer (e.g. it exited). */
  #clearSignalGrace(pid: number): void {
    const t = this.#signalGraceTimers.get(pid);
    if (t !== undefined) { clearTimeout(t); this.#signalGraceTimers.delete(pid); }
  }

  /**
   * K4 (§8.2): arm the heartbeat watchdog for `pid` if heartbeat monitoring is
   * enabled. Every `intervalMs` the kernel posts `{event:'heartbeat'}` and counts
   * it as a missed ack until the guest replies `{type:'heartbeat-ack'}` (handled
   * in `#wireControl`, which resets the counter). After `maxMissed` consecutive
   * misses the process is declared hung and SIGKILLed (137).
   */
  #armHeartbeat(pid: number): void {
    const hb = this.#heartbeat;
    if (!hb || hb.intervalMs <= 0) return;
    this.#heartbeatMissed.set(pid, 0);
    const timer = setInterval(() => {
      const proc = this.processes.get(pid);
      if (!proc || proc.state === 'DEAD') { this.#clearHeartbeat(pid); return; }
      const missed = (this.#heartbeatMissed.get(pid) ?? 0) + 1;
      this.#heartbeatMissed.set(pid, missed);
      if (missed > hb.maxMissed) {
        // Declared hung: hard-kill (137). #exit (via kill→#exit) clears the timer.
        this.#clearHeartbeat(pid);
        try { this.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        return;
      }
      this.#postKernelEvent(pid, { event: 'heartbeat' });
    }, hb.intervalMs);
    (timer as { unref?: () => void }).unref?.();
    this.#heartbeatTimers.set(pid, timer);
  }

  /** K4: cancel a pid's heartbeat monitor. */
  #clearHeartbeat(pid: number): void {
    const t = this.#heartbeatTimers.get(pid);
    if (t !== undefined) { clearInterval(t); this.#heartbeatTimers.delete(pid); }
    this.#heartbeatMissed.delete(pid);
  }
}

/**
 * Default cap on total buffered relay output per stream (stdout/stderr) when
 * `limits.maxOutputBytes` is unset. Matches the transfer path's drainPort credit
 * bound (1<<24 = 16MiB)... but relays may legitimately produce more, so default
 * to 64MiB. Beyond this the relay stops buffering and terminates the guest.
 */
const RELAY_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * Default cap on captured (transfer-path) output per stream when
 * `limits.maxOutputBytes` is unset. Beyond this the capture is truncated, the
 * promise resolves, and the producing process is killed (CAP-2). 64MiB matches
 * the relay path's default.
 */
const KERNEL_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * C1: default grace window (ms) after delivering a terminating signal before the
 * kernel forcibly tears the sandbox down. Long enough for a guest's async
 * onSignal handler + clean exit to run; short enough not to wedge shutdown.
 */
const DEFAULT_SIGNAL_GRACE_MS = 2000;

/** K1: default diagnostic for a hard limit the active backend cannot enforce. */
function defaultLimitDiagnostic(pid: number, limit: 'memoryMb' | 'cpuMs', backend: string): void {
  const cap = limit === 'memoryMb' ? 'memoryLimit' : 'cpuLimit';
  console.warn(
    `[mithic] pid ${pid}: ProcessLimits.${limit} cannot be enforced by the ${backend} backend `
    + `(no ${cap} capability) — the limit is NOT applied. `
    + 'Use a backend that supports it (QuickJS/ivm for memory) or remove the limit.',
  );
}

function isSyscallRequestMsg(x: unknown): x is SyscallRequest {
  return typeof x === 'object' && x !== null
    && 'id' in x && typeof (x as { id: unknown }).id === 'number'
    && 'call' in x && typeof (x as { call: unknown }).call === 'string'
    && 'args' in x;
}

/** K4: a guest's liveness reply to a `{event:'heartbeat'}` ping. */
function isHeartbeatAck(x: unknown): x is { type: 'heartbeat-ack' } {
  return typeof x === 'object' && x !== null
    && (x as { type?: unknown }).type === 'heartbeat-ack';
}

/**
 * Write `data` into a kernel-owned pipe WRITE port using the credit protocol the
 * guest's readable side speaks, then send EOF. The reader (the child's stdin
 * stream) grants credit before any bytes may be sent; we park until enough
 * credit arrives, emit the (single) data chunk, then `end`. An empty buffer
 * sends EOF immediately. If the reader cancels (EPIPE) we just stop. Fire and
 * forget: the kernel does not await stdin delivery (the child drains at its own
 * pace), but errors are swallowed so a closed reader never rejects unhandled.
 */
function feedPort(writePort: MessagePort, data: Uint8Array): void {
  writePort.start?.();
  let credit = 0;
  let sent = false;
  const trySend = (): void => {
    if (sent) return;
    if (data.byteLength === 0 || credit >= data.byteLength) {
      sent = true;
      if (data.byteLength > 0) writePort.postMessage({ type: 'data', chunk: data });
      writePort.postMessage({ type: 'end' });
      writePort.close();
    }
  };
  writePort.onmessage = (e: MessageEvent): void => {
    const msg = e.data as { type?: string; bytes?: number };
    if (msg?.type === 'credit') { credit += msg.bytes ?? 0; trySend(); }
    else if (msg?.type === 'error' || msg?.type === 'end') {
      // Reader cancelled / closed: stop without sending.
      sent = true;
      try { writePort.close(); } catch { /* already closed */ }
    }
  };
  // Empty payload: deliver EOF immediately without waiting for credit.
  if (data.byteLength === 0) trySend();
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
        display: ctx.display,
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
  const dir = await mkdtemp(join(tmpdir(), 'mithic-guest-'));
  const file = join(dir, 'guest.mjs');
  await writeFile(file, code);
  const mod = await import(pathToFileURL(file).href);
  return mod.default as GuestDefault;
}
