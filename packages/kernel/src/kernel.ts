import type {
  Capability,
  DisplayInfo,
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
  signalExitCode,
  PipeReader,
  decodeCapabilities,
  SECURITY_CAPABILITY_XATTR,
} from '@mithic/protocol';
import type { Runtime, ProcessHandle } from '@mithic/runtime';
import type { FileSystemProvider } from '@mithic/io/vfs';
import { FileSystemError } from '@mithic/io/vfs';
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
import { RelayBridge } from './relay-bridge.ts';
import type { RelaySyscallResult, CoprocChildEnd } from './relay-bridge.ts';
import { Supervisor } from './supervisor.ts';
import type { HeartbeatOptions, SupervisorHost } from './supervisor.ts';
import { FdWiring } from './fd-wiring.ts';
import { classifyExecutable, resolveName } from './exec-resolve.ts';

/**
 * Binfmt-style cap on interpreter-chain re-resolution (a `#!` whose interpreter
 * is itself a `#!` script). Mirrors Linux's `BINPRM_MAX_RECURSION`: bounds both
 * shebang cycles and over-deep chains so they error rather than recurse forever.
 */
const MAX_INTERPRETER_DEPTH = 8;

/**
 * Thrown when sourcing an executable from a VFS path fails. Carries a POSIX
 * `errno` so the dispatcher's `process/spawn` catch surfaces it to the guest
 * (ENOENT for a missing file, EACCES when the execute bit is unset, ELOOP when
 * the interpreter chain exceeds `MAX_INTERPRETER_DEPTH`).
 */
class ExecError extends Error {
  readonly errno: 'ENOENT' | 'EACCES' | 'ELOOP';
  constructor(errno: 'ENOENT' | 'EACCES' | 'ELOOP', message: string) {
    super(message);
    this.errno = errno;
    this.name = 'ExecError';
  }
}

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
   * OF1/G2 (spec §6): host-curated dependency SOURCE TEXTS for browser guests. Map of
   * specifier → self-contained ESM module source (named exports; produced at build time —
   * see the Lab's bundleGuestEsm). The kernel threads this into the boot message so the
   * sandbox bootstrap mints blob: modules and builds `boot.imports`. Host owns the namespace
   * (mirrors `resolveCommand`); a guest cannot add entries. Unset = no curated deps ({}); a
   * zero-dep guest still runs. Node's in-process launcher materializes these as file:// URLs.
   */
  guestImports?: Record<string, string>;
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

export type { HeartbeatOptions } from './supervisor.ts';

export type { RelaySyscallResult } from './relay-bridge.ts';

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
   * K2: GUEST-side preopen ports for fds >= 3 (the child reads/writes these as
   * extra file descriptors). The kernel transfers each into the sandbox as a
   * preopen at the keyed fd. The OTHER end (if a fresh pipe) is the kernel's to
   * drive/drain — used to wire `process/spawn` `pipe`/`dup2`/`open` fd actions for
   * fds beyond 0-2. Keys must be >= 3 (0/1/2 use stdin/stdout/stderr above).
   */
  extraFds?: Record<number, MessagePort>;
  /**
   * D8: fd actions wiring the spawned process's stdio source. Currently only
   * `fds[0]` (the stdin source) is honored, and only on the relay path
   * (`#spawnRelay`): `bytes` feeds a here-string-style buffer, `open` streams a
   * VFS file (capability-checked against the parent's fs grants). The kernel mints
   * a pipe, registers its read end as a kernel-held relay stdin end at fd 0, and
   * pumps the source into the write end. Mirrors {@link PipelineStage.fds}.
   */
  fds?: Record<number, FdAction>;
  /**
   * GUI display placement for runtimes that render the guest (e.g. IframeRuntime).
   * `mode: 'inline'` places a visible iframe sized `width`x`height`; the default
   * `'hidden'` keeps it off-screen. Ignored by non-GUI runtimes. The kernel threads
   * this straight through to the launcher and runtime — see {@link DisplayOptions}.
   */
  display?: DisplayOptions;
  /**
   * G6-CSP-manifest (spec §9): per-guest Content-Security-Policy applied to the
   * iframe srcdoc. Threaded straight through to the launcher and runtime; ignored
   * by non-iframe backends (Worker/QuickJS/ivm have no iframe CSP of their own).
   * When omitted the iframe uses DEFAULT_GUEST_CSP. Compiled host-side from the
   * guest's manifest (see @mithic/desktop manifestCsp).
   */
  csp?: string;
  /**
   * Mark this process's stdio (fds 0/1/2) as connected to an INTERACTIVE
   * terminal — sets `PreopenDescriptor.tty` so the guest's `isatty(fd)` returns
   * true. A terminal frontend (xterm) sets this; a pipeline/redirect/batch spawn
   * leaves it false. Default false.
   */
  tty?: boolean;
}

