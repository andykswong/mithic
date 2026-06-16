import type { SyscallResponse, ErrnoCode } from '@mithic/protocol';
import { fsErrorToErrno } from '@mithic/protocol';
import { FileSystemError, normalizePath } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';
import type { IpcBroker } from './ipc-broker.ts';
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

export interface SyscallDispatcherOptions {
  vfs: FileSystemProvider;
  caps: CapabilityManager;
  /** Resolve a process's current working directory. */
  cwdOf: (pid: number) => string;
  /** IPC broker used to mint pipes for the `fs/pipe` syscall. Optional for fs-only setups. */
  ipc?: IpcBroker;
  /**
   * Optional handler for `dom/mutate` syscalls from guest processes.
   * When set, the kernel forwards batched DomMutation records from the guest
   * to this handler which routes them to the appropriate RemoteDomHost.
   * When unset, `dom/mutate` returns ENOSYS.
   */
  onDomMutate?: DomMutateHandler;
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
  #onDomMutate: DomMutateHandler | undefined;
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
    this.#onDomMutate = options.onDomMutate;
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

  async dispatch(pid: number, req: SyscallRequestLike): Promise<DispatchResult> {
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
    const stat = await this.#vfs.stat(absPath);
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
