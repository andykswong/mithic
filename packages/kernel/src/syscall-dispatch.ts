import type { SyscallResponse, ErrnoCode, SpawnArgs, ProcessLimits, SyscallName, SyscallArgs, FsPathArgs, FdAction } from '@mithic/protocol';
import { fsErrorToErrno, isSyscallName } from '@mithic/protocol';
import { FileSystemError, normalizePath } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import type { HttpClient, HttpRequest, HttpResponse } from '@mithic/io/net';
import { INITIAL_CREDIT_BYTES } from '@mithic/protocol';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';
import type { IpcBroker } from './ipc-broker.ts';
import type { WaitResult } from './process-manager.ts';
import type { DomMutation } from '@mithic/guest-runtime/remote-dom';
import { pumpToPort } from './pump.ts';

/** Thrown when a process references an fd it does not own (wrong pid or never opened). */
class BadFdError extends Error {
  readonly errno: ErrnoCode = 'EBADF';
  constructor(fd: number) {
    super(`Bad file descriptor: ${fd}`);
    this.name = 'BadFdError';
  }
}

/**
 * C2: thrown by a `parse*` boundary helper when a guest sends malformed args
 * (e.g. a missing required field, or `fd` that is not a number). Maps to EINVAL.
 * This is the single runtime-validation step the typed union does NOT remove —
 * guest input crossing the postMessage/relay bridge is untrusted.
 */
class MalformedArgsError extends Error {
  readonly errno: ErrnoCode = 'EINVAL';
  constructor(message: string) {
    super(message);
    this.name = 'MalformedArgsError';
  }
}

/**
 * C2: a syscall handler. Receives the kernel-owned `pid`, the raw request (it
 * runs its own ONE boundary parse step over `req.args`), and any transferred
 * ports. Returns a {@link DispatchResult} (possibly a promise). The handler map
 * keyed by {@link SyscallName} makes the set exhaustive at compile time.
 */
type SyscallHandler = (
  pid: number,
  req: SyscallRequestLike,
  ports?: readonly MessagePort[],
) => DispatchResult | Promise<DispatchResult>;

/**
 * Sentinel passed to a parked `ipc/accept` waiter when its listener is torn down
 * (process death or `fs/close`). The accept path recognizes it and rejects with
 * ECONNABORTED instead of treating it as a delivered connection port.
 */
const LISTENER_CLOSED = Symbol('listener-closed');

/** A parked `ipc/accept` resolver: receives a delivered port or the closed sentinel. */
type AcceptWaiter = (p: MessagePort | typeof LISTENER_CLOSED) => void;

export interface SyscallRequestLike {
  id: number;
  call: string;
  args: Record<string, unknown>;
}

/**
 * Handler for `dom/mutate` syscalls. The kernel calls this with the originating
 * pid and the batch of mutation records. The handler is responsible for
 * forwarding them to the appropriate {@link RemoteDomHost} instance.
 * If not configured, `dom/mutate` returns ENOSYS.
 */
export type DomMutateHandler = (pid: number, mutations: DomMutation[]) => void;

/**
 * Result of the kernel creating a child for a `process/spawn` syscall.
 * `pipes` mirrors {@link SpawnResult.pipes}; `transfer` carries the GUEST-side
 * pipe ports the kernel minted for `action:'pipe'` fds, which the dispatcher
 * forwards to the parent in the response transfer list.
 */
export interface SpawnChildResult {
  pid: number;
  pipes?: Record<number, 'transferred'>;
  transfer?: Transferable[];
}

/**
 * Narrow callback the kernel hands the dispatcher so `process/spawn` can create
 * a child WITHOUT the dispatcher ever touching the raw {@link Kernel}. The
 * dispatcher has already done the in-kernel capability check and resolved the
 * command name to `code`; the kernel narrows caps, sets ppid, applies the fd
 * actions, spawns the guest, and returns the new pid (+ any pipe ports).
 *
 * SECURITY: this is the only spawn surface exposed to the dispatcher. It cannot
 * forge a parent pid (the dispatcher passes the kernel-owned `parentPid` it was
 * invoked with) and the kernel always NARROWS the child's caps from the parent.
 */
export type SpawnChild = (
  parentPid: number,
  code: string | URL,
  args: SpawnArgs,
  /**
   * Guest-supplied stdio ports keyed by child fd. The guest transfers these in
   * the `process/spawn` request (e.g. a pipe end it minted via `fs/pipe`) and
   * maps each to a child fd via the `portFds` arg. The kernel injects them as
   * the child's stdin (fd 0, read end) / stdout/stderr (fd 1/2, write ends),
   * enabling guest-orchestrated zero-hop pipelines.
   */
  injectedPorts: Map<number, MessagePort>,
) => Promise<SpawnChildResult>;

/** Narrow callback to await a child's exit (delegates to ProcessManager.wait). */
export type WaitChild = (pid: number) => Promise<WaitResult>;

/**
 * A2 (relay coproc): narrow callback the kernel hands the dispatcher so
 * `process/coproc` can start a coproc child WITHOUT touching the raw Kernel. The
 * dispatcher has already run the in-kernel `process` capability check, resolved
 * the command name to `code`, and ALLOCATED the two PARENT-facing relay fds
 * (`readfd` reads the child's stdout, `writefd` writes the child's stdin) so fd
 * allocation stays centralized in the dispatcher's per-pid namespace. The kernel
 * mints the bidirectional pipe pair, wires the child's stdin/stdout to the
 * kernel-held ends, and registers the parent ends under those fds. Returns the
 * real child pid. Like {@link SpawnChild} it cannot forge a parent pid and the
 * child's caps are narrowed from the parent.
 */
export type CoprocChild = (
  parentPid: number,
  code: string | URL,
  args: SpawnArgs,
  readfd: number,
  writefd: number,
) => Promise<{ pid: number }>;

/**
 * C2: relay byte-channel operations for non-transferable (relay) backends. On
 * such backends the guest cannot hold a MessagePort, so `fs/pipe`/`ipc/*` ports
 * are retained kernel-side and the guest drives them by fd via the first-class
 * `pipe/read`/`pipe/write`/`pipe/close` syscalls. The kernel injects these so
 * the dispatcher's handler map is exhaustive over the full {@link Syscall}
 * union — the relay ends themselves stay owned by the kernel. Unset = the three
 * calls return EBADF (no relay ends exist on a transfer-path backend).
 */
export interface RelayPipeHandlers {
  read(pid: number, fd: number, len?: number): Promise<RelayPipeResult>;
  write(pid: number, fd: number, data: Uint8Array | number[] | string): Promise<RelayPipeResult>;
  close(pid: number, fd: number): RelayPipeResult;
}

/** Result of a relay pipe op: a wire result value or an errno failure. */
export type RelayPipeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: ErrnoCode; message: string } };

/** One stage of a guest-requested pipeline (command name/path + argv + env). */
export interface PipelineStageSpec {
  path: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * D8: fd wiring for this stage. Only `fds[0]` on the FIRST stage is honored (a
   * `<` / `<<` / `<<<` redirect source — `open` a VFS file or feed `bytes`); the
   * kernel pipe-feeds it. Replaces the old inline `stdinData`.
   */
  fds?: Record<number, FdAction>;
}

/** Result of running a guest-requested pipeline: per-stage codes + last stdout. */
export interface PipelineChildResult {
  exitCodes: number[];
  /** Captured stdout bytes of the final stage. */
  lastStdout: Uint8Array;
}

/**
 * Narrow callback the kernel hands the dispatcher to run a multi-stage pipeline
 * with zero-hop inter-stage pipes, proper ppid wiring, per-stage capability
 * NARROWING from the parent, and command-name resolution. Captures the final
 * stage's stdout and returns it so the dispatcher can hand the bytes back to the
 * guest (which writes them to its own stdout). Like {@link SpawnChild}, this is
 * the only pipeline surface exposed — the dispatcher never touches the Kernel.
 */
export type PipelineChild = (
  parentPid: number,
  stages: Array<{ code: string | URL; spec: PipelineStageSpec }>,
) => Promise<PipelineChildResult>;

export interface SyscallDispatcherOptions {
  vfs: FileSystemProvider;
  caps: CapabilityManager;
  /** Resolve a process's current working directory. */
  cwdOf: (pid: number) => string;
  /**
   * K1: resolve a process's {@link ProcessLimits} (or undefined). The dispatcher
   * enforces the limits it can at the syscall boundary, independent of backend:
   *   - `networkDisabled` → `net/fetch` is denied (EACCES) for that pid even when
   *     it holds a matching `net` capability.
   *   - `maxChildren` → caps `process/spawn` + `process/pipeline` for that pid;
   *     the EFFECTIVE cap is the MIN of this and the `process` capability's
   *     `maxChildren`.
   * Unset = no limit-based gating (only capability gating applies).
   */
  limitsOf?: (pid: number) => ProcessLimits | undefined;
  /** IPC broker used to mint pipes for the `fs/pipe` syscall. Optional for fs-only setups. */
  ipc?: IpcBroker;
  /**
   * Whether the runtime backend can transfer MessagePorts into guest sandboxes.
   * Defaults to `true` (transferable backends, e.g. Worker/iframe).
   * Set to `false` for relay backends (e.g. QuickJS): `process/spawn` with any
   * `pipe` fd action is rejected up-front (ENOSYS) WITHOUT spawning the child,
   * avoiding an orphan that would result from creating the child first and then
   * failing in the relay postMessage path.
   */
  directPipes?: boolean;
  /**
   * Optional handler for `dom/mutate` syscalls from guest processes.
   * When set, the kernel forwards batched DomMutation records from the guest
   * to this handler which routes them to the appropriate RemoteDomHost.
   * When unset, `dom/mutate` returns ENOSYS.
   */
  onDomMutate?: DomMutateHandler;
  /**
   * Resolve a bare command NAME (e.g. `cat`) to spawnable guest code. Absolute
   * paths and URLs bypass the resolver (used directly). When the resolver
   * returns `undefined` for a bare name, `process/spawn` yields ENOENT.
   * Unset = no name resolution (only paths/URLs spawnable).
   */
  resolveCommand?: (name: string, cwd: string, env: Record<string, string>) => string | URL | undefined;
  /**
   * Kernel-provided spawn callback. When unset, `process/spawn` returns ENOSYS.
   * See {@link SpawnChild} — the dispatcher only ever calls this, never the Kernel.
   */
  spawnChild?: SpawnChild;
  /** Kernel-provided wait callback for `process/wait`. Unset = ENOSYS. */
  waitChild?: WaitChild;
  /**
   * A2 (relay coproc): kernel-provided callback for `process/coproc` (relay path).
   * Unset = ENOSYS. See {@link CoprocChild} — the dispatcher only ever calls this.
   */
  coprocChild?: CoprocChild;
  /** Kernel-provided multi-stage pipeline runner for `process/pipeline`. Unset = ENOSYS. */
  pipelineChild?: PipelineChild;
  /** Resolve a process's parent pid (for `process/getppid` and wait ownership). */
  ppidOf?: (pid: number) => number;
  /** Change a process's cwd (for `process/chdir`). Unset = ENOSYS. */
  chdir?: (pid: number, path: string) => void;
  /**
   * Trigger a process's exit (for the `process/exit` SYSCALL form). Routes to
   * the same teardown path the control-port `{type:'exit'}` lifecycle message
   * uses. Unset = the syscall is a no-op success (the guest's own exit path runs).
   */
  exitProcess?: (pid: number, code: number) => void;
  /**
   * D4: deliver a signal to a process (for the `process/kill` syscall). Routes to
   * `Kernel.kill`. The dispatcher gates delivery on OWNERSHIP — a process may
   * only signal its own children (ppid check) — so a guest cannot signal
   * arbitrary pids. Unset = `process/kill` returns ENOSYS.
   */
  killChild?: (pid: number, signal: string) => void;
  /**
   * HTTP client backing the capability-gated `net/fetch` syscall. The dispatcher
   * checks the caller's `net` capability for the request ORIGIN (via
   * `caps.checkNet`) BEFORE ever touching this client; a guest can never reach an
   * origin it lacks capability for. Injectable so tests pass a mock and hosts
   * default to `globalThis.fetch` (via `FetchHttpClient`). Unset = `net/fetch`
   * returns ENOSYS (network disabled).
   */
  httpClient?: HttpClient;
  /**
   * C2: kernel-provided relay byte-channel handlers for `pipe/read`/`pipe/write`/
   * `pipe/close`. Injected only by relay (non-transferable) backends. Unset = the
   * three calls return EBADF (a transfer-path guest holds real ports and never
   * uses them).
   */
  relayPipe?: RelayPipeHandlers;
  /**
   * R3: maximum bytes the BUFFERED-fallback `net/fetch` body delivery
   * (non-transferable / relay / QuickJS backends) will read into host memory
   * before aborting. An attacker-controlled large/infinite response would
   * otherwise OOM the host, since the fallback materializes the WHOLE body inline.
   * On exceeding the cap the source stream is cancelled and the syscall fails
   * with ENOSPC (a curl-mappable transport failure) rather than silently
   * truncating. The TRANSFERABLE streaming path is unaffected — it is already
   * bounded by credit back-pressure. Defaults to
   * {@link MAX_BUFFERED_BODY_BYTES} (64 MiB), matching the kernel's
   * `maxOutputBytes` default.
   */
  maxBufferedBodyBytes?: number;
}