/** GUI display placement, mirroring `SpawnOptions.display` on the runtime. */
export interface DisplayOptions {
  mode: 'hidden' | 'inline' | 'window' | 'fullscreen';
  width?: number;
  height?: number;
  title?: string;
  /** Host-side per-window mount target; see runtime `SpawnOptions.display.container`. */
  container?: HTMLElement;
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
   * D8: fd wiring for this stage. Only `fds[0]` on the FIRST stage is honored
   * (later stages read the previous stage's pipe): the redirect-fed stdin source
   * — `open` a VFS file (streamed in-kernel) or feed a `bytes` buffer (a `<<` /
   * `<<<` body), credit-windowed, then EOF. Replaces the inline `stdinData`.
   */
  fds?: Record<number, FdAction>;
  /**
   * Mark this stage's stdio (fds 0/1/2) as a TTY — see {@link SpawnInit.tty}.
   * A terminal frontend running a pipeline sets this so each stage's
   * `guest.isatty()` reports true. Default false.
   */
  tty?: boolean;
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
  /**
   * K2: the GUEST preopen fd each `stdio` port maps to, parallel to `stdio`. When
   * omitted the runtime falls back to positional mapping (stdio[0]→fd0, etc.).
   * Supplied when the process has preopen fds beyond stdin/stdout/stderr.
   */
  preopenFds?: number[];
  /** OF1/G2: curated dep source texts, forwarded to `runtime.spawn` / the in-process launcher. */
  guestImports?: Record<string, string>;
  /** GUI display placement forwarded to the runtime's `spawn` (see {@link DisplayOptions}). */
  display?: DisplayOptions;
  /**
   * G6-CSP-manifest (spec §9): per-guest iframe CSP, forwarded to `runtime.spawn`
   * (only the iframe backend applies it). When omitted the iframe uses
   * DEFAULT_GUEST_CSP. See {@link SpawnInit.csp}.
   */
  csp?: string;
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
/**
 * C3: the shared per-process context produced by `Kernel#beginProcess` — the
 * allocated pid, its resolved parent + cwd, and its NARROWED capability set —
 * threaded into `Kernel#buildProcessInit` after the caller wires its stdio.
 */
interface ProcessContext {
  pid: number;
  ppid: number;
  cwd: string;
  granted: Capability[];
}

/**
 * A2 (relay coproc): the kernel-side wiring `#coprocChild` hands `#spawnRelay` so
 * the child's stdio flows to/from the shell's coproc ends instead of the default
 * capture buffer / registered fd-0 source:
 *   - `stdinReadPort` — the s2c READ port; registered as the child's relay stdin
 *     end (fd 0). The shell writes the s2c WRITE end via `pipe/write`.
 *   - `stdout` — a RelayEnd over the c2s WRITE port; `#spawnRelay`'s stdout sink
 *     forwards the child's fd-1 writes into it (credit-windowed) and closes it
 *     (EOF) on exit. The shell reads the c2s READ end via `pipe/read`.
 */
interface RelayCoprocWiring {
  stdinReadPort: MessagePort;
  stdout: CoprocChildEnd;
}

export class Kernel {
  readonly processes = new ProcessManager();
  readonly capabilities = new CapabilityManager();
  readonly ipc = new IpcBroker();
  readonly dispatcher: SyscallDispatcher;

  #runtime: Runtime;
  #vfs: FileSystemProvider;
  #launcher: GuestLauncher;
  #relayLauncher: RelayLauncher | undefined;
  readonly #guestImports: Record<string, string>;
  #cwds = new Map<number, string>();
  #onLimitUnenforceable: (pid: number, limit: 'memoryMb' | 'cpuMs', backend: string) => void;
  /** K1: per-process limits, consulted by the dispatcher for networkDisabled/maxChildren. */
  #limits = new Map<number, ProcessLimits>();
  /**
   * C3/K5: kernel-side byte-relay for `fs/pipe`/`ipc/*` on non-transferable
   * backends. Owns the per-pid relay-fd table + RelayEnd ports; the kernel routes
   * a relay guest's syscall through it and injects its pipe ops into the dispatcher.
   */
  #relay: RelayBridge;
  /**
   * C3: per-process lifecycle timers — wall-clock watchdog (LIM-1), terminating-
   * signal grace window (C1), and the heartbeat/health monitor (K4). Owns the
   * arm/clear timer Maps and calls back into the kernel via {@link SupervisorHost}.
   */
  #supervisor: Supervisor;
  /**
   * C3: wires a `process/spawn` child's fds (pipe/dup2/open/inherit/close) into
   * its {@link SpawnInit}, minting pipes and deferring VFS-file pumps. Mints pipes
   * via the IPC broker and checks `open` against the parent's fs capability.
   */
  #fdWiring: FdWiring;

  constructor(options: KernelOptions) {
    this.#runtime = options.runtime;
    this.#vfs = options.vfs;
    this.#onLimitUnenforceable = options.onLimitUnenforceable ?? defaultLimitDiagnostic;
    // C3: route the bridge's syscalls through this kernel's dispatcher with the
    // correct, kernel-owned pid so capability enforcement runs in-kernel.
    this.#relay = new RelayBridge((pid, call, args) =>
      this.dispatcher.dispatch(pid, { id: 0, call, args }));
    // C3: the Supervisor owns the timers and asks the kernel to act through this
    // narrow host. `forceExit` is the grace-timer teardown (128+signum) that does
    // NOT re-deliver a signal; `kill` routes through the normal SIGKILL→137 path.
    const supervisorHost: SupervisorHost = {
      isAlive: (pid) => this.processes.get(pid)?.state !== 'DEAD',
      kill: (pid, signal) => { this.kill(pid, signal); },
      forceExit: (pid, exitCode) => { this.#forceExit(pid, exitCode); },
      postEvent: (pid, event) => { this.#postKernelEvent(pid, event); },
    };
    this.#supervisor = new Supervisor(
      supervisorHost,
      options.signalGraceMs ?? DEFAULT_SIGNAL_GRACE_MS,
      options.heartbeat,
    );
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
      // A2 (relay coproc): only wired when the backend cannot transfer ports (the
      // transfer path uses the port-injecting process/spawn coproc path instead).
      coprocChild: options.runtime.capabilities.directPipes
        ? undefined
        : (parentPid, code, args, readfd, writefd) => this.#coprocChild(parentPid, code, args, readfd, writefd),
      pipelineChild: (parentPid, stages) => this.#pipelineChild(parentPid, stages),
      waitChild: (pid) => this.wait(pid),
      ppidOf: (pid) => this.processes.get(pid)?.ppid ?? 0,
      chdir: (pid, path) => { this.#cwds.set(pid, path); },
      exitProcess: (pid, code) => { this.#exit(pid, code); },
      // D4: deliver a guest-requested signal to one of its children (ownership
      // already checked in the dispatcher). Cast: the dispatcher passes a
      // SIG-prefixed string the kernel's Signal type accepts.
      killChild: (pid, signal) => { this.kill(pid, signal as Signal); },
      // C2: relay byte-channel ops (pipe/read|write|close) are first-class
      // dispatcher members; the kernel owns the RelayEnd table and services them
      // here. On transfer-path backends the guest holds real ports and never
      // calls these, so an absent relay end yields EBADF (handled in RelayEnd ops).
      relayPipe: {
        read: this.#relay.pipeRead,
        write: this.#relay.pipeWrite,
        close: this.#relay.pipeClose,
      },
    });
    this.#launcher = options.launcher ?? new DefaultGuestLauncher();
    this.#relayLauncher = options.relayLauncher;
    this.#guestImports = options.guestImports ?? {};
    // C3: the fd-wiring strategy mints child pipes via the IPC broker and checks
    // `open` actions against the parent's fs capability before opening the VFS.
    this.#fdWiring = new FdWiring(this.ipc, this.capabilities, this.#vfs);
  }

  /**
   * C3: the shared process-creation prologue both spawn paths (transfer + relay)
   * run identically before they diverge on stdio wiring. Allocates a pid under the
   * resolved parent, records its cwd + limits, and NARROWS its capabilities against
   * the parent (the kernel-spawn case, ppid 0, grants the requested set verbatim;
   * a child can only ever hold a SUBSET of its parent). Returns the context the
   * caller threads into {@link #buildProcessInit} after building its preopens.
   */
  #beginProcess(init: SpawnInit): ProcessContext {
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
    return { pid, ppid, cwd, granted };
  }

  /**
   * C3: build the wire {@link ProcessInit} from the shared {@link ProcessContext}
   * and the caller's `preopens` table. The single source of truth for init
   * derivation across both spawn paths (transfer path passes stdio+extraFds
   * preopens; relay path passes the fixed 0/1/2 pipe preopens). LIM-1: limits are
   * threaded through so a backend that CAN enforce memory/cpu (quickjs/ivm) sees
   * them; the kernel-side watchdog enforces timeoutMs/maxOutputBytes regardless.
   */
  #buildProcessInit(
    code: string | URL,
    init: SpawnInit,
    ctx: ProcessContext,
    preopens: ProcessInit['preopens'],
  ): ProcessInit {
    return {
      type: 'init',
      entry: typeof code === 'string' ? 'inline' : code,
      args: init.args ?? [],
      env: init.env ?? {},
      cwd: ctx.cwd,
      pid: ctx.pid,
      ppid: ctx.ppid,
      capabilities: ctx.granted,
      limits: init.limits,
      preopens,
      display: toDisplayInfo(init.display),
    };
  }

