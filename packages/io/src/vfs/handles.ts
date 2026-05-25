import type { FileStat } from './provider.ts';
import { FileSystemError } from './provider.ts';
import type { FileSystemRouter } from './router.ts';

type FileSystemHandle = VFSDirectoryHandle | VFSFileHandle;

class VFSAsyncIterator<T> implements FileSystemDirectoryHandleAsyncIterator<T> {
  #items: Promise<T[]>;
  #resolved: T[] | null = null;
  #index = 0;

  constructor(items: Promise<T[]> | T[]) {
    this.#items = Array.isArray(items) ? Promise.resolve(items) : items;
  }

  async next(): Promise<IteratorResult<T>> {
    if (!this.#resolved) {
      this.#resolved = await this.#items;
    }
    if (this.#index >= this.#resolved.length) {
      return { done: true, value: undefined };
    }
    return { done: false, value: this.#resolved[this.#index++] };
  }

  async return(value?: unknown): Promise<IteratorResult<T>> {
    this.#resolved = null;
    this.#index = Infinity;
    return { done: true, value: value as T };
  }

  async throw(e?: unknown): Promise<IteratorResult<T>> {
    this.#resolved = null;
    this.#index = Infinity;
    throw e;
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<T> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#resolved = null;
    this.#index = Infinity;
  }
}

/**
 * VFS-backed FileSystemDirectoryHandle implementation.
 * Provides Web File System API surface backed by the VFS FileSystemRouter.
 */
export class VFSDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  #router: FileSystemRouter;
  #path: string;

  constructor(router: FileSystemRouter, path: string) {
    this.#router = router;
    this.#path = path;
    const parts = path.split('/').filter(p => p !== '');
    this.name = parts.length > 0 ? parts[parts.length - 1] : '';
  }

