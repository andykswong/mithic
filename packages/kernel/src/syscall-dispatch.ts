import type { SyscallResponse, ErrnoCode } from '@mithic/protocol';
import { fsErrorToErrno } from '@mithic/protocol';
import { FileSystemError, normalizePath } from '@mithic/io/vfs';
import type { FileSystemProvider, FileHandle, OpenFlags } from '@mithic/io/vfs';
import type { CapabilityManager, FsOperation } from './capability-manager.ts';

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
}

interface OpenFile {
  handle: FileHandle;
  offset: number;
}

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
  /** pid -> (fd -> open file). */
  #fdTables = new Map<number, Map<number, OpenFile>>();
  /** pid -> next fd to allocate (file fds start above the reserved stdio range). */
  #nextFd = new Map<number, number>();

  constructor(options: SyscallDispatcherOptions) {
    this.#vfs = options.vfs;
    this.#caps = options.caps;
    this.#cwdOf = options.cwdOf;
  }

  /** Discard a process's fd table (called on process exit). */
  closeProcess(pid: number): void {
    this.#fdTables.delete(pid);
    this.#nextFd.delete(pid);
  }

  async dispatch(pid: number, req: SyscallRequestLike): Promise<SyscallResponse> {
    try {
      switch (req.call) {
        case 'fs/open':
          return ok(req.id, await this.#open(pid, req.args));
        case 'fs/read':
          return ok(req.id, await this.#read(pid, req.args));
        case 'fs/write':
          return ok(req.id, await this.#write(pid, req.args));
        case 'fs/close':
          return ok(req.id, this.#close(pid, req.args));
        case 'fs/stat':
          return ok(req.id, await this.#stat(pid, req.args));
        case 'fs/readdir':
          return ok(req.id, await this.#readdir(pid, req.args));
        case 'fs/mkdir':
          return ok(req.id, await this.#mkdir(pid, req.args));
        case 'fs/unlink':
          return ok(req.id, await this.#unlink(pid, req.args));
        default:
          return fail(req.id, 'ENOSYS', `Unknown syscall: ${req.call}`);
      }
    } catch (err) {
      return fail(req.id, errnoOf(err), messageOf(err));
    }
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
    return data;
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
    if (!entry) throw new FileSystemError('invalid', `Bad file descriptor: ${fd}`);
    void this.#vfs.close(entry.handle);
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
    if (!entry) throw new FileSystemError('invalid', `Bad file descriptor: ${fd}`);
    return entry;
  }

  #tableFor(pid: number): Map<number, OpenFile> {
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
  if (err instanceof FileSystemError) return fsErrorToErrno(err.code);
  return 'EIO';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ok(id: number, result: unknown): SyscallResponse {
  return { id, ok: true, result };
}

function fail(id: number, code: ErrnoCode, message: string): SyscallResponse {
  return { id, ok: false, error: { code, message } };
}