  /** True when `code` names a VFS path (`/…`, `./…`, `../…`) rather than a URL. */
  #isVfsPath(code: string): boolean {
    if (code.includes('://')) return false;
    return code.startsWith('/') || code.startsWith('./') || code.startsWith('../');
  }

  /** VFS existence probe used by the `$PATH` resolver (a missing file → false). */
  async #vfsExists(path: string): Promise<boolean> {
    try {
      await this.#vfs.stat(path);
      return true;
    } catch (err) {
      if (err instanceof FileSystemError && err.code === 'no-entry') return false;
      throw err;
    }
  }

  /**
   * RFC 0001 §4.2: resolve a bare command NAME to a VFS file via `$PATH`. The
   * kernel never holds shell builtins (those resolve in-process in the shell and
   * never reach here), so `builtins` is empty; we walk `env.PATH` (`:`-separated)
   * for a matching VFS file. An explicit path / URL, or a name with no `$PATH`
   * hit, is returned unchanged for the launcher (`resolveCommand` already ran in
   * the dispatcher for guest-requested spawns).
   */
  async #resolvePathName(code: string, env: Record<string, string>): Promise<string> {
    if (this.#isVfsPath(code) || code.includes('://')) return code;
    const pathDirs = (env.PATH ?? '').split(':').filter(Boolean);
    if (pathDirs.length === 0) return code;
    // Probe each candidate up-front so the pure resolver can stay synchronous.
    const exists = new Set<string>();
    for (const dir of pathDirs) {
      const candidate = dir.endsWith('/') ? `${dir}${code}` : `${dir}/${code}`;
      if (await this.#vfsExists(candidate)) exists.add(candidate);
    }
    const resolution = resolveName(code, {
      builtins: new Set(),
      pathDirs,
      exists: (p) => exists.has(p),
    });
    return resolution.layer === 'file' ? resolution.path : code;
  }

  /** Read + concatenate a VFS file's bytes (chunked). */
  async #readVfsBytes(path: string): Promise<Uint8Array> {
    const handle = await this.#vfs.open(path, { read: true });
    try {
      const chunks: Uint8Array[] = [];
      let offset = 0;
      for (;;) {
        const chunk = await this.#vfs.read(handle, offset, 1 << 16);
        if (chunk.byteLength === 0) break;
        chunks.push(chunk);
        offset += chunk.byteLength;
      }
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const bytes = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) { bytes.set(c, pos); pos += c.byteLength; }
      return bytes;
    } finally {
      await this.#vfs.close(handle);
    }
  }

  /** Strip a leading `#!…\n` shebang line so the remainder is valid ESM. */
  #stripShebang(source: string): string {
    if (!source.startsWith('#!')) return source;
    const newline = source.indexOf('\n');
    return newline === -1 ? '' : source.slice(newline + 1);
  }

  /** Read the `security.capability` xattr → the requested `Capability[]` (default-deny). */
  async #readVfsCaps(path: string): Promise<Capability[]> {
    const value = await this.#vfs.getxattr(path, SECURITY_CAPABILITY_XATTR);
    return decodeCapabilities(value ?? undefined);
  }

  /**
   * RFC 0001 §4.2/§4.8: resolve a `code` spec into spawnable guest source + the
   * file-borne capabilities + the argv for interpreter dispatch.
   *
   * A bare NAME first resolves via `$PATH` (S3); an explicit VFS path (`/…`,
   * `./…`, `../…`) is an executable FILE: stat it (missing → ENOENT), require the
   * execute bit (`mode & 0o111`, else EACCES), read its bytes + its
   * `security.capability` xattr (the REQUESTED caps, narrowed against the parent
   * later in `#beginProcess`). The shebang then classifies the file:
   *   - `guest` (`#!/bin/node` or no shebang) → run the (shebang-stripped) source.
   *   - `interpreter` (`#!/bin/bash`, `#!/usr/bin/python`, …) → re-resolve THAT
   *     interpreter by the same rules and run `interpreter <file> <args…>`: the
   *     script PATH is prepended to argv and the spawned process is the
   *     interpreter's source carrying the INTERPRETER's xattr caps.
   *
   * URLs and inline source strings (a non-path, unresolved name) pass through
   * unchanged with no file-borne caps.
   */
  async #resolveExecutable(
    code: string | URL,
    init: SpawnInit,
    depth = 0,
  ): Promise<{ code: string | URL; init: SpawnInit }> {
    // Bound the interpreter chain binfmt-style (Linux caps re-resolution at
    // BINPRM_MAX_RECURSION): a shebang cycle (a→#!/b, b→#!/a) or an over-deep
    // chain must error, not recurse unboundedly into a stack overflow / hang.
    if (depth > MAX_INTERPRETER_DEPTH) {
      throw new ExecError('ELOOP', `exec: interpreter chain too deep (> ${MAX_INTERPRETER_DEPTH})`);
    }
    if (typeof code !== 'string') return { code, init };
    const resolved = await this.#resolvePathName(code, init.env ?? {});
    if (!this.#isVfsPath(resolved)) return { code: resolved, init };

    let stat;
    try {
      stat = await this.#vfs.stat(resolved);
    } catch (err) {
      if (err instanceof FileSystemError && err.code === 'no-entry') {
        throw new ExecError('ENOENT', `exec: no such file: ${resolved}`);
      }
      throw err;
    }
    if ((stat.mode & 0o111) === 0) {
      throw new ExecError('EACCES', `exec: permission denied (not executable): ${resolved}`);
    }

    const source = new TextDecoder().decode(await this.#readVfsBytes(resolved));
    const caps = await this.#readVfsCaps(resolved);
    const classification = classifyExecutable(source);
    if (classification.kind === 'interpreter') {
      // Re-resolve the interpreter by the same rules and run `interp <file> …`.
      // The script path is prepended to argv (after argv0) and the SPAWNED
      // process is the interpreter, carrying ITS xattr caps.
      const interpInit: SpawnInit = {
        ...init,
        args: [init.args?.[0] ?? classification.interpreter, resolved, ...(init.args ?? []).slice(1)],
      };
      return this.#resolveExecutable(classification.interpreter, interpInit, depth + 1);
    }
    return {
      code: this.#stripShebang(source),
      init: { ...init, capabilities: caps },
    };
  }

  async spawn(code: string | URL, init: SpawnInit = {}): Promise<SpawnResult> {
    // RFC 0001 §4.2/§4.8: resolve the spec — a bare name via `$PATH`, an explicit
    // VFS path as an executable FILE (execute-bit + shebang dispatch + xattr
    // caps). URLs / inline source pass through unchanged.
    ({ code, init } = await this.#resolveExecutable(code, init));
    // Non-transferable runtimes (e.g. QuickJS) use the relay path.
    if (!this.#runtime.capabilities.directPipes) {
      return this.#spawnRelay(code, init);
    }
    if (!this.#runtime.capabilities.transferable) {
      throw new Error('Kernel currently requires a transferable runtime backend');
    }

    // C3: shared prologue — allocate the pid, record cwd/limits, narrow caps.
    const ctx = this.#beginProcess(init);
    const { pid } = ctx;

    // D8: a top-level fd-0 stdin source (`bytes`/`open`) wires this process's stdin
    // the same way a pipeline's first stage does — via FdWiring, which sets
    // `init.stdin` to a fresh pipe READ end and defers the source pump until the
    // guest is live (its read end grants credit first). Only `bytes`/`open` make
    // sense as a single-process stdin source; a `pipe`/`dup2` here would mint an
    // unfed/peerless end. An explicit `init.stdin` port (pipeline peer) still wins —
    // the two are mutually exclusive in practice. Cap-check uses ctx.pid: the
    // process reads its OWN stdin file, gated by its already-narrowed grants.
    const fd0Pumps: Array<() => void> = [];
    const fd0 = init.fds?.[0];
    if (fd0 && (fd0.action === 'bytes' || fd0.action === 'open') && init.stdin == null) {
      try {
        await this.#fdWiring.applyAction(ctx.pid, 0, fd0, init, new Map(), [], {}, fd0Pumps);
      } catch (err) {
        this.#exit(pid, 1);
        throw err;
      }
    }

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
    // stdin: an injected port (a pipeline peer, or a D8 fd-0 pipe wired by
    // FdWiring/runPipeline) wins. Otherwise mint a fresh pipe; the kernel-owned
    // write end is left unattached (a stdin-reading child gets no producer — the
    // caller must wire fds[0] to deliver bytes/EOF).
    let stdinReadPort: MessagePort;
    if (init.stdin) {
      stdinReadPort = init.stdin;
    } else {
      const stdinPipe = this.ipc.createPipe();
      stdinReadPort = stdinPipe.readPort;
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
    // K2: positional preopen fds for stdio (0/1/2), extended below with any fd>=3.
    const preopenFds: number[] = [0, 1, 2];
    // A terminal frontend marks stdio as interactive (isatty); fds >= 3 never are.
    const preopens: ProcessInit['preopens'] = stdioPreopens(init.tty === true);
    // K2: wire extra preopen fds (fd >= 3) into the transfer/preopen tables. Each
    // guest-side port is appended to stdio and its fd recorded in preopenFds so
    // the backend bootstrap maps it to the correct preopen index.
    if (init.extraFds) {
      for (const [fdStr, port] of Object.entries(init.extraFds)) {
        const fd = Number(fdStr);
        if (fd < 3) continue; // 0/1/2 are stdin/stdout/stderr
        stdio.push(port);
        preopenFds.push(fd);
        preopens![fd] = { type: 'pipe' };
      }
    }

    // Track injected write ports so #exit can signal EOF if the process exits
    // without closing them (abnormal exit / crash). Only track ports that were
    // injected (init.stdout / init.stderr) — kernel-owned pipes are drained
    // via drainPort which handles EOF separately.
    const injected: MessagePort[] = [];
    if (init.stdout) injected.push(stdoutWritePort);
    if (init.stderr) injected.push(stderrWritePort);
    if (injected.length > 0) this.#injectedWritePorts.set(pid, injected);

    // C3: derive the wire ProcessInit from the shared context + this path's
    // stdio/extraFds preopens (single source of truth across both spawn paths).
    const processInit = this.#buildProcessInit(code, init, ctx, preopens);

    // Wire the kernel-side control port BEFORE launching so no message is lost.
    this.#wireControl(pid, kernelSide);

    const handle = await this.#launcher.launch(this.#runtime, {
      code,
      init: processInit,
      control: guestControl,
      stdio,
      // K2: only pass preopenFds when there are extra fds beyond the default 0/1/2,
      // so the positional fallback path is unaffected for the common case.
      preopenFds: preopenFds.length > 3 ? preopenFds : undefined,
      guestImports: this.#guestImports,
      display: init.display,
      csp: init.csp,
    });

    this.#handles.set(pid, handle);

    // D8: start the fd-0 stdin source pump now that the guest is live (its read end
    // grants credit), then bytes flow + EOF. Same ordering as the pipeline path.
    for (const start of fd0Pumps) start();

    // LIM-1: arm the kernel-side wall-clock timeout watchdog (backend-agnostic).
    this.#supervisor.armWatchdog(pid, init.limits);
    // K4: arm the heartbeat/health watchdog (opt-in via KernelOptions.heartbeat).
    this.#supervisor.armHeartbeat(pid);

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
    // D8: stage-0 fd-0 pumps (an `open`/`bytes` stdin source) are deferred until
    // AFTER the stages spawn, so the child's read end has a reader granting
    // credit before bytes flow — same ordering as `#spawnChild`.
    const filePumps: Array<() => void> = [];
    const inits: SpawnInit[] = [];
    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const isLast = i === stages.length - 1;
      const init: SpawnInit = {
        args: stage.args,
        env: stage.env,
        cwd: stage.cwd,
        capabilities: stage.capabilities,
        ppid: stage.ppid,
        limits: stage.limits,
        captureStderr: stage.captureStderr,
        tty: stage.tty,
        // Stage i (i>0) reads from the read end of pipe i-1. The FIRST stage may
        // instead get a D8 fd-0 source (a `< file` open or a `<<`/`<<<` bytes
        // buffer), wired below via FdWiring (which sets init.stdin to a pipe end).
        stdin: i > 0 ? pipes[i - 1].readPort : undefined,
        // Stage i (i<last) writes into the write end of pipe i.
        stdout: !isLast ? pipes[i].writePort : undefined,
        // Final stage may capture stdout (it keeps a kernel-owned stdout pipe).
        captureStdout: isLast ? stage.captureStdout : false,
      };
      // Apply a first-stage fd-0 action (open/bytes). The cap check on `open`
      // uses the stage's ppid (the parent whose fs grants gate the file).
      const fd0 = i === 0 ? stage.fds?.[0] : undefined;
      if (fd0) {
        await this.#fdWiring.applyAction(stage.ppid ?? 0, 0, fd0, init, new Map(), [], {}, filePumps);
      }
      inits.push(init);
    }
    const spawned = await Promise.all(stages.map((stage, i) => this.spawn(stage.code, inits[i])));
    // Start the fd-0 pumps now that the children are live (their read ends grant credit).
    for (const start of filePumps) start();

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
  async #spawnRelay(code: string | URL, init: SpawnInit, coproc?: RelayCoprocWiring): Promise<SpawnResult> {
    if (!this.#relayLauncher) {
      throw new Error(
        'Non-transferable runtime requires a relayLauncher (e.g. QuickJSGuestLauncher)'
      );
    }

    // C3: shared prologue + init builder (identical to spawn()); the relay path
    // diverges only in using the fixed 0/1/2 pipe preopens (no extra fds).
    const ctx = this.#beginProcess(init);
    const { pid } = ctx;
    // A terminal frontend marks stdio as interactive (isatty), same as the
    // transfer path — the relay path only differs in I/O transport.
    const processInit = this.#buildProcessInit(code, init, ctx, stdioPreopens(init.tty === true));

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
      onSyscall: (call, args) => this.#relay.relaySyscall(pid, call, args),
      writeStdout(chunk) {
        // A2 (relay coproc): the child's stdout flows to the shell's coproc read
        // end (credit-windowed via the RelayEnd), NOT the capture buffer.
        if (coproc) { void coproc.stdout.write(chunk); return; }
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
      closeStdout() {
        // A2 (relay coproc): send EOF to the shell's coproc read end on child exit.
        if (coproc) { coproc.stdout.close(); return; }
        stdoutResolve?.(concat(stdoutChunks));
      },
      closeStderr() { stderrResolve?.(concat(stderrChunks)); },
      notifyExit: (code) => { this.#exit(pid, code); },
      // C1/K3: the launcher registers a sink so the kernel can deliver signal /
      // dom-event / heartbeat KernelEvents to the guest over the relay bridge.
      onKernelEvent: (sink) => { this.#relaySignalSinks.set(pid, sink); },
    };

    // D8 (relay): if the caller wired an fd-0 stdin source (`bytes`/`open`), mint a
    // pipe, register its READ end as a kernel-held relay stdin end at fd 0 (the guest
    // drains it via `pipe/read {fd:0}`), and start the source pump feeding the WRITE
    // end. Symmetric to the transferable path's FdWiring, but the read end stays
    // kernel-side because a relay guest cannot hold a port. No fds[0] → fd 0 stays
    // unregistered and `pipe/read {fd:0}` yields EBADF (no-stdin / /dev/null).
    // A2 (relay coproc): the child's stdin (fd 0) is the shell-driven s2c READ end.
    // Register it directly as the kernel-held relay stdin end; the shell writes it
    // via `pipe/write` (kernel-side RelayEnd at the parent's writefd). This wins
    // over any fds[0] source (a coproc has no redirect stdin).
    if (coproc) {
      // Coproc: the child's fd 0 IS the shell-driven s2c read end.
      this.#relay.registerStdin(pid, coproc.stdinReadPort);
    }
    // D8 (relay): if the caller wired an fd-0 stdin source (`bytes`/`open`), mint a
    // pipe, register its READ end as a kernel-held relay stdin end at fd 0 (the guest
    // drains it via `pipe/read {fd:0}`), and start the source pump feeding the WRITE
    // end. Symmetric to the transferable path's FdWiring, but the read end stays
    // kernel-side because a relay guest cannot hold a port. No fds[0] → fd 0 stays
    // unregistered and `pipe/read {fd:0}` yields EBADF (no-stdin / /dev/null).
    // Only an input source the kernel can feed makes sense as relay stdin. A `pipe`
    // action would mint a read end whose write peer nothing drives → the guest's
    // `pipe/read {fd:0}` would hang; relay guests have no port to dup2 either. So
    // restrict to `bytes`/`open` and ignore the rest (fd 0 stays unregistered → EBADF).
    const fd0 = init.fds?.[0];
    if (!coproc && fd0 && (fd0.action === 'bytes' || fd0.action === 'open')) {
      const stdinInit: SpawnInit = { cwd: init.cwd };
      const filePumps: Array<() => void> = [];
      try {
        // Cap-check the `open` source against THIS process's already-narrowed grants
        // (registered under ctx.pid by #beginProcess) — it reads its own stdin file.
        // Unlike the process/spawn child path (checked pre-grant against the parent),
        // a top-level relay spawn's parent is the kernel (ppid 0, no grants).
        await this.#fdWiring.applyAction(ctx.pid, 0, fd0, stdinInit, new Map(), [], {}, filePumps);
      } catch (err) {
        // A denied/failed stdin source (e.g. EACCES on an ungranted `open`) must not
        // leak the just-allocated pid: tear it down (revokes caps, settles wait())
        // and rethrow so the caller sees the failure instead of a process stuck in
        // LOADING. Mirrors the transferable child path, where applyAction runs before
        // the pid is allocated and a throw leaks nothing.
        this.#exit(pid, 1);
        throw err;
      }
      // applyAction wired the child-side read port into stdinInit.stdin; the kernel
      // holds it as the relay stdin end and drives the pump's write peer.
      if (stdinInit.stdin) {
        this.#relay.registerStdin(pid, stdinInit.stdin);
        for (const start of filePumps) start();
      }
    }

    this.processes.markReady(pid);

    const handle = await this.#relayLauncher.launchRelay(this.#runtime, relayCtx);
    this.#handles.set(pid, handle);

    // LIM-1: arm the kernel-side wall-clock timeout watchdog (relay backend too).
    this.#supervisor.armWatchdog(pid, init.limits);
    // K4: arm the heartbeat/health watchdog (opt-in).
    this.#supervisor.armHeartbeat(pid);

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
   *   - `open`   — K2: the kernel opens the VFS `path` (capability-checked against
   *                the parent's fs grants) and wires it into the child fd: for a
   *                READ open it streams the file's bytes into the child's read end;
   *                for a WRITE open it drains the child's write end into the file.
   *
   * fds >= 3 are fully supported (K2): a `pipe`/`open` action wires a preopen pipe
   * at that fd, and a `dup2` injects a guest-supplied port at that fd.
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
    // K2: VFS-file pump actions deferred until AFTER the child spawns (so the
    // child's read end has a reader granting credit before we feed file bytes).
    const filePumps: Array<() => void> = [];

    for (const [fdStr, action] of Object.entries(fds)) {
      const fd = Number(fdStr);
      await this.#fdWiring.applyAction(parentPid, fd, action, init, injectedPorts, transfer, pipes, filePumps);
    }

    const { pid } = await this.spawn(code, init);

    // Start any VFS-file pumps now that the child is running (its stdio reader/
    // writer ports are live). feed/drain run fire-and-forget against the kernel-
    // retained pipe ends.
    for (const start of filePumps) start();

    const result: SpawnChildResult = { pid };
    if (Object.keys(pipes).length > 0) result.pipes = pipes;
    if (transfer.length > 0) result.transfer = transfer;
    return result;
  }

  /**
   * A2 (relay coproc): start a coproc child on the RELAY path for the
   * `process/coproc` syscall. A relay guest cannot hold MessagePorts, so it cannot
   * take the transferable coproc path (mint `fs/pipe` ends + inject them as the
   * child's stdio). Instead the KERNEL mints the bidirectional pipe pair and keeps
   * every end:
   *
   *   - c2s (child → shell): the child's stdout. The launcher routes the child's
   *     fd-1 writes to `RelayContext.writeStdout`, which `#spawnRelay` (in coproc
   *     mode) forwards into `coproc.stdout` (a RelayEnd over the c2s child-side
   *     port). The shell reads the c2s READ end via `pipe/read {fd: readfd}`.
   *   - s2c (shell → child): the child's stdin. The child reads fd 0 via
   *     `pipe/read {fd:0}`, serviced by a kernel-held relay stdin end
   *     (`registerStdin`) over the s2c READ port. The shell writes the s2c WRITE
   *     end via `pipe/write {fd: writefd}`.
   *
   * Both PARENT-facing ends (c2s read, s2c write) are registered as kernel-held
   * relay ends under the SHELL's pid at the dispatcher-allocated `readfd`/`writefd`.
   * The child's caps are narrowed from the parent (via `#spawnRelay` → `#beginProcess`).
   */
  async #coprocChild(
    parentPid: number,
    code: string | URL,
    args: SpawnArgs,
    readfd: number,
    writefd: number,
  ): Promise<{ pid: number }> {
    // c2s: child writes stdout → shell reads. s2c: shell writes → child reads stdin.
    const c2s = this.ipc.createPipe();
    const s2c = this.ipc.createPipe();
    // Parent-facing ends the shell drives by fd: read c2s, write s2c.
    this.#relay.registerCoprocParentEnds(parentPid, readfd, c2s.readPort, writefd, s2c.writePort);
    // Child-facing ends the kernel drives: stdin = s2c read; stdout = c2s write.
    const childStdout: CoprocChildEnd = this.#relay.coprocChildStdout(c2s.writePort);

    const init: SpawnInit = {
      args: args.argv,
      env: args.env,
      cwd: args.cwd ?? this.#cwds.get(parentPid) ?? '/',
      ppid: parentPid,
      capabilities: this.capabilities.capabilities(parentPid),
    };
    try {
      const { pid } = await this.#spawnRelay(code, init, {
        stdinReadPort: s2c.readPort,
        stdout: childStdout,
      });
      return { pid };
    } catch (err) {
      // Spawn failed after minting the pipes: tear down the parent ends so the
      // shell's readfd/writefd don't dangle (a stray pipe/read would then hang).
      this.#relay.pipeClose(parentPid, readfd);
      this.#relay.pipeClose(parentPid, writefd);
      childStdout.close();
      try { s2c.readPort.close(); } catch { /* closed */ }
      throw err;
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
        // D8: only the first stage may carry an fd-0 stdin source (redirect).
        fds: i === 0 ? spec.fds : undefined,
      })),
    );
    const lastStdout = result.lastStdout ? await result.lastStdout : new Uint8Array();
    return { exitCodes: result.exitCodes, lastStdout };
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
        this.#supervisor.recordHeartbeatAck(pid);
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
    // C3: cancel ALL of this pid's lifecycle timers (wall-clock watchdog, signal
    // grace window, heartbeat monitor) up-front so none can fire after the process
    // has exited (and cannot leak a timer / re-kill a reused pid).
    this.#supervisor.clear(pid);
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
    // K5: tear down any kernel-held relay pipe/IPC ends for this pid.
    this.#relay.closeFds(pid);
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
      // C1: shared sliding-window reader policy. The capture path uses a 16 MiB
      // window so a single large chunk up to that size flows without a
      // per-chunk-exceeds-window deadlock; replenishment sustains unbounded total
      // throughput up to `maxOutputBytes`. The maxOutputBytes cap + SIGKILL stay
      // layered ON TOP here — they are a host-memory-safety policy, not part of
      // the flow-control invariant.
      const flow = new PipeReader(1 << 24); // 16 MiB window
      readPort.postMessage({ type: 'credit', bytes: flow.open() });
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
          flow.recordArrival(chunk.byteLength);
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
          const grant = flow.replenish();
          if (grant > 0) readPort.postMessage({ type: 'credit', bytes: grant });
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

    // Always notify the process manager's signal listeners (SIGCHLD wiring etc.).
    this.processes.signal(pid, signal);

    if (signal === 'SIGKILL') {
      this.#tearDownSandbox(pid);
      this.#exit(pid, signalExitCode('SIGKILL')); // 137
      return;
    }

    // Deliver the signal as a control-port KernelEvent so the guest's onSignal runs.
    this.#deliverSignalEvent(pid, signal);

    // C3: for a TERMINATING signal the Supervisor arms a grace window (idempotent
    // per pid); if the guest does not exit within it, the supervisor force-exits
    // the guest via `#forceExit` with the 128+signum status. For a NON-terminating
    // signal (SIGUSR1/2, SIGCHLD, SIGCONT) this is a no-op — the event was already
    // delivered and the process is left running.
    this.#supervisor.armSignalGrace(pid, signal);
  }

  /**
   * C3: hard sandbox teardown — kill the runtime handle via the launcher (or the
   * runtime directly). Shared by the SIGKILL path and the grace-timer force-exit.
   * Does NOT touch process state; the caller drives `#exit` with the exit code.
   */
  #tearDownSandbox(pid: number): void {
    const handle = this.#handles.get(pid);
    if (!handle) return;
    if (this.#launcher.kill) this.#launcher.kill(this.#runtime, handle, 'SIGKILL');
    else this.#runtime.kill(handle, 'SIGKILL');
  }

  /**
   * C3: force a process down with `exitCode` WITHOUT re-delivering a signal —
   * the Supervisor's grace timer calls this when a guest ignored a terminating
   * signal, applying the 128+signum status. Idempotent against an already-dead
   * process via `#exit`.
   */
  #forceExit(pid: number, exitCode: number): void {
    this.#tearDownSandbox(pid);
    this.#exit(pid, exitCode);
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
/**
 * Map the host-side {@link DisplayOptions} to the wire {@link DisplayInfo} a guest
 * learns at boot. `container` (an HTMLElement) is host-only and never crosses the
 * wire (unserializable / would leak a host ref). A `hidden` mode (or no display)
 * means no usable GUI surface for the guest, so it collapses to `available:false`
 * with no geometry. Absent display → `undefined` (the guest treats unknown as
 * headless).
 */