/**
 * Result of dispatching a syscall: the wire {@link SyscallResponse} plus any
 * Transferable objects (e.g. the two MessagePorts of an `fs/pipe`) that the
 * control-plane transport must move into the guest's realm. The transport
 * inspects `transfer` and passes it to `postMessage` so ownership of the ports
 * is handed to the guest rather than copied.
 */
export interface DispatchResult {
  response: SyscallResponse;
  transfer?: Transferable[];
}

interface OpenFile {
  kind?: 'file';
  handle: FileHandle;
  offset: number;
}

/** A pipe end held in the fd table (the port is owned by the guest after transfer). */
interface PipeFd {
  kind: 'pipe';
  port: MessagePort;
}

/** A listener fd created by ipc/listen; closed via fs/close which unbinds the path. */
interface ListenerFd {
  kind: 'listener';
  path: string;
}

type FdEntry = OpenFile | PipeFd | ListenerFd;

/**
 * Routes filesystem syscalls (`fs/*`) through capability checks to the VFS
 * router. Maintains a per-process kernel-side fd table for open files and maps
 * `FileSystemError` codes to POSIX errno. Unknown calls yield ENOSYS.
 *
 * Pipe/stream fds are NOT handled here — those are wired as direct ports.
 */
export class SyscallDispatcher {
  #vfs: FileSystemProvider;
  #caps: CapabilityManager;
  #cwdOf: (pid: number) => string;
  #limitsOf: ((pid: number) => ProcessLimits | undefined) | undefined;
  #ipc: IpcBroker | undefined;
  #directPipes: boolean;
  #onDomMutate: DomMutateHandler | undefined;
  #resolveCommand: SyscallDispatcherOptions['resolveCommand'];
  #spawnChild: SpawnChild | undefined;
  #coprocChild: CoprocChild | undefined;
  #waitChild: WaitChild | undefined;
  #pipelineChild: PipelineChild | undefined;
  #ppidOf: ((pid: number) => number) | undefined;
  #chdir: ((pid: number, path: string) => void) | undefined;
  #exitProcess: ((pid: number, code: number) => void) | undefined;
  #killChild: ((pid: number, signal: string) => void) | undefined;
  #httpClient: HttpClient | undefined;
  #relayPipe: RelayPipeHandlers | undefined;
  #maxBufferedBodyBytes: number;
  /** pid -> (fd -> open file or pipe end). */
  #fdTables = new Map<number, Map<number, FdEntry>>();
  /** pid -> next fd to allocate (file fds start above the reserved stdio range). */
  #nextFd = new Map<number, number>();
  /**
   * Listener fd -> pending connection queue.
   * `ports`: remote ports already connected but not yet accepted.
   * `waiters`: ipc/accept calls blocked waiting for the next connection.
   */
  #pendingConns = new Map<number, { ports: MessagePort[]; waiters: AcceptWaiter[] }>();

  constructor(options: SyscallDispatcherOptions) {
    this.#vfs = options.vfs;
    this.#caps = options.caps;
    this.#cwdOf = options.cwdOf;
    this.#limitsOf = options.limitsOf;
    this.#ipc = options.ipc;
    this.#directPipes = options.directPipes ?? true;
    this.#onDomMutate = options.onDomMutate;
    this.#resolveCommand = options.resolveCommand;
    this.#spawnChild = options.spawnChild;
    this.#coprocChild = options.coprocChild;
    this.#waitChild = options.waitChild;
    this.#pipelineChild = options.pipelineChild;
    this.#ppidOf = options.ppidOf;
    this.#chdir = options.chdir;
    this.#exitProcess = options.exitProcess;
    this.#killChild = options.killChild;
    this.#httpClient = options.httpClient;
    this.#relayPipe = options.relayPipe;
    this.#maxBufferedBodyBytes = options.maxBufferedBodyBytes ?? MAX_BUFFERED_BODY_BYTES;
  }

  /** Discard a process's fd table (called on process exit). */
  closeProcess(pid: number): void {
    const table = this.#fdTables.get(pid);
    if (table) {
      // Sweep every listener fd: close queued-but-unaccepted ports (else they
      // leak) and reject any parked ipc/accept waiters (else they hang forever).
      for (const [fd, entry] of table) {
        if (entry.kind === 'listener') this.#teardownListener(fd);
      }
    }
    this.#fdTables.delete(pid);
    this.#nextFd.delete(pid);
    this.#liveChildPids.delete(pid);
    // Fix 1: When a child self-exits (without the parent calling process/wait),
    // remove it from the parent's live-child set so maxChildren accounting stays
    // accurate. Without this, a parent's liveChildPids set only shrinks via
    // process/wait — children that exit on their own permanently consume a slot
    // and the parent gets locked out after N total spawns even with zero live kids.
    const parentPid = this.#ppidOf?.(pid);
    if (parentPid !== undefined) {
      this.#liveChildPids.get(parentPid)?.delete(pid);
    }
  }

