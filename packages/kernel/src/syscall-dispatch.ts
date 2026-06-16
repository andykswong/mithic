import type { SyscallResponse, ErrnoCode } from '@mithic/protocol';
import { fsErrorToErrno } from '@mithic/protocol';
import { FileSystemError, normalizePath } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';
import type { IpcBroker } from './ipc-broker.ts';

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

export interface SyscallRequestLike {
  id: number;
  call: string;
  args: Record<string, unknown>;
}

export interface SyscallDispatcherOptions {
  vfs: FileSystemProvider;
  caps: CapabilityManager;
  /** Resolve a process's current working directory. */
  cwdOf: (pid: number) => string;
  /** IPC broker used to mint pipes for the `fs/pipe` syscall. Optional for fs-only setups. */
  ipc?: IpcBroker;
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

type FdEntry = OpenFile | PipeFd;

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
  /** pid -> (fd -> open file or pipe end). */
  #fdTables = new Map<number, Map<number, FdEntry>>();
  /** pid -> next fd to allocate (file fds start above the reserved stdio range). */
  #nextFd = new Map<number, number>();

  constructor(options: SyscallDispatcherOptions) {
    this.#vfs = options.vfs;
    this.#caps = options.caps;
    this.#cwdOf = options.cwdOf;
    this.#ipc = options.ipc;
  }

  /** Discard a process's fd table (called on process exit). */
  closeProcess(pid: number): void {
    this.#fdTables.delete(pid);
    this.#nextFd.delete(pid);
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
    // Pipe fds: the guest owns the transferred port, so the kernel just forgets
    // the fd. File fds: release the VFS handle.
    if (entry.kind !== 'pipe') void this.#vfs.close(entry.handle);
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
    // Pipe fds are serviced by the guest over the transferred port, not via the
    // dispatcher's read/write path. A read/write syscall against one is a bug.
    if (entry.kind === 'pipe') throw new BadFdError(fd);
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