/**
 * Build the positional stdio preopen table (fds 0/1/2) shared by both spawn
 * paths (transfer and relay). `isTty` marks all three as terminal-connected so a
 * guest's `isatty()` reports true; fds >= 3 are never a TTY and are wired
 * separately by the transfer path.
 */
function stdioPreopens(isTty: boolean): ProcessInit['preopens'] {
  return {
    0: { type: 'pipe', tty: isTty },
    1: { type: 'pipe', tty: isTty },
    2: { type: 'pipe', tty: isTty },
  };
}

function toDisplayInfo(display: DisplayOptions | undefined): DisplayInfo | undefined {
  if (!display) return undefined;
  if (display.mode === 'hidden') return { available: false };
  return {
    available: true,
    mode: display.mode,
    width: display.width,
    height: display.height,
    title: display.title,
  };
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
        preopenFds: ctx.preopenFds,
        guestImports: ctx.guestImports,
        display: ctx.display,
        csp: ctx.csp,
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

    // K2: map each stdio port to its preopen fd (positional default, or the
    // explicit preopenFds mapping when the process has fds beyond 0-2).
    const preopenPorts: Record<number, MessagePort> = {};
    ctx.stdio.forEach((port, i) => {
      if (port == null) return;
      const fd = ctx.preopenFds ? ctx.preopenFds[i] : i;
      if (typeof fd === 'number') preopenPorts[fd] = port;
    });
    // OF1/G2 (spec §6.1): materialize curated deps as file:// URLs so the guest's
    // `import(boot.imports[name])` resolves in Node. Do NOT rely on bare-specifier
    // resolution from the temp dir (os.tmpdir() node_modules won't reach the
    // workspace @mithic/*).
    const { imports, dir } = await materializeImports(ctx.guestImports ?? {});
    const boot = { control: ctx.control, init: ctx.init, preopenPorts, imports };

    const defaultExport = await loadGuestDefault(ctx.code, dir);
    // Fire-and-forget: the guest drives itself, signalling exit over control.
    Promise.resolve(defaultExport(boot)).catch(() => { /* guest crash surfaces via exit */ });
    return handle;
  }
}