  /**
   * Tear down a listener fd's pending-connection state: close all queued ports
   * and settle all parked accept waiters. Used by both `closeProcess` (process
   * death) and `#close` (explicit `fs/close` on a listener fd) so neither path
   * leaks unaccepted ports or strands an awaiting `ipc/accept`.
   */
  #teardownListener(fd: number): void {
    const queue = this.#pendingConns.get(fd);
    if (!queue) return;
    for (const port of queue.ports) {
      try { port.close(); } catch { /* already neutered */ }
    }
    queue.ports.length = 0;
    // Reject parked accept waiters so the awaiting guest call settles instead of
    // hanging. The accept resolver expects a MessagePort; signal abort via a
    // rejecting sentinel the accept path recognizes.
    for (const waiter of queue.waiters) {
      waiter(LISTENER_CLOSED);
    }
    queue.waiters.length = 0;
    this.#pendingConns.delete(fd);
  }

  /**
   * C2: the syscall handler map — ONE entry per {@link Syscall} union member,
   * keyed by call name. The `satisfies Record<SyscallName, Handler>` makes
   * exhaustiveness COMPILER-CHECKED: adding a `Syscall` member without a handler
   * here (or vice versa) is a build error, replacing the old stringly-typed
   * `switch`. Each handler does ONE parse step at the trust boundary (guest input
   * crossing the postMessage/relay bridge is untrusted) via the `parse*` helpers,
   * then runs the operation. Capability checks live inside the handlers / VFS as
   * before — the typed args are a maintainability win, not a security one.
   */
  #handlers: Record<SyscallName, SyscallHandler> = {
    'fs/open': async (pid, a) => res(ok(a.id, await this.#open(pid, parseFsOpen(a.args)))),
    'fs/read': async (pid, a) => res(ok(a.id, await this.#read(pid, parseFsRead(a.args)))),
    'fs/write': async (pid, a) => res(ok(a.id, await this.#write(pid, parseFsWrite(a.args)))),
    'fs/close': (pid, a) => res(ok(a.id, this.#close(pid, parseFd(a.args)))),
    'fs/stat': async (pid, a) => res(ok(a.id, await this.#stat(pid, parseFsStat(a.args)))),
    'fs/readdir': async (pid, a) => res(ok(a.id, await this.#readdir(pid, parseFsPath(a.args)))),
    'fs/mkdir': async (pid, a) => res(ok(a.id, await this.#mkdir(pid, parseFsPath(a.args)))),
    'fs/unlink': async (pid, a) => res(ok(a.id, await this.#unlink(pid, parseFsPath(a.args)))),
    'fs/rmdir': async (pid, a) => res(ok(a.id, await this.#rmdir(pid, parseFsPath(a.args)))),
    'fs/rename': async (pid, a) => res(ok(a.id, await this.#rename(pid, parseFsRename(a.args)))),
    'fs/symlink': async (pid, a) => res(ok(a.id, await this.#symlink(pid, parseFsLinkTarget(a.args)))),
    'fs/readlink': async (pid, a) => res(ok(a.id, await this.#readlink(pid, parseFsPath(a.args)))),
    'fs/link': async (pid, a) => res(ok(a.id, await this.#link(pid, parseFsLinkTarget(a.args)))),
    'fs/chmod': async (pid, a) => res(ok(a.id, await this.#chmod(pid, parseFsChmod(a.args)))),
    'fs/utimes': async (pid, a) => res(ok(a.id, await this.#utimes(pid, parseFsUtimes(a.args)))),
    'fs/realpath': async (pid, a) => res(ok(a.id, await this.#realpath(pid, parseFsPath(a.args)))),
    'fs/getxattr': async (pid, a) => res(ok(a.id, await this.#getxattr(pid, parseFsXattrName(a.args)))),
    'fs/setxattr': async (pid, a) => res(ok(a.id, await this.#setxattr(pid, parseFsSetxattr(a.args)))),
    'fs/listxattr': async (pid, a) => res(ok(a.id, await this.#listxattr(pid, parseFsPath(a.args)))),
    'fs/removexattr': async (pid, a) => res(ok(a.id, await this.#removexattr(pid, parseFsXattrName(a.args)))),
    'fs/pipe': (pid, a) => this.#pipe(pid, a.id),
    'ipc/listen': (pid, a) => this.#ipcListen(pid, a.id, parseIpcPath(a.args)),
    'ipc/accept': (pid, a) => this.#ipcAccept(pid, a.id, parseFd(a.args)),
    'ipc/connect': (pid, a) => this.#ipcConnect(pid, a.id, parseIpcPath(a.args)),
    'dom/mutate': (pid, a) => res(ok(a.id, this.#domMutate(pid, parseDomMutate(a.args)))),
    'net/fetch': (pid, a) => this.#netFetch(pid, a.id, parseNetFetch(a.args)),
    'process/spawn': (pid, a, ports) => this.#spawn(pid, a.id, parseSpawn(a.args), ports),
    'process/coproc': async (pid, a) => res(await this.#coproc(pid, a.id, parseCoproc(a.args))),
    'process/pipeline': async (pid, a) => res(await this.#pipeline(pid, a.id, a.args)),
    'process/wait': async (pid, a) => res(ok(a.id, await this.#wait(pid, parseWait(a.args)))),
    'process/kill': (pid, a) => res(this.#kill(pid, a.id, parseKill(a.args))),
    'process/exit': (pid, a) => res(ok(a.id, this.#processExit(pid, parseExit(a.args)))),
    'process/getpid': (pid, a) => res(ok(a.id, { pid })),
    'process/getppid': (pid, a) => res(ok(a.id, { ppid: this.#ppidOf?.(pid) ?? 0 })),
    'process/getcwd': (pid, a) => res(ok(a.id, { cwd: this.#cwdOf(pid) })),
    'process/chdir': (pid, a) => res(ok(a.id, this.#chdirCall(pid, parseChdir(a.args)))),
    'pipe/read': (pid, a) => this.#pipeRead(pid, a.id, parsePipeRead(a.args)),
    'pipe/write': (pid, a) => this.#pipeWrite(pid, a.id, parsePipeWrite(a.args)),
    'pipe/close': (pid, a) => this.#pipeClose(pid, a.id, parseFd(a.args)),
  } satisfies Record<SyscallName, SyscallHandler>;

  async dispatch(
    pid: number,
    req: SyscallRequestLike,
    ports?: readonly MessagePort[],
  ): Promise<DispatchResult> {
    // Unknown call: ENOSYS (and close any ports a spawn-shaped call would have
    // carried, so they don't leak). Looking the name up against the typed
    // registry FIRST keeps the trust-boundary contract explicit.
    if (!isSyscallName(req.call)) {
      this.#closePorts(ports);
      return res(fail(req.id, 'ENOSYS', `Unknown syscall: ${req.call}`));
    }
    try {
      return await this.#handlers[req.call](pid, req, ports);
    } catch (err) {
      // A parse failure at the boundary surfaces as EINVAL; anything else maps
      // through the structured-error → errno table. Either way the dispatcher
      // returns a wire response rather than crashing the kernel.
      if (ports && (req.call === 'process/spawn')) this.#closePorts(ports);
      return res(fail(req.id, errnoOf(err), messageOf(err)));
    }
  }

  /**
   * `fs/pipe`: mint a fresh MessageChannel pipe and hand BOTH ends to the guest,
   * registering them in the guest's kernel-side fd table as pipe fds.
   *   - `readfd`  → the read end (`readPort`); guest reads from it.
   *   - `writefd` → the write end (`writePort`); guest writes to it.
   * The two ports are returned in the {@link DispatchResult.transfer} list so the
   * control transport moves (not copies) them into the guest's realm. The guest
   * wraps `readPort` with `portToReadable` and `writePort` with `portToWritable`.
   */
  #pipe(pid: number, id: number): DispatchResult {
    if (!this.#ipc) {
      return res(fail(id, 'ENOSYS', 'fs/pipe unavailable: no IPC broker configured'));
    }
    const { readPort, writePort } = this.#ipc.createPipe();
    const readfd = this.#allocFd(pid);
    const writefd = this.#allocFd(pid);
    const table = this.#tableFor(pid);
    table.set(readfd, { kind: 'pipe', port: readPort });
    table.set(writefd, { kind: 'pipe', port: writePort });
    return {
      response: ok(id, { readfd, writefd }),
      transfer: [readPort, writePort],
    };
  }

  /**
   * `process/spawn {path, argv, env?, cwd?, fds?}`: create a child process.
   *
   * Capability-gated IN-KERNEL: the caller must hold a `process` capability
   * (honoring `maxChildren` against its live child count). The command NAME is
   * resolved to spawnable guest code: absolute paths (`/…`) and URLs are used
   * directly; bare names go through the injected `resolveCommand`. An unresolved
   * name yields ENOENT. Actual child creation is delegated to the kernel's
   * narrow {@link SpawnChild} callback — the dispatcher never touches the Kernel.
   */
  async #spawn(
    pid: number,
    id: number,
    spawnArgs: SpawnArgs & { portFds?: number[] },
    ports?: readonly MessagePort[],
  ): Promise<DispatchResult> {
    if (!this.#spawnChild) {
      this.#closePorts(ports);
      return res(fail(id, 'ENOSYS', 'process/spawn: no spawn handler configured'));
    }
    const childCount = this.#liveChildPids.get(pid)?.size ?? 0;
    // K1: gate on the process CAPABILITY and the effective maxChildren (MIN of the
    // cap's maxChildren and ProcessLimits.maxChildren). Spawning one more child
    // must keep the live count within the cap.
    if (!this.#caps.checkProcess(pid, childCount) || !this.#withinChildLimit(pid, childCount + 1)) {
      this.#closePorts(ports);
      return res(fail(id, 'EPERM', 'process/spawn: missing process capability or child limit reached'));
    }
    const cwd = spawnArgs.cwd ?? this.#cwdOf(pid);
    const env = spawnArgs.env ?? {};
    const code = await this.#resolveCode(spawnArgs.path, spawnArgs.argv, cwd, env);
    if (code === undefined) {
      this.#closePorts(ports);
      return res(fail(id, 'ENOENT', `command not found: ${spawnArgs.path}`));
    }
    // Fix 2: Reject pipe-fd spawns on relay (non-transferable) backends BEFORE
    // creating the child. On relay backends the kernel cannot transfer
    // MessagePorts back to the parent, so a 'pipe' fd action cannot be fulfilled.
    // Failing here (before #spawnChild) prevents an orphan child from being
    // created only to have the relay path close the ports and return ENOSYS anyway.
    if (!this.#directPipes && spawnArgs.fds) {
      const hasPipeFd = Object.values(spawnArgs.fds).some(
        (a) => (a as { action?: string }).action === 'pipe',
      );
      if (hasPipeFd) {
        this.#closePorts(ports);
        return res(fail(id, 'ENOSYS', 'process/spawn: pipe fd actions require a transferable runtime backend'));
      }
    }
    // Map transferred ports to child fds. `portFds[i]` is the child fd for
    // `ports[i]` (positional). Used by the guest to inject pipe ends it minted.
    const injectedPorts = new Map<number, MessagePort>();
    const portFds = spawnArgs.portFds ?? [];
    if (ports) {
      for (let i = 0; i < ports.length; i++) {
        const fd = portFds[i];
        if (typeof fd === 'number') injectedPorts.set(fd, ports[i]);
      }
    }
    const child = await this.#spawnChild(pid, code, spawnArgs, injectedPorts);
    // Track the child so future maxChildren checks see the live count.
    const liveSet = this.#liveChildPids.get(pid);
    if (liveSet) liveSet.add(child.pid);
    else this.#liveChildPids.set(pid, new Set([child.pid]));
    const response = ok(id, child.pipes ? { pid: child.pid, pipes: child.pipes } : { pid: child.pid });
    return child.transfer && child.transfer.length > 0
      ? { response, transfer: child.transfer }
      : { response };
  }

  /**
   * A2 (relay coproc): `process/coproc {path, argv, env?, cwd?}` — start a coproc
   * child on the RELAY path. Capability-gated identically to `process/spawn` (the
   * caller needs a `process` capability within its child limit) and the command
   * NAME is resolved to guest code the same way. The kernel mints a bidirectional
   * pipe pair, wires the child's stdin/stdout to the kernel-held ends, and
   * registers two PARENT-facing relay fds; the parent drives them by fd via
   * `pipe/read`/`pipe/write`/`pipe/close`. No ports cross into either guest.
   *
   * ENOSYS when no coproc handler is configured (a transfer-path backend: the
   * shell uses the port-injecting `process/spawn` path there, not this syscall).
   */
  async #coproc(pid: number, id: number, spawnArgs: SpawnArgs): Promise<SyscallResponse> {
    if (!this.#coprocChild) {
      return fail(id, 'ENOSYS', 'process/coproc: not supported on this backend');
    }
    const childCount = this.#liveChildPids.get(pid)?.size ?? 0;
    if (!this.#caps.checkProcess(pid, childCount) || !this.#withinChildLimit(pid, childCount + 1)) {
      return fail(id, 'EPERM', 'process/coproc: missing process capability or child limit reached');
    }
    const cwd = spawnArgs.cwd ?? this.#cwdOf(pid);
    const env = spawnArgs.env ?? {};
    const code = await this.#resolveCode(spawnArgs.path, spawnArgs.argv, cwd, env);
    if (code === undefined) {
      return fail(id, 'ENOENT', `command not found: ${spawnArgs.path}`);
    }
    // Allocate the parent-facing relay fds in the caller's per-pid fd namespace
    // (shared with fs/pipe / ipc), so the relay bridge's fd keys never collide.
    const readfd = this.#allocFd(pid);
    const writefd = this.#allocFd(pid);
    const child = await this.#coprocChild(pid, code, spawnArgs, readfd, writefd);
    const liveSet = this.#liveChildPids.get(pid);
    if (liveSet) liveSet.add(child.pid);
    else this.#liveChildPids.set(pid, new Set([child.pid]));
    return ok(id, { pid: child.pid, readfd, writefd });
  }

  /**
   * Resolve a command spec to spawnable guest code. Absolute paths and URLs are
   * used directly (a `string` URL becomes a `URL`). A bare name resolves first via
   * a `$PATH` walk to a VFS executable FILE (RFC 0001 §4.2 — this REPLACES the
   * per-command map) and, on a miss, falls back to the injected `resolveCommand`
   * (host/special + registry-only commands like the bundled coreutils + bootstrap).
   *
   * `$PATH`→VFS-file MUST win over `resolveCommand` for bare names: a `/usr/bin`
   * utility whose name ALSO appears in the registry (e.g. an installed Lab
   * `imgresize`/`copy`) must resolve to its FILE so `kernel.spawn` reads its
   * `security.capability` xattr and the child runs with its manifest-narrowed
   * grant — not to the in-process registry sentinel, which would silently run it
   * with the parent's broad caps (D7/§4.8). The resolved VFS path is re-validated
   * (execute bit, shebang, xattr caps) by `kernel.spawn` before launch. With no
   * `$PATH` hit this is identical to the old registry-first behavior. Returns
   * `undefined` when neither layer matches.
   */
  async #resolveCode(path: string, argv: string[], cwd: string, env: Record<string, string>): Promise<string | URL | undefined> {
    if (path.includes('://')) return new URL(path);
    if (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) return path;
    const name = path || argv[0] || '';
    const fromPath = await this.#resolvePathFile(name, env);
    if (fromPath !== undefined) return fromPath;
    return this.#resolveCommand?.(name, cwd, env);
  }

  /** Walk `$PATH` for a VFS file matching a bare command NAME (RFC 0001 §4.2). */
  async #resolvePathFile(name: string, env: Record<string, string>): Promise<string | undefined> {
    if (name === '') return undefined;
    for (const dir of (env.PATH ?? '').split(':')) {
      if (dir === '') continue;
      const candidate = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
      try {
        await this.#vfs.stat(candidate);
        return candidate;
      } catch (err) {
        if (err instanceof FileSystemError && err.code === 'no-entry') continue;
        throw err;
      }
    }
    return undefined;
  }

  /**
   * `process/pipeline {stages}`: run a multi-stage pipeline of external commands
   * with zero-hop inter-stage pipes. Capability-gated identically to
   * `process/spawn` (the caller needs a `process` cap). Each stage's command name
   * is resolved to guest code; an unresolved name yields ENOENT. The final
   * stage's stdout is captured and returned as `stdout` bytes so the calling
   * guest (the shell) can write it to its own stdout. Per-stage caps are NARROWED
   * from the parent inside the kernel's pipeline runner.
   */
  async #pipeline(pid: number, id: number, args: Record<string, unknown>): Promise<SyscallResponse> {
    if (!this.#pipelineChild) {
      return fail(id, 'ENOSYS', 'process/pipeline: no pipeline handler configured');
    }
    const rawStages = Array.isArray(args.stages) ? args.stages : undefined;
    if (!rawStages || rawStages.length === 0) {
      return fail(id, 'EINVAL', 'process/pipeline: stages must be a non-empty array');
    }
    // Fix 3: enforce maxChildren for process/pipeline. A pipeline with N stages
    // transiently spawns N children. Check that the current live-child count plus
    // the stage count does not exceed the parent's maxChildren cap. This prevents
    // a guest from bypassing the process cap by routing spawns through pipeline.
    const currentChildren = this.#liveChildPids.get(pid)?.size ?? 0;
    // K1: a pipeline of N stages transiently spawns N children. Gate on the
    // process capability AND the effective maxChildren (MIN of cap + limit) so a
    // guest cannot bypass the cap by routing spawns through pipeline.
    if (
      !this.#caps.checkProcess(pid, currentChildren + rawStages.length - 1)
      || !this.#withinChildLimit(pid, currentChildren + rawStages.length)
    ) {
      return fail(id, 'EPERM', 'process/pipeline: missing process capability or child limit reached');
    }
    const resolved: Array<{ code: string | URL; spec: PipelineStageSpec }> = [];
    for (const raw of rawStages) {
      const r = raw as Record<string, unknown>;
      const path = typeof r.path === 'string' ? r.path : '';
      const argv = Array.isArray(r.argv) ? r.argv.map(String) : [];
      const env = (r.env && typeof r.env === 'object' ? r.env : {}) as Record<string, string>;
      const cwd = typeof r.cwd === 'string' ? r.cwd : this.#cwdOf(pid);
      const code = await this.#resolveCode(path, argv, cwd, env);
      if (code === undefined) {
        return fail(id, 'ENOENT', `command not found: ${path}`);
      }
      // D8: an fd-0 stdin source (a `<` open / `<<`/`<<<` bytes). Validate a
      // `bytes` action's data at the boundary (EINVAL) before it reaches the pump.
      let fds: Record<number, FdAction> | undefined;
      if (r.fds !== undefined) {
        if (typeof r.fds !== 'object' || r.fds === null) {
          return fail(id, 'EINVAL', 'process/pipeline: fds must be an object keyed by fd');
        }
        for (const action of Object.values(r.fds as Record<number, unknown>)) {
          if ((action as { action?: string })?.action === 'bytes'
            && !((action as { data?: unknown }).data instanceof Uint8Array)) {
            return fail(id, 'EINVAL', 'process/pipeline: bytes fd action data must be a Uint8Array');
          }
        }
        fds = r.fds as Record<number, FdAction>;
      }
      resolved.push({ code, spec: { path, argv, env, cwd, fds } });
    }
    const result = await this.#pipelineChild(pid, resolved);
    return ok(id, { exitCodes: result.exitCodes, stdout: result.lastStdout });
  }

  /**
   * `process/wait {pid}`: await a child's exit. Ownership-gated — a process may
   * only wait its own children (ppid check). Waiting a non-child / unknown pid
   * returns the no-child sentinel (ECHILD-style) rather than hanging.
   */
  async #wait(pid: number, args: SyscallArgs<'process/wait'>): Promise<WaitResult> {
    const target = args.pid;
    if (!this.#waitChild) {
      return { pid: target, status: 'no-child', code: -1 };
    }
    // Ownership: only wait a child whose ppid is this process. If we can't
    // determine parentage, fall through to waitChild (ProcessManager handles
    // unknown pids with the no-child sentinel — never hangs).
    if (this.#ppidOf && this.#ppidOf(target) !== pid) {
      return { pid: target, status: 'no-child', code: -1 };
    }
    const result = await this.#waitChild(target);
    this.#liveChildPids.get(pid)?.delete(target);
    return result;
  }

  /**
   * D4: `process/kill {pid, signal?}` — deliver a signal to one of the caller's
   * children. Ownership-gated: only a child whose ppid is this process may be
   * signalled (a guest cannot signal arbitrary pids). Unknown handler ⇒ ENOSYS;
   * a non-child target ⇒ EPERM. `signal` defaults to SIGTERM.
   */
  #kill(pid: number, id: number, args: SyscallArgs<'process/kill'>): SyscallResponse {
    if (!this.#killChild) {
      return fail(id, 'ENOSYS', 'process/kill: no kill handler configured');
    }
    const target = args.pid;
    // Ownership: only signal own children. If parentage is unknown, deny.
    if (!this.#ppidOf || this.#ppidOf(target) !== pid) {
      return fail(id, 'EPERM', `process/kill: not permitted to signal pid ${target}`);
    }
    const signal = args.signal && /^SIG/.test(args.signal) ? args.signal : 'SIG' + (args.signal ?? 'TERM');
    this.#killChild(target, signal);
    this.#liveChildPids.get(pid)?.delete(target);
    return ok(id, {});
  }

  /**
   * `process/exit {code}` as a SYSCALL. Routes to the kernel's exit teardown so
   * a guest that calls `mithic.syscall('process/exit', {code})` exits identically
   * to one that posts the `{type:'exit'}` lifecycle message. When no
   * `exitProcess` handler is wired, this is a harmless success (the guest's own
   * `guest.exit()` control-port path still drives teardown).
   */
  #processExit(pid: number, args: SyscallArgs<'process/exit'>): Record<string, never> {
    const code = args.code ?? 0;
    this.#exitProcess?.(pid, code);
    return {};
  }

  #chdirCall(pid: number, args: SyscallArgs<'process/chdir'>): { cwd: string } {
    if (!this.#chdir) {
      throw new FileSystemError('unsupported', 'process/chdir: no chdir handler configured');
    }
    const path = normalizePath(args.path);
    this.#chdir(pid, path);
    return { cwd: path };
  }

  /**
   * C2: `pipe/read {fd, len?}` — first-class relay byte-channel read. On relay
   * (non-transferable) backends the kernel-held pipe end is driven by fd via the
   * injected {@link RelayPipeHandlers}. Unset handler = EBADF (a transfer-path
   * guest holds real ports and never reaches here).
   */
  async #pipeRead(pid: number, id: number, args: SyscallArgs<'pipe/read'>): Promise<DispatchResult> {
    if (!this.#relayPipe) return res(fail(id, 'EBADF', `pipe/read: bad fd ${args.fd}`));
    return res(relayToResponse(id, await this.#relayPipe.read(pid, args.fd, args.len)));
  }

  /** C2: `pipe/write {fd, data}` — first-class relay byte-channel write. */
  async #pipeWrite(pid: number, id: number, args: SyscallArgs<'pipe/write'>): Promise<DispatchResult> {
    if (!this.#relayPipe) return res(fail(id, 'EBADF', `pipe/write: bad fd ${args.fd}`));
    return res(relayToResponse(id, await this.#relayPipe.write(pid, args.fd, args.data)));
  }

  /** C2: `pipe/close {fd}` — first-class relay byte-channel close. */
  #pipeClose(pid: number, id: number, args: SyscallArgs<'pipe/close'>): DispatchResult {
    if (!this.#relayPipe) return res(fail(id, 'EBADF', `pipe/close: bad fd ${args.fd}`));
    return res(relayToResponse(id, this.#relayPipe.close(pid, args.fd)));
  }

  /** pid -> set of its live (spawned, not-yet-waited) child pids. */
  #liveChildPids = new Map<number, Set<number>>();

  /**
   * K1: true if a process with `prospectiveCount` live children would stay within
   * its `ProcessLimits.maxChildren` cap. (The `process` capability's own
   * `maxChildren` is enforced separately by `checkProcess`; the effective cap is
   * the MIN of the two.) Unset limit = no limit-based cap (capability still applies).
   */
  #withinChildLimit(pid: number, prospectiveCount: number): boolean {
    const max = this.#limitsOf?.(pid)?.maxChildren;
    if (max === undefined) return true;
    return prospectiveCount <= max;
  }

  /** Close any ports a rejected `process/spawn` received, so none leak. */
  #closePorts(ports?: readonly MessagePort[]): void {
    if (!ports) return;
    for (const p of ports) { try { p.close(); } catch { /* already neutered */ } }
  }

  /**
   * `ipc/listen {path}`: bind a named channel to this process.
   *
   * Capability-gated: the process must hold an ipc cap listing `path`.
   * Returns `{fd}` — a listener fd. `fs/close` on it unbinds the path.
   */
  #ipcListen(pid: number, id: number, args: SyscallArgs<'ipc/listen'>): DispatchResult {
    if (!this.#ipc) {
      return res(fail(id, 'ENOSYS', 'ipc/listen unavailable: no IPC broker configured'));
    }
    const path = args.path;
    if (!this.#caps.checkIpc(pid, path)) {
      return res(fail(id, 'EACCES', `Permission denied: ${path}`));
    }
    this.#ipc.bind(path, pid);
    const fd = this.#allocFd(pid);
    this.#tableFor(pid).set(fd, { kind: 'listener', path });
    this.#pendingConns.set(fd, { ports: [], waiters: [] });
    return res(ok(id, { fd }));
  }

  /**
   * `ipc/accept {fd}`: wait for the next connection on a listener fd.
   *
   * If a connection is already queued (a `connect` arrived before `accept`),
   * it is dequeued immediately. Otherwise the call suspends until a peer
   * calls `ipc/connect`. Returns `{connfd}` with the connection MessagePort
   * transferred to the guest.
   */
  async #ipcAccept(pid: number, id: number, args: SyscallArgs<'ipc/accept'>): Promise<DispatchResult> {
    const fd = args.fd;
    const entry = this.#tableFor(pid).get(fd);
    if (!entry || entry.kind !== 'listener') {
      return res(fail(id, 'EBADF', `Bad file descriptor: ${fd}`));
    }
    const queue = this.#pendingConns.get(fd);
    if (!queue) {
      return res(fail(id, 'EBADF', `Bad file descriptor: ${fd}`));
    }
    const port = await (
      queue.ports.length > 0
        ? Promise.resolve<MessagePort | typeof LISTENER_CLOSED>(queue.ports.shift()!)
        : new Promise<MessagePort | typeof LISTENER_CLOSED>((resolve) => { queue.waiters.push(resolve); })
    );
    // The listener was torn down (process death / fs/close) while we were parked.
    // EBADF (connection aborted): the listener fd is gone, so the accept cannot
    // complete — reject rather than hang.
    if (port === LISTENER_CLOSED) {
      return res(fail(id, 'EBADF', `Listener closed: fd ${fd}`));
    }
    const connfd = this.#allocFd(pid);
    this.#tableFor(pid).set(connfd, { kind: 'pipe', port });
    return { response: ok(id, { connfd }), transfer: [port] };
  }

  /**
   * `ipc/connect {path}`: open a connection to a named channel listener.
   *
   * Capability-gated: the process must hold an ipc cap for `path`.
   * If no listener is bound, returns ENOENT.
   * Creates a MessageChannel; transfers port1 to the connecting process and
   * queues port2 for the listener's next `ipc/accept`.
   * Returns `{connfd}` with port1 transferred to the guest.
   */
  #ipcConnect(pid: number, id: number, args: SyscallArgs<'ipc/connect'>): DispatchResult {
    if (!this.#ipc) {
      return res(fail(id, 'ENOSYS', 'ipc/connect unavailable: no IPC broker configured'));
    }
    const path = args.path;
    if (!this.#caps.checkIpc(pid, path)) {
      return res(fail(id, 'EACCES', `Permission denied: ${path}`));
    }
    const listenerPid = this.#ipc.resolveListener(path);
    if (listenerPid === undefined) {
      return res(fail(id, 'ENOENT', `No listener on path: ${path}`));
    }
    const channel = new MessageChannel();
    // port1 → connecting process (transferred to guest)
    // port2 → queued for the listener's accept
    const connfd = this.#allocFd(pid);
    this.#tableFor(pid).set(connfd, { kind: 'pipe', port: channel.port1 });
    if (!this.#deliverToListener(listenerPid, path, channel.port2)) {
      // The path resolved to a listener pid, but that process no longer has a
      // listener fd bound to THIS path (stale binding / race). Treat as ENOENT
      // and discard the now-orphaned ports so neither end leaks.
      this.#tableFor(pid).delete(connfd);
      channel.port1.close();
      channel.port2.close();
      return res(fail(id, 'ENOENT', `No listener on path: ${path}`));
    }
    return { response: ok(id, { connfd }), transfer: [channel.port1] };
  }

  /**
   * Deliver `port` to the listener fd of `listenerPid` that is bound to `path`.
   * Matching on path (not "first listener fd") ensures a process listening on
   * multiple paths routes each connection to the correct accept queue.
   * Resolves a waiting `ipc/accept` if one is parked, else queues the port.
   * Returns true if delivered, false if no listener fd for `path` was found.
   */
  #deliverToListener(listenerPid: number, path: string, port: MessagePort): boolean {
    const table = this.#fdTables.get(listenerPid);
    if (!table) return false;
    for (const [fd, entry] of table) {
      if (entry.kind !== 'listener' || entry.path !== path) continue;
      const queue = this.#pendingConns.get(fd);
      if (!queue) continue;
      if (queue.waiters.length > 0) {
        queue.waiters.shift()!(port);
      } else {
        queue.ports.push(port);
      }
      return true;
    }
    return false;
  }

  #resolvePath(pid: number, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    // Relative path: resolve against the process cwd. (dirfd-relative resolution
    // is not yet modeled; AT_FDCWD was the only value, equivalent to cwd.)
    const cwd = this.#cwdOf(pid) || '/';
    return normalizePath(cwd.endsWith('/') ? cwd + path : cwd + '/' + path);
  }

  /**
   * SEC-2: capability check for an operation that FOLLOWS symlinks (open/read/
   * stat/readdir/mkdir/unlink/.../realpath). `checkFs` only normalizes lexically
   * (`..`/`.`), so a symlink planted INSIDE a granted prefix that points OUTSIDE
   * it would pass the lexical check while the provider follows it past the
   * boundary — an escape. We canonicalize the path through the VFS `realpath`
   * (which resolves symlinks, bounded against cycles) and check the capability
   * against the CANONICAL path.
   *
   * If the leaf does not exist yet (a create, or a parent-only operation),
   * `realpath` of the full path fails; we fall back to canonicalizing the parent
   * directory and re-appending the lexical basename, so legitimate creates inside
   * a grant are unaffected. If even the parent cannot be canonicalized, we fall
   * back to the lexical path (the existing `..`/`.` protection still applies) —
   * there is no symlink to escape through in that case.
   *
   * Returns the path that passed (canonical when available) or throws
   * FileSystemError('access') when the capability check fails. The returned path
   * is what the VFS operation should run against to avoid a TOCTOU re-resolution.
   */
  async #canonicalCheckedPath(pid: number, lexicalPath: string, op: FsOperation): Promise<string> {
    const canonical = await this.#canonicalize(lexicalPath);
    if (!this.#caps.checkFs(pid, canonical, op)) {
      throw new FileSystemError('access', `Permission denied: ${canonical}`);
    }
    return canonical;
  }

  /**
   * Resolve `lexicalPath` to its canonical (symlink-free) form via the VFS
   * `realpath`. Falls back to canonicalizing the parent dir + lexical basename
   * when the leaf is missing, then to the lexical path. A symlink cycle (the VFS
   * realpath throws 'loop'/ELOOP) propagates so the operation fails cleanly
   * rather than the capability check silently passing. When the provider has no
   * `realpath`, the lexical path is used (the lexical `..` protection still
   * applies; without realpath there is no symlink resolution to exploit here).
   */
  async #canonicalize(lexicalPath: string): Promise<string> {
    if (!this.#vfs.realpath) return lexicalPath;
    try {
      return await this.#vfs.realpath(lexicalPath);
    } catch (err) {
      // A symlink cycle must NOT be swallowed — propagate so the op fails (ELOOP)
      // instead of falling through to a lexical check that could pass.
      if (err instanceof FileSystemError && err.code === 'loop') throw err;
      // Leaf missing (e.g. create): canonicalize the PARENT dir and re-attach the
      // lexical basename. This still resolves any symlink in the ancestor path
      // (so an escaping parent symlink is caught) while permitting new leaves.
      const slash = lexicalPath.lastIndexOf('/');
      if (slash > 0) {
        const parent = lexicalPath.slice(0, slash);
        const base = lexicalPath.slice(slash + 1);
        try {
          const realParent = await this.#vfs.realpath(parent);
          return normalizePath(realParent + '/' + base);
        } catch (parentErr) {
          if (parentErr instanceof FileSystemError && parentErr.code === 'loop') throw parentErr;
          // Parent also unresolvable: nothing to follow — use the lexical path.
          return lexicalPath;
        }
      }
      return lexicalPath;
    }
  }

  /**
   * SEC-2: capability check for an operation that inspects/creates the LINK
   * itself and does NOT follow the final component (lstat, symlink, readlink).
   * The final component must be checked WITHOUT following it (else creating a
   * symlink, or reading one that escapes, would be wrongly resolved). We
   * canonicalize only the PARENT directory (resolving any symlink in the ancestor
   * path) and check the canonical-parent + lexical basename. This still catches
   * an escaping ancestor symlink while correctly treating the leaf as a link.
   */
  async #linkCheckedPath(pid: number, lexicalPath: string, op: FsOperation): Promise<string> {
    let checkPath = lexicalPath;
    if (this.#vfs.realpath) {
      const slash = lexicalPath.lastIndexOf('/');
      if (slash > 0) {
        const parent = lexicalPath.slice(0, slash);
        const base = lexicalPath.slice(slash + 1);
        try {
          const realParent = await this.#vfs.realpath(parent);
          checkPath = normalizePath(realParent + '/' + base);
        } catch (err) {
          if (err instanceof FileSystemError && err.code === 'loop') throw err;
          // Parent missing/unresolvable: fall back to lexical (no symlink to follow).
        }
      }
    }
    if (!this.#caps.checkFs(pid, checkPath, op)) {
      throw new FileSystemError('access', `Permission denied: ${checkPath}`);
    }
    return checkPath;
  }

  async #open(pid: number, args: SyscallArgs<'fs/open'>): Promise<{ fd: number }> {
    const absPath = this.#resolvePath(pid, args.path);
    const oflags = (args.oflags ?? {}) as OpenFlags;
    const op: FsOperation = needsWrite(oflags) ? 'write' : 'read';
    // SEC-2: canonicalize through symlinks and check the CANONICAL path so an
    // in-grant symlink that escapes the prefix cannot be opened.
    const canonical = await this.#canonicalCheckedPath(pid, absPath, op);
    const handle = await this.#vfs.open(canonical, oflags);
    const fd = this.#allocFd(pid);
    this.#tableFor(pid).set(fd, { handle, offset: 0 });
    return { fd };
  }

  async #read(pid: number, args: SyscallArgs<'fs/read'>): Promise<Uint8Array> {
    const entry = this.#fdOf(pid, args.fd);
    const len = args.len ?? 0;
    const offset = typeof args.offset === 'number' ? args.offset : entry.offset;
    const data = await this.#vfs.read(entry.handle, offset, len);
    if (typeof args.offset !== 'number') entry.offset += data.byteLength;
    // Normalize views: if the VFS returned a subarray into a pooled buffer,
    // copy into a tight Uint8Array so the caller can safely transfer .buffer
    // without leaking pool bytes or using incorrect offsets.
    return toTightView(data);
  }

  async #write(pid: number, args: SyscallArgs<'fs/write'>): Promise<{ written: number }> {
    const entry = this.#fdOf(pid, args.fd);
    const data = toBytes(args.data);
    const offset = typeof args.offset === 'number' ? args.offset : entry.offset;
    const written = await this.#vfs.write(entry.handle, data, offset);
    if (typeof args.offset !== 'number') entry.offset += written;
    return { written };
  }

  #close(pid: number, args: SyscallArgs<'fs/close'>): Record<string, never> {
    const fd = args.fd;
    const table = this.#tableFor(pid);
    const entry = table.get(fd);
    if (!entry) throw new BadFdError(fd);
    if (entry.kind === 'listener') {
      // Unbind the named channel and tear down queued/parked connections:
      // close unaccepted ports and reject any parked ipc/accept waiters.
      if (this.#ipc) this.#ipc.unbind(entry.path);
      this.#teardownListener(fd);
    } else if (entry.kind !== 'pipe') {
      // File fds: release the VFS handle. Pipe fds: guest owns the port, just forget.
      void this.#vfs.close(entry.handle);
    }
    table.delete(fd);
    return {};
  }

  async #stat(pid: number, args: SyscallArgs<'fs/stat'>): Promise<unknown> {
    const absPath = this.#resolvePath(pid, args.path);
    // `followSymlinks: false` requests lstat semantics (stat the link itself).
    const followSymlinks = args.followSymlinks !== false;
    // SEC-2: a following stat must be gated on the CANONICAL target (an escaping
    // symlink leaks the out-of-grant target's type/size otherwise). An lstat
    // inspects the link itself — gate on the canonical-parent + lexical leaf.
    const checkPath = followSymlinks
      ? await this.#canonicalCheckedPath(pid, absPath, 'read')
      : await this.#linkCheckedPath(pid, absPath, 'read');
    const stat = await this.#vfs.stat(checkPath, { followSymlinks });
    // Numbers cross the structured-clone boundary cleanly; BigInts in some
    // realms do not, so coerce size/linkCount the guest cares about.
    return { ...stat, size: Number(stat.size), linkCount: Number(stat.linkCount) };
  }

  async #readdir(pid: number, args: SyscallArgs<'fs/readdir'>): Promise<unknown> {
    const absPath = this.#resolvePath(pid, args.path);
    // readdir follows symlinks to the directory — gate on the canonical target.
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'read');
    return await this.#vfs.readdir(canonical);
  }

  async #mkdir(pid: number, args: SyscallArgs<'fs/mkdir'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    // mkdir creates a new leaf; the ancestor path may contain symlinks — gate on
    // the canonical-parent + lexical leaf so an escaping ancestor is caught.
    const checkPath = await this.#linkCheckedPath(pid, absPath, 'write');
    await this.#vfs.mkdir(checkPath);
    return {};
  }

  async #unlink(pid: number, args: SyscallArgs<'fs/unlink'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    // unlink removes the link/file itself (does not follow the final symlink) —
    // gate on canonical-parent + lexical leaf.
    const checkPath = await this.#linkCheckedPath(pid, absPath, 'write');
    await this.#vfs.unlink(checkPath);
    return {};
  }

  async #rmdir(pid: number, args: SyscallArgs<'fs/rmdir'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    const checkPath = await this.#linkCheckedPath(pid, absPath, 'write');
    await this.#vfs.rmdir(checkPath);
    return {};
  }

  /**
   * `fs/rename {path, newPath}`: move/rename within the VFS. Requires write on
   * both the source (it is removed) and the destination (it is created).
   * `newPath` is resolved relative to the same cwd/dirfd rules as `path`.
   */
  async #rename(pid: number, args: SyscallArgs<'fs/rename'>): Promise<Record<string, never>> {
    const oldPath = this.#resolvePath(pid, args.path);
    const newPath = this.#resolvePath(pid, args.newPath);
    // rename operates on the entries themselves (renaming a symlink renames the
    // link, not its target), but ancestor symlinks must be resolved — gate both
    // on canonical-parent + lexical leaf.
    const oldCheck = await this.#linkCheckedPath(pid, oldPath, 'write');
    const newCheck = await this.#linkCheckedPath(pid, newPath, 'write');
    await this.#vfs.rename(oldCheck, newCheck);
    return {};
  }

  /**
   * `fs/symlink {target, path}`: create a symlink at `path` pointing at the raw
   * `target` string (not resolved — symlink targets may be relative/dangling).
   * Requires write on the link path.
   */
  async #symlink(pid: number, args: SyscallArgs<'fs/symlink'>): Promise<Record<string, never>> {
    const linkPath = this.#resolvePath(pid, args.path);
    const target = args.target;
    // Creating a symlink writes the LINK at linkPath (the final component must not
    // be followed). Gate on canonical-parent + lexical leaf. NOTE: this gates only
    // WHERE the link is created — the target is not resolved here (targets may be
    // relative/dangling). Reads THROUGH the link are gated at open/stat time via
    // canonicalization, so a link to an ungranted target cannot be used to escape.
    const checkPath = await this.#linkCheckedPath(pid, linkPath, 'write');
    await this.#vfs.symlink(target, checkPath);
    return {};
  }

  async #readlink(pid: number, args: SyscallArgs<'fs/readlink'>): Promise<{ target: string }> {
    const absPath = this.#resolvePath(pid, args.path);
    // readlink reads the LINK itself (does not follow the final component) — gate
    // on canonical-parent + lexical leaf, not the (possibly escaping) target.
    const checkPath = await this.#linkCheckedPath(pid, absPath, 'read');
    const target = await this.#vfs.readlink(checkPath);
    return { target };
  }

  /**
   * `fs/link {target, path}`: create a hard link at `path` to the existing
   * `target`. Requires read on the target and write on the new link path.
   */
  async #link(pid: number, args: SyscallArgs<'fs/link'>): Promise<Record<string, never>> {
    const linkPath = this.#resolvePath(pid, args.path);
    const target = this.#resolvePath(pid, args.target);
    // A hard link's target is canonicalized (an escaping target symlink must not
    // let a guest hard-link an out-of-grant inode); the new link path is a leaf.
    const targetCheck = await this.#canonicalCheckedPath(pid, target, 'read');
    const linkCheck = await this.#linkCheckedPath(pid, linkPath, 'write');
    await this.#vfs.link(targetCheck, linkCheck);
    return {};
  }

  async #chmod(pid: number, args: SyscallArgs<'fs/chmod'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    // chmod follows symlinks — gate on the canonical target.
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'write');
    await this.#vfs.chmod(canonical, args.mode ?? 0);
    return {};
  }

  /**
   * `fs/utimes {path, atime?, mtime?}`: set access/modification times. Times are
   * accepted as epoch milliseconds; omitted times default to "now". Requires
   * write on the path.
   */
  async #utimes(pid: number, args: SyscallArgs<'fs/utimes'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    const now = Date.now();
    const atime = new Date(typeof args.atime === 'number' ? args.atime : now);
    const mtime = new Date(typeof args.mtime === 'number' ? args.mtime : now);
    // utimes follows symlinks — gate on the canonical target.
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'write');
    await this.#vfs.utimes(canonical, atime, mtime);
    return {};
  }

  /**
   * `fs/realpath {path}`: canonicalize a path (resolve symlinks). Requires read
   * on the path. Falls back to the normalized path when the provider does not
   * implement `realpath`.
   */
  async #realpath(pid: number, args: SyscallArgs<'fs/realpath'>): Promise<{ path: string }> {
    const absPath = this.#resolvePath(pid, args.path);
    // realpath REVEALS the canonical (symlink-resolved) path — gate on the
    // canonical target so it cannot disclose a path outside the grant.
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'read');
    return { path: canonical };
  }

  /**
   * `fs/getxattr {path, name}`: read an extended attribute. Requires read on the
   * (canonical, symlink-resolved) path — the same gate `fs/chmod` uses, just on
   * `read`. A missing attribute is ENOENT (our errno set has no ENODATA/ENOATTR).
   */
  async #getxattr(pid: number, args: SyscallArgs<'fs/getxattr'>): Promise<Uint8Array> {
    const absPath = this.#resolvePath(pid, args.path);
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'read');
    const value = await this.#vfs.getxattr(canonical, args.name);
    if (value === undefined) throw new FileSystemError('no-entry', `No such attribute: ${args.name}`);
    return value;
  }

  /** `fs/setxattr {path, name, value}`: write an extended attribute. Requires write. */
  async #setxattr(pid: number, args: SyscallArgs<'fs/setxattr'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'write');
    await this.#vfs.setxattr(canonical, args.name, args.value);
    return {};
  }

  /** `fs/listxattr {path}`: enumerate extended-attribute names. Requires read. */
  async #listxattr(pid: number, args: SyscallArgs<'fs/listxattr'>): Promise<{ names: string[] }> {
    const absPath = this.#resolvePath(pid, args.path);
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'read');
    return { names: await this.#vfs.listxattr(canonical) };
  }

  /** `fs/removexattr {path, name}`: drop an extended attribute. Requires write. */
  async #removexattr(pid: number, args: SyscallArgs<'fs/removexattr'>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args.path);
    const canonical = await this.#canonicalCheckedPath(pid, absPath, 'write');
    await this.#vfs.removexattr(canonical, args.name);
    return {};
  }

  #fdOf(pid: number, fd: number): OpenFile {
    const entry = this.#tableFor(pid).get(fd);
    if (!entry) throw new BadFdError(fd);
    // Pipe and listener fds are not serviced via the dispatcher's read/write path.
    if (entry.kind === 'pipe' || entry.kind === 'listener') throw new BadFdError(fd);
    return entry;
  }

  #tableFor(pid: number): Map<number, FdEntry> {
    let table = this.#fdTables.get(pid);
    if (!table) { table = new Map(); this.#fdTables.set(pid, table); }
    return table;
  }

  #allocFd(pid: number): number {
    // Reserve 0,1,2 for stdio (handled via direct ports, not this table).
    const next = this.#nextFd.get(pid) ?? 3;
    this.#nextFd.set(pid, next + 1);
    return next;
  }

  /**
   * `dom/mutate`: forward a batch of DomMutation records from the guest to the
   * registered DomMutateHandler. If no handler is configured, returns ENOSYS.
   * The mutations array is validated to be an array before forwarding; individual
   * record validation is the responsibility of RemoteDomHost (which enforces the
   * allowlist and silently drops invalid records).
   */
  #domMutate(pid: number, args: SyscallArgs<'dom/mutate'>): Record<string, never> {
    if (!this.#onDomMutate) {
      throw new FileSystemError('unsupported', 'dom/mutate: no DOM handler configured');
    }
    this.#onDomMutate(pid, args.mutations as DomMutation[]);
    return {};
  }

  /**
   * `net/fetch {method, url, headers?, body?, timeoutMs?}`: perform an HTTP
   * request on behalf of a guest — the ONLY network surface a sandboxed process
   * gets. The guest never holds a socket or `fetch`; everything funnels through
   * here so the kernel can enforce capabilities.
   *
   * SECURITY (the key property): the request ORIGIN is checked against the
   * caller's `net` capability via {@link CapabilityManager.checkNet} BEFORE the
   * injected {@link HttpClient} is ever invoked. An ungranted origin — or a URL
   * with no parseable origin — yields EACCES and the HTTP client is not called,
   * so a guest cannot reach an origin it lacks capability for. With no client
   * configured the syscall returns ENOSYS (network disabled).
   *
   * Returns `{status, headers, body}`. A client/transport failure maps to
   * EHOSTUNREACH so the guest can surface a connection error (curl exit 7).
   */
  async #netFetch(pid: number, id: number, args: NetFetchParsed): Promise<DispatchResult> {
    if (!this.#httpClient) {
      return res(fail(id, 'ENOSYS', 'net/fetch: no HTTP client configured'));
    }
    // K1: a process whose limits set `networkDisabled` cannot reach the network
    // at all, even if it holds a matching `net` capability. Deny before any
    // network access (EACCES), so the HTTP client is never invoked for this pid.
    if (this.#limitsOf?.(pid)?.networkDisabled) {
      return res(fail(id, 'EACCES', 'net/fetch: network disabled for this process (ProcessLimits.networkDisabled)'));
    }
    let url = args.url;
    // Capability gate FIRST — before any network access. An ungranted origin
    // (or an unparseable URL, which checkNet rejects) is EACCES.
    if (!this.#caps.checkNet(pid, url)) {
      return res(fail(id, 'EACCES', `Permission denied: ${url}`));
    }
    let method = args.method;
    const headers = args.headers;
    let body = args.body;
    const timeoutMs = args.timeoutMs;
    // B1: build ONE timeout signal covering the WHOLE redirect chain (not a fresh
    // per-hop timeout), so `--max-time` bounds total wall-clock across all hops.
    // Passed as `request.signal`; the client does NOT re-derive from timeoutMs.
    const signal = typeof timeoutMs === 'number' && timeoutMs >= 0
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

    // SEC-1: follow redirects HERE, re-checking the `net` capability against the
    // target of every 3xx hop. The HTTP client is told `redirect:'manual'` so it
    // returns the 3xx instead of following it internally — that prevents a guest
    // granted origin A from being silently redirected to an ungranted origin B
    // (cloud metadata, localhost, etc.) and receiving its body. A redirect to an
    // UNGRANTED origin yields EACCES and the body is never fetched; the chain is
    // capped at MAX_REDIRECT_HOPS (→ ELOOP) so a redirect cycle cannot hang.
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECT_HOPS) {
        return res(fail(id, 'ELOOP', `net/fetch: too many redirects (> ${MAX_REDIRECT_HOPS})`));
      }
      const request: HttpRequest = { method, url, headers, redirect: 'manual' };
      if (body !== undefined) request.body = body;
      if (signal !== undefined) request.signal = signal;

      let response: HttpResponse;
      try {
        response = await this.#httpClient.send(request);
      } catch (err) {
        // B1: a timeout/abort (AbortSignal.timeout → TimeoutError; manual abort →
        // AbortError) maps to ETIMEDOUT so the guest can surface a real timeout
        // (curl --max-time → exit 28), distinct from a connection failure.
        if (isAbortError(err)) {
          return res(fail(id, 'ETIMEDOUT', `net/fetch: request timed out after ${timeoutMs}ms`));
        }
        // Other transport-level failure (DNS, connection refused): the request was
        // authorized but could not complete. Map to a generic network errno.
        return res(fail(id, 'EHOSTUNREACH', messageOf(err)));
      }

      if (isRedirectStatus(response.status)) {
        const location = headerValue(response.headers, 'location');
        if (location !== undefined) {
          // B6: the intermediate 3xx body is discarded — cancel its stream so the
          // underlying transport stops (an undrained stream would leak/stall).
          await cancelBody(response.body);
          let nextUrl: string;
          try {
            nextUrl = new URL(location, url).toString();
          } catch {
            return res(fail(id, 'EINVAL', `net/fetch: invalid redirect Location: ${location}`));
          }
          // Re-run the capability check against the REDIRECT TARGET. Denied →
          // EACCES and we never fetch the target (no body from an ungranted
          // origin ever reaches the guest).
          if (!this.#caps.checkNet(pid, nextUrl)) {
            return res(fail(id, 'EACCES', `Permission denied (redirect target): ${nextUrl}`));
          }
          url = nextUrl;
          // CU1: honor RFC 7231/7538 redirect method/body semantics.
          //   - 307 (Temporary) / 308 (Permanent): PRESERVE method AND body.
          //   - 303 (See Other): always rewrite to GET, drop the body.
          //   - 301 (Moved) / 302 (Found): keep the method+body for idempotent
          //     methods (GET/HEAD); for everything else rewrite to GET and drop
          //     the body, matching browser fetch behavior.
          if (response.status === 307 || response.status === 308) {
            // method + body unchanged — temporary/permanent redirect preserves them.
          } else if (response.status === 303) {
            method = 'GET';
            body = undefined;
          } else {
            // 301 / 302
            const m = method.toUpperCase();
            if (m !== 'GET' && m !== 'HEAD') {
              method = 'GET';
              body = undefined;
            }
          }
          continue;
        }
        // No Location header: surface the 3xx response as-is (can't follow).
      }

      // B6: the redirect chain is done; deliver the FINAL response body.
      return await this.#deliverNetBody(pid, id, response);
    }
  }

  /**
   * B6: deliver a final `net/fetch` response body to the guest.
   *
   * TRANSFERABLE backend (`directPipes` + an IPC broker): mint a pipe, transfer
   * its READ end to the guest, and PUMP the response `ReadableStream` into the
   * write end honoring the credit protocol (so a large download never buffers
   * wholesale and the guest cancelling its read propagates EPIPE back to abort
   * the pump). The result carries `bodyStream: true` and no inline `body`.
   *
   * NON-TRANSFERABLE backend (relay/QuickJS — the guest cannot hold a
   * MessagePort): fall back to BUFFERED delivery — drain the stream to a
   * `Uint8Array` and return it inline as `body`. R3: the drain is BOUNDED by
   * {@link #maxBufferedBodyBytes} (default 64 MiB); a body that exceeds the cap
   * has its source stream cancelled and the syscall fails ENOSPC, so an
   * attacker-controlled large/infinite response cannot OOM the host. (The
   * transferable streaming path above is already bounded by credit back-pressure
   * and is unaffected.)
   *
   * A bodyless response (204/304/HEAD → `response.body` undefined) returns
   * neither field.
   */
  async #deliverNetBody(pid: number, id: number, response: HttpResponse): Promise<DispatchResult> {
    const base = { status: response.status, headers: response.headers };
    if (!response.body) {
      return res(ok(id, base));
    }
    // Stream over a transferred port only when the backend can transfer ports
    // (same gate as `fs/pipe`). Otherwise buffer.
    if (this.#directPipes && this.#ipc) {
      const { readPort, writePort } = this.#ipc.createPipe();
      // Fire-and-forget pump: read the response stream → write port, honoring
      // credit + the sticky broken latch. The guest owns readPort after transfer.
      void this.#feedStreamToPort(response.body, writePort);
      return { response: ok(id, { ...base, bodyStream: true }), transfer: [readPort] };
    }
    // Buffered fallback: drain the whole stream and return the bytes inline,
    // BOUNDED by the cap. On overflow, abort (cancel the source) and fail ENOSPC.
    let bytes: Uint8Array;
    try {
      bytes = await drainBounded(response.body, this.#maxBufferedBodyBytes);
    } catch (err) {
      if (err instanceof BufferedBodyTooLargeError) {
        return res(fail(id, 'ENOSPC', err.message));
      }
      // A transport-level read failure mid-body: surface as a network error.
      return res(fail(id, 'EHOSTUNREACH', messageOf(err)));
    }
    const result: { status: number; headers: [string, string][]; body?: Uint8Array } =
      bytes.byteLength > 0 ? { ...base, body: toTightView(bytes) } : base;
    return res(ok(id, result));
  }

  /**
   * B6: pump a response-body `ReadableStream` into a pipe WRITE port honoring the
   * credit protocol, then send EOF and close — the streaming-fetch analogue of
   * {@link #feedFileToPort} (which streams a VFS file). The shared
   * {@link PipeWriter} owns credit accounting + the STICKY broken latch: if the
   * guest cancels its read end (or the peer sends EPIPE), `reserve()` rejects, the
   * pump ends promptly, AND the source stream is cancelled so an unbounded body
   * stops instead of streaming forever (`curl big | head -c10`). Fire-and-forget;
   * any error closes the port (the guest sees EOF/EPIPE).
   *
   * R2: a real HTTP `response.body` chunk can exceed the guest reader's credit
   * WINDOW (the fetch-body reader is a default {@link INITIAL_CREDIT_BYTES} 64 KiB
   * `portToReadable`). A `PipeWriter.reserve()` for a whole >window chunk can NEVER
   * be satisfied — the reader cannot grant more than its window — so it parks
   * forever and streaming fetch HANGS. We therefore SPLIT each source chunk into
   * sub-chunks of at most {@link INITIAL_CREDIT_BYTES} before reserving, so the
   * pump never reserves more than the window ANY guest reader can grant. Each
   * sub-chunk still flows through `reserve()`, so credit-based back-pressure (a
   * slow consumer stalling the pump) is preserved — we cap the per-reserve size,
   * not the total.
   */
  async #feedStreamToPort(body: ReadableStream<Uint8Array>, writePort: MessagePort): Promise<void> {
    const reader = body.getReader();
    // The shared pump sub-chunks each source value to INITIAL_CREDIT_BYTES (R2)
    // and owns the credit/markBroken handling; `next` pulls from the body reader.
    const next = async (): Promise<Uint8Array | null> => {
      const { value, done } = await reader.read();
      return done ? null : (value ?? new Uint8Array(0));
    };
    let broken = false;
    try {
      broken = await pumpToPort(writePort, next, INITIAL_CREDIT_BYTES);
    } finally {
      reader.releaseLock();
      // A broken pipe (or read failure): cancel the source so an unbounded
      // upstream stops (early-cancel → broken pipe → abort).
      if (broken) { try { await body.cancel(); } catch { /* already cancelled */ } }
    }
  }
}

/**
 * Maximum number of redirect hops `net/fetch` will follow before failing with
 * ELOOP. Each hop is capability-checked against the redirect target.
 */
const MAX_REDIRECT_HOPS = 20;

/** True for HTTP status codes that carry a redirect (followed via Location). */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Case-insensitive lookup of a header value in a `[name, value][]` list. */
function headerValue(headers: [string, string][], name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Coerce a raw `headers` arg into the `[name, value][]` shape the client wants. */
function normalizeHeaders(raw: unknown): [string, string][] {
  if (!Array.isArray(raw)) return [];
  const out: [string, string][] = [];
  for (const pair of raw) {
    if (Array.isArray(pair) && pair.length >= 2) out.push([String(pair[0]), String(pair[1])]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// C2: boundary parse helpers. Each maps the untrusted `Record<string, unknown>`
// wire args of ONE syscall into its typed shape, throwing MalformedArgsError
// (→ EINVAL) on a missing/wrong-typed required field. This is the SINGLE
// runtime-validation step the typed union does not remove (guest input crossing
// the postMessage/relay bridge is untrusted). Optional fields are coerced
// leniently, matching the prior inline behavior.
// ---------------------------------------------------------------------------

/** Require a numeric `fd`. */
function reqFd(args: Record<string, unknown>): number {
  const fd = args.fd;
  if (typeof fd !== 'number' || !Number.isFinite(fd)) {
    throw new MalformedArgsError('fd must be a number');
  }
  return fd;
}

/** Require a string `path`. */
function reqPath(args: Record<string, unknown>): string {
  const path = args.path;
  if (typeof path !== 'string') throw new MalformedArgsError('path must be a string');
  return path;
}

function parseFd(args: Record<string, unknown>): { fd: number } {
  return { fd: reqFd(args) };
}

function parseFsPath(args: Record<string, unknown>): FsPathArgs {
  return { path: reqPath(args) };
}

function parseFsOpen(args: Record<string, unknown>): SyscallArgs<'fs/open'> {
  const out: SyscallArgs<'fs/open'> = { path: reqPath(args) };
  if (args.oflags && typeof args.oflags === 'object') out.oflags = args.oflags as SyscallArgs<'fs/open'>['oflags'];
  return out;
}

function parseFsRead(args: Record<string, unknown>): SyscallArgs<'fs/read'> {
  const out: SyscallArgs<'fs/read'> = { fd: reqFd(args) };
  if (typeof args.len === 'number') out.len = args.len;
  if (typeof args.offset === 'number') out.offset = args.offset;
  return out;
}

function parseFsWrite(args: Record<string, unknown>): SyscallArgs<'fs/write'> {
  const data = args.data;
  if (!(data instanceof Uint8Array) && !(data instanceof ArrayBuffer) && typeof data !== 'string') {
    throw new MalformedArgsError('write data must be bytes or a string');
  }
  const out: SyscallArgs<'fs/write'> = { fd: reqFd(args), data };
  if (typeof args.offset === 'number') out.offset = args.offset;
  return out;
}

function parseFsStat(args: Record<string, unknown>): SyscallArgs<'fs/stat'> {
  const out: SyscallArgs<'fs/stat'> = { path: reqPath(args) };
  if (typeof args.followSymlinks === 'boolean') out.followSymlinks = args.followSymlinks;
  return out;
}

function parseFsRename(args: Record<string, unknown>): SyscallArgs<'fs/rename'> {
  if (typeof args.newPath !== 'string') throw new MalformedArgsError('newPath must be a string');
  return { path: reqPath(args), newPath: args.newPath };
}

function parseFsLinkTarget(args: Record<string, unknown>): SyscallArgs<'fs/symlink'> {
  if (typeof args.target !== 'string') throw new MalformedArgsError('target must be a string');
  return { path: reqPath(args), target: args.target };
}

function parseFsChmod(args: Record<string, unknown>): SyscallArgs<'fs/chmod'> {
  const out: SyscallArgs<'fs/chmod'> = { path: reqPath(args) };
  if (typeof args.mode === 'number') out.mode = args.mode;
  return out;
}

function parseFsXattrName(args: Record<string, unknown>): SyscallArgs<'fs/getxattr'> {
  if (typeof args.name !== 'string') throw new MalformedArgsError('xattr name must be a string');
  return { path: reqPath(args), name: args.name };
}

function parseFsSetxattr(args: Record<string, unknown>): SyscallArgs<'fs/setxattr'> {
  if (typeof args.name !== 'string') throw new MalformedArgsError('xattr name must be a string');
  if (!(args.value instanceof Uint8Array)) throw new MalformedArgsError('xattr value must be bytes');
  return { path: reqPath(args), name: args.name, value: args.value };
}

function parseFsUtimes(args: Record<string, unknown>): SyscallArgs<'fs/utimes'> {
  const out: SyscallArgs<'fs/utimes'> = { path: reqPath(args) };
  if (typeof args.atime === 'number') out.atime = args.atime;
  if (typeof args.mtime === 'number') out.mtime = args.mtime;
  return out;
}

function parseIpcPath(args: Record<string, unknown>): { path: string } {
  return { path: reqPath(args) };
}

function parseDomMutate(args: Record<string, unknown>): SyscallArgs<'dom/mutate'> {
  if (!Array.isArray(args.mutations)) throw new MalformedArgsError('mutations must be an array');
  return { mutations: args.mutations };
}

function parseWait(args: Record<string, unknown>): SyscallArgs<'process/wait'> {
  if (typeof args.pid !== 'number') throw new MalformedArgsError('pid must be a number');
  return { pid: args.pid };
}

function parseKill(args: Record<string, unknown>): SyscallArgs<'process/kill'> {
  if (typeof args.pid !== 'number') throw new MalformedArgsError('pid must be a number');
  return typeof args.signal === 'string' ? { pid: args.pid, signal: args.signal } : { pid: args.pid };
}

function parseExit(args: Record<string, unknown>): SyscallArgs<'process/exit'> {
  return typeof args.code === 'number' ? { code: args.code } : {};
}

function parseChdir(args: Record<string, unknown>): SyscallArgs<'process/chdir'> {
  return { path: typeof args.path === 'string' ? args.path : '/' };
}

function parsePipeRead(args: Record<string, unknown>): SyscallArgs<'pipe/read'> {
  const out: SyscallArgs<'pipe/read'> = { fd: reqFd(args) };
  if (typeof args.len === 'number') out.len = args.len;
  return out;
}

function parsePipeWrite(args: Record<string, unknown>): SyscallArgs<'pipe/write'> {
  const data = args.data;
  if (!(data instanceof Uint8Array) && !Array.isArray(data) && typeof data !== 'string') {
    throw new MalformedArgsError('pipe/write data must be bytes, a number[], or a string');
  }
  return { fd: reqFd(args), data: data as Uint8Array | number[] | string };
}

/** Net-fetch parsed args: the wire args coerced into transport-ready shapes. */
interface NetFetchParsed {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array | undefined;
  timeoutMs: number | undefined;
}

function parseNetFetch(args: Record<string, unknown>): NetFetchParsed {
  let body: Uint8Array | undefined;
  const rawBody = args.body;
  if (rawBody instanceof Uint8Array) body = rawBody;
  else if (rawBody instanceof ArrayBuffer) body = new Uint8Array(rawBody);
  else if (typeof rawBody === 'string') body = new TextEncoder().encode(rawBody);
  return {
    method: typeof args.method === 'string' ? args.method : 'GET',
    url: typeof args.url === 'string' ? args.url : '',
    headers: normalizeHeaders(args.headers),
    body,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
  };
}

/** Map a {@link RelayPipeResult} to a wire {@link SyscallResponse}. */
function relayToResponse(id: number, r: RelayPipeResult): SyscallResponse {
  return r.ok ? ok(id, r.result) : fail(id, r.error.code, r.error.message);
}

/**
 * R4: boundary parse for `process/spawn` — validate the untrusted guest args
 * into a typed {@link SpawnArgs} (plus the positional `portFds`). Unlike the
 * other syscalls, `process/spawn` previously bypassed the `parse*` boundary and
 * cast `env`/`fds` unchecked; here we validate every field exactly like the C2
 * helpers, throwing {@link MalformedArgsError} (→ EINVAL) on bad input rather than
 * silently dropping/coercing it (a non-object env, an array env, a non-string
 * argv element, etc. all become EINVAL instead of reaching the spawn path).
 * Optional fields stay optional; valid input is unchanged in behavior.
 */
function parseSpawn(args: Record<string, unknown>): SpawnArgs & { portFds?: number[] } {
  if (typeof args.path !== 'string') throw new MalformedArgsError('process/spawn: path must be a string');
  if (!Array.isArray(args.argv)) throw new MalformedArgsError('process/spawn: argv must be an array of strings');
  const argv: string[] = [];
  for (const a of args.argv) {
    if (typeof a !== 'string') throw new MalformedArgsError('process/spawn: argv elements must be strings');
    argv.push(a);
  }
  const out: SpawnArgs & { portFds?: number[] } = { path: args.path, argv };
  if (args.env !== undefined) out.env = parseEnv(args.env, 'process/spawn');
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string') throw new MalformedArgsError('process/spawn: cwd must be a string');
    out.cwd = args.cwd;
  }
  if (args.fds !== undefined) {
    if (typeof args.fds !== 'object' || args.fds === null || Array.isArray(args.fds)) {
      throw new MalformedArgsError('process/spawn: fds must be an object keyed by fd');
    }
    // R1: a `bytes` fd action carries a raw byte buffer (here-string/here-doc
    // stdin source); reject a non-Uint8Array `data` at the boundary (EINVAL)
    // rather than letting it reach the pump.
    for (const action of Object.values(args.fds as Record<number, unknown>)) {
      if ((action as { action?: string })?.action === 'bytes'
        && !((action as { data?: unknown }).data instanceof Uint8Array)) {
        throw new MalformedArgsError('process/spawn: bytes fd action data must be a Uint8Array');
      }
    }
    out.fds = args.fds as SpawnArgs['fds'];
  }
  // `portFds[i]` is the child fd for the i-th transferred port (positional). The
  // ports themselves are mapped in #spawn; here we only validate the shape.
  if (args.portFds !== undefined) {
    if (!Array.isArray(args.portFds) || args.portFds.some((f) => typeof f !== 'number')) {
      throw new MalformedArgsError('process/spawn: portFds must be an array of numbers');
    }
    out.portFds = args.portFds as number[];
  }
  return out;
}

/**
 * A2 (relay coproc): boundary parse for `process/coproc` — validate the untrusted
 * guest args into a {@link SpawnArgs}. Reuses the spawn field validation for
 * path/argv/env/cwd; unlike spawn there are no `fds`/`portFds` (the kernel mints
 * and wires both pipes itself, so the guest supplies only the command).
 */
function parseCoproc(args: Record<string, unknown>): SpawnArgs {
  if (typeof args.path !== 'string') throw new MalformedArgsError('process/coproc: path must be a string');
  if (!Array.isArray(args.argv)) throw new MalformedArgsError('process/coproc: argv must be an array of strings');
  const argv: string[] = [];
  for (const a of args.argv) {
    if (typeof a !== 'string') throw new MalformedArgsError('process/coproc: argv elements must be strings');
    argv.push(a);
  }
  const out: SpawnArgs = { path: args.path, argv };
  if (args.env !== undefined) out.env = parseEnv(args.env, 'process/coproc');
  if (args.cwd !== undefined) {
    if (typeof args.cwd !== 'string') throw new MalformedArgsError('process/coproc: cwd must be a string');
    out.cwd = args.cwd;
  }
  return out;
}

/**
 * R4: validate an `env` arg into a `Record<string, string>`. A plain object with
 * all-string values passes through; anything else (a string, an array, null, or
 * an object with a non-string value) is a {@link MalformedArgsError} (→ EINVAL).
 * Shared by `process/spawn` so the cast that was previously unchecked is gone.
 */
function parseEnv(env: unknown, who: string): Record<string, string> {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    throw new MalformedArgsError(`${who}: env must be an object of string values`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new MalformedArgsError(`${who}: env value for "${k}" must be a string`);
    out[k] = v;
  }
  return out;
}

function needsWrite(oflags: OpenFlags): boolean {
  return Boolean(oflags.write || oflags.create || oflags.truncate || oflags.append || oflags.exclusive);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new FileSystemError('invalid', 'Invalid write payload');
}

function errnoOf(err: unknown): ErrnoCode {
  if (err instanceof BadFdError) return err.errno;
  if (err instanceof FileSystemError) return fsErrorToErrno(err.code);
  // Structured errors with an explicit POSIX errno code (e.g. from #applyFdAction).
  if (err && typeof err === 'object' && 'errno' in err && typeof (err as { errno: unknown }).errno === 'string') {
    return (err as { errno: ErrnoCode }).errno;
  }
  return 'EIO';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * B1: true if `err` is a fetch abort — either `AbortSignal.timeout` firing
 * (DOMException name `TimeoutError`) or a manual `AbortController.abort()`
 * (`AbortError`). These surface a request timeout/cancellation distinct from a
 * connection failure, so the caller can map them to ETIMEDOUT.
 */
function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Return `view` if it already spans its entire backing buffer; otherwise copy
 * into a fresh tight `Uint8Array`. This ensures the caller can safely transfer
 * `.buffer` over `postMessage` without clobbering pooled buffers or sending
 * wrong bytes when `byteOffset > 0`.
 */
function toTightView(view: Uint8Array): Uint8Array {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view;
  return new Uint8Array(view);
}

/**
 * B6: cancel an unconsumed response-body stream (e.g. an intermediate 3xx body
 * during the redirect loop) so the underlying transport stops. No-op when there
 * is no body or it is already cancelled/locked.
 */
async function cancelBody(body: ReadableStream<Uint8Array> | undefined): Promise<void> {
  if (!body || body.locked) return;
  try { await body.cancel(); } catch { /* already cancelled */ }
}

/**
 * R3: default cap on the BUFFERED-fallback `net/fetch` body — the maximum bytes
 * the kernel will read into host memory when it cannot stream the body over a
 * transferred port. Matches the kernel's `maxOutputBytes` default (64 MiB) so a
 * large/infinite response on a relay/QuickJS backend cannot OOM the host.
 */
const MAX_BUFFERED_BODY_BYTES = 64 * 1024 * 1024;

/** R3: thrown by {@link drainBounded} when the body exceeds the cap. */
class BufferedBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`net/fetch: response body exceeds the buffered limit of ${limit} bytes`);
    this.name = 'BufferedBodyTooLargeError';
  }
}

/**
 * R3: drain `stream` fully into one `Uint8Array`, but ABORT once the accumulated
 * size would exceed `limit` — cancel the source (so the upstream transport stops)
 * and throw {@link BufferedBodyTooLargeError}. This bounds the buffered-fallback
 * body path so an attacker-controlled large/infinite response cannot OOM the
 * host. Unlike the credit-bounded streaming path, the fallback holds the whole
 * body in memory, so the explicit cap is the only protection here.
 */
async function drainBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        // Over the cap: stop reading and cancel the source so the transport stops
        // (it would otherwise keep delivering an unbounded body to a dead drain).
        reader.releaseLock();
        await cancelBody(stream);
        throw new BufferedBodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

function res(response: SyscallResponse, transfer?: Transferable[]): DispatchResult {
  return transfer ? { response, transfer } : { response };
}

function ok(id: number, result: unknown): SyscallResponse {
  return { id, ok: true, result };
}

function fail(id: number, code: ErrnoCode, message: string): SyscallResponse {
  return { id, ok: false, error: { code, message } };
}