  /** Get the absolute VFS path of this handle. */
  getPath(): string { return this.#path; }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<VFSFileHandle> {
    const childPath = this.#childPath(name);
    const create = options?.create ?? false;

    if (!create) {
      // Verify file exists
      try {
        const stat = await this.#router.stat(childPath);
        if (stat.type === 'directory') {
          throw new DOMException(
            `"${name}" is a directory`,
            'TypeMismatchError'
          );
        }
      } catch (e) {
        if (e instanceof FileSystemError && e.code === 'not-found') {
          throw new DOMException(
            `A requested file or directory could not be found: "${name}"`,
            'NotFoundError'
          );
        }
        throw e;
      }
    } else {
      // Create if not exists
      try {
        const stat = await this.#router.stat(childPath);
        if (stat.type === 'directory') {
          throw new DOMException(
            `"${name}" is a directory`,
            'TypeMismatchError'
          );
        }
      } catch (e) {
        if (e instanceof FileSystemError && e.code === 'not-found') {
          // Create the file
          const handle = await this.#router.open(childPath, { create: true, write: true });
          await this.#router.close(handle);
        } else {
          throw e;
        }
      }
    }

    return new VFSFileHandle(this.#router, childPath);
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<VFSDirectoryHandle> {
    const childPath = this.#childPath(name);
    const create = options?.create ?? false;

    if (!create) {
      try {
        const stat = await this.#router.stat(childPath);
        if (stat.type !== 'directory') {
          throw new DOMException(
            `"${name}" is not a directory`,
            'TypeMismatchError'
          );
        }
      } catch (e) {
        if (e instanceof FileSystemError && e.code === 'not-found') {
          throw new DOMException(
            `A requested file or directory could not be found: "${name}"`,
            'NotFoundError'
          );
        }
        throw e;
      }
    } else {
      try {
        const stat = await this.#router.stat(childPath);
        if (stat.type !== 'directory') {
          throw new DOMException(
            `"${name}" is not a directory`,
            'TypeMismatchError'
          );
        }
      } catch (e) {
        if (e instanceof FileSystemError && e.code === 'not-found') {
          await this.#router.mkdir(childPath);
        } else {
          throw e;
        }
      }
    }

    return new VFSDirectoryHandle(this.#router, childPath);
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const childPath = this.#childPath(name);
    try {
      const stat = await this.#router.stat(childPath);
      if (stat.type === 'directory') {
        if (options?.recursive) {
          await this.#removeRecursive(childPath);
        } else {
          await this.#router.rmdir(childPath);
        }
      } else {
        await this.#router.unlink(childPath);
      }
    } catch (e) {
      if (e instanceof FileSystemError && e.code === 'not-found') {
        throw new DOMException(
          `A requested file or directory could not be found: "${name}"`,
          'NotFoundError'
        );
      }
      throw e;
    }
  }

  async resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null> {
    // Get the path of the descendant
    let descendantPath: string | undefined;
    if (possibleDescendant instanceof VFSFileHandle) {
      descendantPath = (possibleDescendant as VFSFileHandle | VFSDirectoryHandle).getPath();
    } else if (possibleDescendant instanceof VFSDirectoryHandle) {
      descendantPath = (possibleDescendant as VFSFileHandle | VFSDirectoryHandle).getPath();
    }

    if (descendantPath === undefined) {
      return null;
    }

    const normalized = this.#normalizePath(this.#path);
    const normalizedDesc = this.#normalizePath(descendantPath);

    if (normalizedDesc === normalized) {
      return [];
    }

    const prefix = normalized === '/' ? '/' : normalized + '/';
    if (!normalizedDesc.startsWith(prefix)) {
      return null;
    }

    const relative = normalizedDesc.slice(prefix.length);
    return relative.split('/');
  }

  entries(): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    const router = this.#router;
    const path = this.#path;
    const childPath = this.#childPath.bind(this);

    const items = router.readdir(path).then(dirEntries =>
      dirEntries.map(entry => {
        const cp = childPath(entry.name);
        const handle: FileSystemDirectoryHandle | FileSystemFileHandle = entry.type === 'directory'
          ? new VFSDirectoryHandle(router, cp)
          : new VFSFileHandle(router, cp);
        return [entry.name, handle] as [string, FileSystemDirectoryHandle | FileSystemFileHandle];
      })
    );
    return new VFSAsyncIterator(items);
  }

  keys(): FileSystemDirectoryHandleAsyncIterator<string> {
    const router = this.#router;
    const path = this.#path;
    const items = router.readdir(path).then(entries => entries.map(e => e.name));
    return new VFSAsyncIterator(items);
  }

  values(): FileSystemDirectoryHandleAsyncIterator<FileSystemDirectoryHandle | FileSystemFileHandle> {
    const router = this.#router;
    const path = this.#path;
    const childPath = this.#childPath.bind(this);

    const items = router.readdir(path).then(dirEntries =>
      dirEntries.map(entry => {
        const cp = childPath(entry.name);
        return (entry.type === 'directory'
          ? new VFSDirectoryHandle(router, cp)
          : new VFSFileHandle(router, cp)) as FileSystemDirectoryHandle | FileSystemFileHandle;
      })
    );
    return new VFSAsyncIterator(items);
  }

  [Symbol.asyncIterator](): FileSystemDirectoryHandleAsyncIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]> {
    return this.entries();
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    if (other instanceof VFSDirectoryHandle) {
      return this.#normalizePath(this.#path) === this.#normalizePath((other as VFSFileHandle | VFSDirectoryHandle).getPath());
    }
    return false;
  }

  // --- Non-standard extensions ---

  async stat(): Promise<FileStat> {
    return this.#router.stat(this.#path);
  }

  async chmod(mode: number): Promise<void> {
    await this.#router.chmod(this.#path, mode);
  }

  /** Expose path for resolve() */
  get path(): string {
    return this.#path;
  }

  // --- Private ---

  #childPath(name: string): string {
    if (this.#path === '/') return '/' + name;
    return this.#path + '/' + name;
  }

  #normalizePath(path: string): string {
    if (!path || path === '/') return '/';
    if (!path.startsWith('/')) path = '/' + path;
    const parts = path.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') resolved.pop();
      else resolved.push(part);
    }
    return '/' + resolved.join('/');
  }

  async #removeRecursive(path: string): Promise<void> {
    const entries = await this.#router.readdir(path);
    for (const entry of entries) {
      const childPath = path === '/' ? '/' + entry.name : path + '/' + entry.name;
      if (entry.type === 'directory') {
        await this.#removeRecursive(childPath);
      } else {
        await this.#router.unlink(childPath);
      }
    }
    await this.#router.rmdir(path);
  }
}

/**
 * VFS-backed FileSystemFileHandle implementation.
 * Provides Web File System API surface backed by the VFS FileSystemRouter.
 */