type GuestDefault = (boot: unknown) => unknown | Promise<unknown>;

/**
 * OF1/G2 (spec §6.1): write each curated dep's source to a temp `.mjs` sibling and
 * key it by name to its `file://` URL, so a guest's `import(boot.imports[name])`
 * resolves in Node. Zero deps → a frozen empty map + no dir (the guest's own
 * temp-dir minting in `loadGuestDefault` is unaffected), honoring the §4.1
 * always-present `boot.imports` invariant.
 */
async function materializeImports(
  deps: Record<string, string>,
): Promise<{ imports: Record<string, string>; dir: string | undefined }> {
  const names = Object.keys(deps);
  if (names.length === 0) return { imports: Object.freeze({}), dir: undefined };
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'mithic-guest-'));
  const imports: Record<string, string> = {};
  let i = 0;
  for (const name of names) {
    const file = join(dir, `dep-${i++}.mjs`);
    await writeFile(file, deps[name]);
    imports[name] = pathToFileURL(file).href;
  }
  return { imports: Object.freeze(imports), dir };
}

async function loadGuestDefault(code: string | URL, dir?: string): Promise<GuestDefault> {
  if (code instanceof URL) {
    // @vite-ignore: the specifier is a runtime URL Vite cannot statically analyze.
    // This Node-only path never runs in the browser (the examples use
    // InProcessCommandLauncher), but Vite analyzes the built kernel.js and warns —
    // the comment is the documented suppression for an intentionally-dynamic import.
    const mod = await import(/* @vite-ignore */ code.href);
    // Match the Worker/iframe bootstraps' entrypoint contract (spec §4.2/§4.3): a ?bundle IIFE guest has no mod.default and sets globalThis.__mithic_default when the module is imported.
    const def = (mod && typeof mod.default === 'function') ? mod.default : (globalThis as { __mithic_default?: unknown }).__mithic_default;
    return def as GuestDefault;
  }
  // Materialize the inline module so its ESM imports/exports resolve normally.
  // Reuse the deps' temp dir when present so the guest .mjs sits beside them.
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const targetDir = dir ?? (await mkdtemp(join(tmpdir(), 'mithic-guest-')));
  const file = join(targetDir, 'guest.mjs');
  await writeFile(file, code);
  // @vite-ignore: a runtime temp-file URL — see the URL branch above.
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
  // Match the Worker/iframe bootstraps' entrypoint contract (spec §4.2/§4.3): a ?bundle IIFE guest has no mod.default and sets globalThis.__mithic_default when the module is imported.
  const def = (mod && typeof mod.default === 'function') ? mod.default : (globalThis as { __mithic_default?: unknown }).__mithic_default;
  return def as GuestDefault;
}
