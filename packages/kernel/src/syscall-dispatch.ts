import type { SyscallResponse, ErrnoCode, SpawnArgs } from '@mithic/protocol';
import { fsErrorToErrno } from '@mithic/protocol';
import { FileSystemError, normalizePath } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import type { HttpClient, HttpRequest, HttpResponse } from '@mithic/io/net';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';
import type { IpcBroker } from './ipc-broker.ts';
import type { WaitResult } from './process-manager.ts';
import type { DomMutation } from '@mithic/guest-runtime/remote-dom';

/** Thrown when a process references an fd it does not own (wrong pid or never opened). */
class BadFdError extends Error {
  readonly errno: ErrnoCode = 'EBADF';
  constructor(fd: number) {
    super(`Bad file descriptor: ${fd}`);
    this.name = 'BadFdError';
  }
}

/** AT_FDCWD: a dirfd meaning "resolve relative to the process cwd". */
const AT_FDCWD = -100;

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

/** One stage of a guest-requested pipeline (command name/path + argv + env). */
export interface PipelineStageSpec {
  path: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
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
   * HTTP client backing the capability-gated `net/fetch` syscall. The dispatcher
   * checks the caller's `net` capability for the request ORIGIN (via
   * `caps.checkNet`) BEFORE ever touching this client; a guest can never reach an
   * origin it lacks capability for. Injectable so tests pass a mock and hosts
   * default to `globalThis.fetch` (via `FetchHttpClient`). Unset = `net/fetch`
   * returns ENOSYS (network disabled).
   */
  httpClient?: HttpClient;
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
  #ipc: IpcBroker | undefined;
  #directPipes: boolean;
  #onDomMutate: DomMutateHandler | undefined;
  #resolveCommand: SyscallDispatcherOptions['resolveCommand'];
  #spawnChild: SpawnChild | undefined;
  #waitChild: WaitChild | undefined;
  #pipelineChild: PipelineChild | undefined;
  #ppidOf: ((pid: number) => number) | undefined;
  #chdir: ((pid: number, path: string) => void) | undefined;
  #exitProcess: ((pid: number, code: number) => void) | undefined;
  #httpClient: HttpClient | undefined;
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
    this.#ipc = options.ipc;
    this.#directPipes = options.directPipes ?? true;
    this.#onDomMutate = options.onDomMutate;
    this.#resolveCommand = options.resolveCommand;
    this.#spawnChild = options.spawnChild;
    this.#waitChild = options.waitChild;
    this.#pipelineChild = options.pipelineChild;
    this.#ppidOf = options.ppidOf;
    this.#chdir = options.chdir;
    this.#exitProcess = options.exitProcess;
    this.#httpClient = options.httpClient;
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

  async dispatch(
    pid: number,
    req: SyscallRequestLike,
    ports?: readonly MessagePort[],
  ): Promise<DispatchResult> {
    try {
      switch (req.call) {
        case 'fs/open':
          return res(ok(req.id, await this.#open(pid, req.args)));
        case 'fs/read':
          return res(ok(req.id, await this.#read(pid, req.args)));
        case 'fs/write':
          return res(ok(req.id, await this.#write(pid, req.args)));
        case 'fs/close':
          return res(ok(req.id, this.#close(pid, req.args)));
        case 'fs/stat':
          return res(ok(req.id, await this.#stat(pid, req.args)));
        case 'fs/readdir':
          return res(ok(req.id, await this.#readdir(pid, req.args)));
        case 'fs/mkdir':
          return res(ok(req.id, await this.#mkdir(pid, req.args)));
        case 'fs/unlink':
          return res(ok(req.id, await this.#unlink(pid, req.args)));
        case 'fs/rmdir':
          return res(ok(req.id, await this.#rmdir(pid, req.args)));
        case 'fs/rename':
          return res(ok(req.id, await this.#rename(pid, req.args)));
        case 'fs/symlink':
          return res(ok(req.id, await this.#symlink(pid, req.args)));
        case 'fs/readlink':
          return res(ok(req.id, await this.#readlink(pid, req.args)));
        case 'fs/link':
          return res(ok(req.id, await this.#link(pid, req.args)));
        case 'fs/chmod':
          return res(ok(req.id, await this.#chmod(pid, req.args)));
        case 'fs/utimes':
          return res(ok(req.id, await this.#utimes(pid, req.args)));
        case 'fs/realpath':
          return res(ok(req.id, await this.#realpath(pid, req.args)));
        case 'fs/pipe':
          return this.#pipe(pid, req.id);
        case 'ipc/listen':
          return this.#ipcListen(pid, req.id, req.args);
        case 'ipc/accept':
          return this.#ipcAccept(pid, req.id, req.args);
        case 'ipc/connect':
          return this.#ipcConnect(pid, req.id, req.args);
        case 'dom/mutate':
          return res(ok(req.id, this.#domMutate(pid, req.args)));
        case 'net/fetch':
          return res(await this.#netFetch(pid, req.id, req.args));
        case 'process/spawn':
          return await this.#spawn(pid, req.id, req.args, ports);
        case 'process/pipeline':
          return res(await this.#pipeline(pid, req.id, req.args));
        case 'process/wait':
          return res(ok(req.id, await this.#wait(pid, req.args)));
        case 'process/exit':
          return res(ok(req.id, this.#processExit(pid, req.args)));
        case 'process/getpid':
          return res(ok(req.id, { pid }));
        case 'process/getppid':
          return res(ok(req.id, { ppid: this.#ppidOf?.(pid) ?? 0 }));
        case 'process/getcwd':
          return res(ok(req.id, { cwd: this.#cwdOf(pid) }));
        case 'process/chdir':
          return res(ok(req.id, this.#chdirCall(pid, req.args)));
        default:
          return res(fail(req.id, 'ENOSYS', `Unknown syscall: ${req.call}`));
      }
    } catch (err) {
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
    args: Record<string, unknown>,
    ports?: readonly MessagePort[],
  ): Promise<DispatchResult> {
    if (!this.#spawnChild) {
      this.#closePorts(ports);
      return res(fail(id, 'ENOSYS', 'process/spawn: no spawn handler configured'));
    }
    const childCount = this.#liveChildPids.get(pid)?.size ?? 0;
    if (!this.#caps.checkProcess(pid, childCount)) {
      this.#closePorts(ports);
      return res(fail(id, 'EPERM', 'process/spawn: missing process capability or child limit reached'));
    }
    const spawnArgs = normalizeSpawnArgs(args);
    if (!spawnArgs) {
      this.#closePorts(ports);
      return res(fail(id, 'EINVAL', 'process/spawn: invalid arguments'));
    }
    const cwd = spawnArgs.cwd ?? this.#cwdOf(pid);
    const env = spawnArgs.env ?? {};
    const code = this.#resolveCode(spawnArgs.path, spawnArgs.argv, cwd, env);
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
    const portFds = Array.isArray(args.portFds) ? args.portFds.map(Number) : [];
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
   * Resolve a command spec to spawnable guest code. Absolute paths and URLs are
   * used directly (a `string` URL becomes a `URL`); bare names defer to
   * `resolveCommand`. Returns `undefined` when a bare name has no resolver match.
   */
  #resolveCode(path: string, argv: string[], cwd: string, env: Record<string, string>): string | URL | undefined {
    if (path.includes('://')) return new URL(path);
    if (path.startsWith('/') || path.startsWith('./') || path.startsWith('../')) return path;
    const name = path || argv[0] || '';
    return this.#resolveCommand?.(name, cwd, env);
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
    if (!this.#caps.checkProcess(pid, currentChildren + rawStages.length - 1)) {
      return fail(id, 'EPERM', 'process/pipeline: missing process capability or child limit reached');
    }
    const resolved: Array<{ code: string | URL; spec: PipelineStageSpec }> = [];
    for (const raw of rawStages) {
      const r = raw as Record<string, unknown>;
      const path = typeof r.path === 'string' ? r.path : '';
      const argv = Array.isArray(r.argv) ? r.argv.map(String) : [];
      const env = (r.env && typeof r.env === 'object' ? r.env : {}) as Record<string, string>;
      const cwd = typeof r.cwd === 'string' ? r.cwd : this.#cwdOf(pid);
      const code = this.#resolveCode(path, argv, cwd, env);
      if (code === undefined) {
        return fail(id, 'ENOENT', `command not found: ${path}`);
      }
      resolved.push({ code, spec: { path, argv, env, cwd } });
    }
    const result = await this.#pipelineChild(pid, resolved);
    return ok(id, { exitCodes: result.exitCodes, stdout: result.lastStdout });
  }

  /**
   * `process/wait {pid}`: await a child's exit. Ownership-gated — a process may
   * only wait its own children (ppid check). Waiting a non-child / unknown pid
   * returns the no-child sentinel (ECHILD-style) rather than hanging.
   */
  async #wait(pid: number, args: Record<string, unknown>): Promise<WaitResult> {
    const target = Number(args.pid);
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
   * `process/exit {code}` as a SYSCALL. Routes to the kernel's exit teardown so
   * a guest that calls `mithic.syscall('process/exit', {code})` exits identically
   * to one that posts the `{type:'exit'}` lifecycle message. When no
   * `exitProcess` handler is wired, this is a harmless success (the guest's own
   * `guest.exit()` control-port path still drives teardown).
   */
  #processExit(pid: number, args: Record<string, unknown>): Record<string, never> {
    const code = Number(args.code ?? 0);
    this.#exitProcess?.(pid, code);
    return {};
  }

  #chdirCall(pid: number, args: Record<string, unknown>): { cwd: string } {
    if (!this.#chdir) {
      throw new FileSystemError('unsupported', 'process/chdir: no chdir handler configured');
    }
    const path = normalizePath(String(args.path ?? '/'));
    this.#chdir(pid, path);
    return { cwd: path };
  }

  /** pid -> set of its live (spawned, not-yet-waited) child pids. */
  #liveChildPids = new Map<number, Set<number>>();

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
  #ipcListen(pid: number, id: number, args: Record<string, unknown>): DispatchResult {
    if (!this.#ipc) {
      return res(fail(id, 'ENOSYS', 'ipc/listen unavailable: no IPC broker configured'));
    }
    const path = String(args.path ?? '');
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
  async #ipcAccept(pid: number, id: number, args: Record<string, unknown>): Promise<DispatchResult> {
    const fd = Number(args.fd);
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
  #ipcConnect(pid: number, id: number, args: Record<string, unknown>): DispatchResult {
    if (!this.#ipc) {
      return res(fail(id, 'ENOSYS', 'ipc/connect unavailable: no IPC broker configured'));
    }
    const path = String(args.path ?? '');
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

  #resolvePath(pid: number, args: Record<string, unknown>): string {
    const path = String(args.path ?? '');
    const dirfd = typeof args.dirfd === 'number' ? args.dirfd : AT_FDCWD;
    if (path.startsWith('/')) return normalizePath(path);
    // dirfd === AT_FDCWD (or unset): resolve relative to the process cwd.
    void dirfd;
    const cwd = this.#cwdOf(pid) || '/';
    return normalizePath(cwd.endsWith('/') ? cwd + path : cwd + '/' + path);
  }

  async #open(pid: number, args: Record<string, unknown>): Promise<{ fd: number }> {
    const absPath = this.#resolvePath(pid, args);
    const oflags = (args.oflags ?? {}) as OpenFlags;
    const op: FsOperation = needsWrite(oflags) ? 'write' : 'read';
    if (!this.#caps.checkFs(pid, absPath, op)) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    const handle = await this.#vfs.open(absPath, oflags);
    const fd = this.#allocFd(pid);
    this.#tableFor(pid).set(fd, { handle, offset: 0 });
    return { fd };
  }

  async #read(pid: number, args: Record<string, unknown>): Promise<Uint8Array> {
    const entry = this.#fdOf(pid, args);
    const len = Number(args.len ?? 0);
    const offset = typeof args.offset === 'number' ? args.offset : entry.offset;
    const data = await this.#vfs.read(entry.handle, offset, len);
    if (typeof args.offset !== 'number') entry.offset += data.byteLength;
    // Normalize views: if the VFS returned a subarray into a pooled buffer,
    // copy into a tight Uint8Array so the caller can safely transfer .buffer
    // without leaking pool bytes or using incorrect offsets.
    return toTightView(data);
  }

  async #write(pid: number, args: Record<string, unknown>): Promise<{ written: number }> {
    const entry = this.#fdOf(pid, args);
    const data = toBytes(args.data);
    const offset = typeof args.offset === 'number' ? args.offset : entry.offset;
    const written = await this.#vfs.write(entry.handle, data, offset);
    if (typeof args.offset !== 'number') entry.offset += written;
    return { written };
  }

  #close(pid: number, args: Record<string, unknown>): Record<string, never> {
    const fd = Number(args.fd);
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

  async #stat(pid: number, args: Record<string, unknown>): Promise<unknown> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'read')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    // `followSymlinks: false` requests lstat semantics (stat the link itself).
    const followSymlinks = args.followSymlinks !== false;
    const stat = await this.#vfs.stat(absPath, { followSymlinks });
    // Numbers cross the structured-clone boundary cleanly; BigInts in some
    // realms do not, so coerce size/linkCount the guest cares about.
    return { ...stat, size: Number(stat.size), linkCount: Number(stat.linkCount) };
  }

  async #readdir(pid: number, args: Record<string, unknown>): Promise<unknown> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'read')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    return await this.#vfs.readdir(absPath);
  }

  async #mkdir(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    await this.#vfs.mkdir(absPath);
    return {};
  }

  async #unlink(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    await this.#vfs.unlink(absPath);
    return {};
  }

  async #rmdir(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    await this.#vfs.rmdir(absPath);
    return {};
  }

  /**
   * `fs/rename {path, newPath}`: move/rename within the VFS. Requires write on
   * both the source (it is removed) and the destination (it is created).
   * `newPath` is resolved relative to the same cwd/dirfd rules as `path`.
   */
  async #rename(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const oldPath = this.#resolvePath(pid, args);
    const newPath = this.#resolvePath(pid, { ...args, path: args.newPath });
    if (!this.#caps.checkFs(pid, oldPath, 'write') || !this.#caps.checkFs(pid, newPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${oldPath} -> ${newPath}`);
    }
    await this.#vfs.rename(oldPath, newPath);
    return {};
  }

  /**
   * `fs/symlink {target, path}`: create a symlink at `path` pointing at the raw
   * `target` string (not resolved — symlink targets may be relative/dangling).
   * Requires write on the link path.
   */
  async #symlink(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const linkPath = this.#resolvePath(pid, args);
    const target = String(args.target ?? '');
    if (!this.#caps.checkFs(pid, linkPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${linkPath}`);
    }
    await this.#vfs.symlink(target, linkPath);
    return {};
  }

  async #readlink(pid: number, args: Record<string, unknown>): Promise<{ target: string }> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'read')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    const target = await this.#vfs.readlink(absPath);
    return { target };
  }

  /**
   * `fs/link {target, path}`: create a hard link at `path` to the existing
   * `target`. Requires read on the target and write on the new link path.
   */
  async #link(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const linkPath = this.#resolvePath(pid, args);
    const target = this.#resolvePath(pid, { ...args, path: args.target });
    if (!this.#caps.checkFs(pid, target, 'read') || !this.#caps.checkFs(pid, linkPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${target} -> ${linkPath}`);
    }
    await this.#vfs.link(target, linkPath);
    return {};
  }

  async #chmod(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    await this.#vfs.chmod(absPath, Number(args.mode ?? 0));
    return {};
  }

  /**
   * `fs/utimes {path, atime?, mtime?}`: set access/modification times. Times are
   * accepted as epoch milliseconds; omitted times default to "now". Requires
   * write on the path.
   */
  async #utimes(pid: number, args: Record<string, unknown>): Promise<Record<string, never>> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'write')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    const now = Date.now();
    const atime = new Date(typeof args.atime === 'number' ? args.atime : now);
    const mtime = new Date(typeof args.mtime === 'number' ? args.mtime : now);
    await this.#vfs.utimes(absPath, atime, mtime);
    return {};
  }

  /**
   * `fs/realpath {path}`: canonicalize a path (resolve symlinks). Requires read
   * on the path. Falls back to the normalized path when the provider does not
   * implement `realpath`.
   */
  async #realpath(pid: number, args: Record<string, unknown>): Promise<{ path: string }> {
    const absPath = this.#resolvePath(pid, args);
    if (!this.#caps.checkFs(pid, absPath, 'read')) {
      throw new FileSystemError('access', `Permission denied: ${absPath}`);
    }
    const resolved = this.#vfs.realpath ? await this.#vfs.realpath(absPath) : absPath;
    return { path: resolved };
  }

  #fdOf(pid: number, args: Record<string, unknown>): OpenFile {
    const fd = Number(args.fd);
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
  #domMutate(pid: number, args: Record<string, unknown>): Record<string, never> {
    if (!this.#onDomMutate) {
      throw new FileSystemError('unsupported', 'dom/mutate: no DOM handler configured');
    }
    const mutations = args.mutations;
    if (!Array.isArray(mutations)) {
      throw new FileSystemError('invalid', 'dom/mutate: mutations must be an array');
    }
    this.#onDomMutate(pid, mutations as DomMutation[]);
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
  async #netFetch(pid: number, id: number, args: Record<string, unknown>): Promise<SyscallResponse> {
    if (!this.#httpClient) {
      return fail(id, 'ENOSYS', 'net/fetch: no HTTP client configured');
    }
    const url = String(args.url ?? '');
    // Capability gate FIRST — before any network access. An ungranted origin
    // (or an unparseable URL, which checkNet rejects) is EACCES.
    if (!this.#caps.checkNet(pid, url)) {
      return fail(id, 'EACCES', `Permission denied: ${url}`);
    }
    const request: HttpRequest = {
      method: typeof args.method === 'string' ? args.method : 'GET',
      url,
      headers: normalizeHeaders(args.headers),
    };
    const body = args.body;
    if (body instanceof Uint8Array) request.body = body;
    else if (body instanceof ArrayBuffer) request.body = new Uint8Array(body);
    else if (typeof body === 'string') request.body = new TextEncoder().encode(body);
    if (typeof args.timeoutMs === 'number') request.timeoutMs = args.timeoutMs;

    let response: HttpResponse;
    try {
      response = await this.#httpClient.send(request);
    } catch (err) {
      // Transport-level failure (DNS, connection refused, timeout): the request
      // was authorized but could not complete. Map to a network errno.
      return fail(id, 'EHOSTUNREACH', messageOf(err));
    }
    const result: { status: number; headers: [string, string][]; body?: Uint8Array } = {
      status: response.status,
      headers: response.headers,
    };
    if (response.body) result.body = toTightView(response.body);
    return ok(id, result);
  }
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

/** Coerce raw syscall args into a validated {@link SpawnArgs}, or undefined. */
function normalizeSpawnArgs(args: Record<string, unknown>): SpawnArgs | undefined {
  const path = typeof args.path === 'string' ? args.path : undefined;
  const argv = Array.isArray(args.argv) ? args.argv.map(String) : undefined;
  if (path === undefined || argv === undefined) return undefined;
  const out: SpawnArgs = { path, argv };
  if (args.env && typeof args.env === 'object') out.env = args.env as Record<string, string>;
  if (typeof args.cwd === 'string') out.cwd = args.cwd;
  if (args.fds && typeof args.fds === 'object') out.fds = args.fds as SpawnArgs['fds'];
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
 * Return `view` if it already spans its entire backing buffer; otherwise copy
 * into a fresh tight `Uint8Array`. This ensures the caller can safely transfer
 * `.buffer` over `postMessage` without clobbering pooled buffers or sending
 * wrong bytes when `byteOffset > 0`.
 */
function toTightView(view: Uint8Array): Uint8Array {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view;
  return new Uint8Array(view);
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