export class VFSFileHandle implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  #router: FileSystemRouter;
  #path: string;

  constructor(router: FileSystemRouter, path: string) {
    this.#router = router;
    this.#path = path;
    const parts = path.split('/').filter(p => p !== '');
    this.name = parts.length > 0 ? parts[parts.length - 1] : '';
  }

  /** Get the absolute VFS path of this handle. */
  getPath(): string { return this.#path; }

  async getFile(): Promise<File> {
    // Read the full file content
    const handle = await this.#router.open(this.#path, { read: true });
    try {
      const stat = await this.#router.stat(this.#path);
      const size = Number(stat.size);
      const data = await this.#router.read(handle, 0, size);
      return new File([data as unknown as BlobPart], this.name, {
        lastModified: stat.mtime.getTime(),
      });
    } finally {
      await this.#router.close(handle);
    }
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    const keepExistingData = options?.keepExistingData ?? false;

    // Get existing data if needed
    let existingData: Uint8Array = new Uint8Array(0);
    if (keepExistingData) {
      try {
        const handle = await this.#router.open(this.#path, { read: true });
        const stat = await this.#router.stat(this.#path);
        existingData = await this.#router.read(handle, 0, Number(stat.size));
        await this.#router.close(handle);
      } catch {
        // File may not exist yet
      }
    }

    const router = this.#router;
    const filePath = this.#path;
    let buffer = existingData;
    let position = 0;

    const writable = new WritableStream<FileSystemWriteChunkType>({
      write(chunk) {
        if (chunk instanceof ArrayBuffer || chunk instanceof Uint8Array || typeof chunk === 'string') {
          const data = typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : chunk instanceof ArrayBuffer
              ? new Uint8Array(chunk)
              : chunk;
          const needed = position + data.length;
          if (needed > buffer.length) {
            const newBuf = new Uint8Array(needed);
            newBuf.set(buffer);
            buffer = newBuf;
          }
          buffer.set(data instanceof Uint8Array ? data : new Uint8Array(data), position);
          position += data.length;
        } else if (chunk && typeof chunk === 'object') {
          const writeParams = chunk as { type: string; data?: Uint8Array | string; position?: number; size?: number };
          if (writeParams.type === 'write') {
            if (writeParams.position !== undefined) {
              position = writeParams.position;
            }
            const data = typeof writeParams.data === 'string'
              ? new TextEncoder().encode(writeParams.data)
              : writeParams.data instanceof ArrayBuffer
                ? new Uint8Array(writeParams.data)
                : writeParams.data instanceof Uint8Array
                  ? writeParams.data
                  : new Uint8Array(0);
            const needed = position + data.length;
            if (needed > buffer.length) {
              const newBuf = new Uint8Array(needed);
              newBuf.set(buffer);
              buffer = newBuf;
            }
            buffer.set(data, position);
            position += data.length;
          } else if (writeParams.type === 'seek') {
            if (writeParams.position !== undefined) {
              position = writeParams.position;
            }
          } else if (writeParams.type === 'truncate') {
            if (writeParams.size !== undefined) {
              if (writeParams.size < buffer.length) {
                buffer = buffer.slice(0, writeParams.size);
              } else if (writeParams.size > buffer.length) {
                const newBuf = new Uint8Array(writeParams.size);
                newBuf.set(buffer);
                buffer = newBuf;
              }
              if (position > writeParams.size) {
                position = writeParams.size;
              }
            }
          }
        }
      },
      async close() {
        // Flush buffer to the VFS
        const handle = await router.open(filePath, { create: true, write: true, truncate: true });
        await router.write(handle, buffer, 0);
        await router.close(handle);
      },
    });

    return writable as unknown as FileSystemWritableFileStream;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    if (other instanceof VFSFileHandle) {
      return this.#normalizePath(this.#path) === this.#normalizePath((other as VFSFileHandle | VFSDirectoryHandle).getPath());
    }
    return false;
  }

  // --- Non-standard extensions ---

  async stat(): Promise<FileStat> {
    return this.#router.stat(this.#path);
  }

  async chmod(mode: number): Promise<void> {
    await this.#router.chmod(this.#path, mode);
  }

  async utimes(atime: Date, mtime: Date): Promise<void> {
    await this.#router.utimes(this.#path, atime, mtime);
  }

  /** Expose path for resolve() */
  get path(): string {
    return this.#path;
  }

  // --- Private ---

  #normalizePath(path: string): string {
    if (!path || path === '/') return '/';
    if (!path.startsWith('/')) path = '/' + path;
    const parts = path.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') resolved.pop();
      else resolved.push(part);
    }
    return '/' + resolved.join('/');
  }
}
