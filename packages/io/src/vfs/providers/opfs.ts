import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat } from '../provider.ts';
import { FileSystemError } from '../provider.ts';
import { MetadataStore } from '../metadata-store.ts';

const META_FILE = '.mithic-meta.json';

export interface OPFSStorageManager {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

export class OPFSProvider implements FileSystemProvider {
  #root: FileSystemDirectoryHandle | null = null;
  #storage: OPFSStorageManager;
  #nextFd = 3;
  #handles = new Map<number, { nativeHandle: FileSystemFileHandle; path: string; flags: OpenFlags }>();
  #meta: MetadataStore;

  constructor(storage?: OPFSStorageManager) {
    this.#storage = storage ?? navigator.storage;
    this.#meta = new MetadataStore({
      load: async () => {
        try {
          const handle = await this.#root!.getFileHandle(META_FILE);
          return await (await handle.getFile()).text();
        } catch {
          return undefined;
        }
      },
      flush: async (json) => {
        const handle = await this.#root!.getFileHandle(META_FILE, { create: true });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
      },
    });
  }

  async init(): Promise<void> {
    this.#root = await this.#storage.getDirectory();
    await this.#meta.load();
  }

  async dispose(): Promise<void> {
    this.#handles.clear();
    this.#root = null;
  }

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);

    if (flags.directory) {
      const dir = await this.#getDirectoryHandle(normalized);
      if (!dir) {
        throw new FileSystemError('not-directory', `Not a directory: ${path}`);
      }
      const fd = this.#nextFd++;
      return { fd, path: normalized, flags };
    }

    const { dir: parentPath, base } = this.#splitPath(normalized);
    const parentDir = await this.#getDirectoryHandle(parentPath);
    if (!parentDir) {
      throw new FileSystemError('no-entry', `Parent directory not found: ${parentPath}`);
    }

    if (flags.exclusive && flags.create) {
      // Check if file already exists
      try {
        await parentDir.getFileHandle(base);
        throw new FileSystemError('exist', `File already exists: ${path}`);
      } catch (e) {
        if (e instanceof FileSystemError) throw e;
        // NotFoundError means file doesn't exist — proceed to create
      }
    }

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await parentDir.getFileHandle(base, { create: flags.create });
    } catch (e: unknown) {
      if ((e as DOMException)?.name === 'NotFoundError') {
        throw new FileSystemError('no-entry', `File not found: ${path}`);
      }
      if ((e as DOMException)?.name === 'TypeMismatchError') {
        throw new FileSystemError('is-directory', `Is a directory: ${path}`);
      }
      throw e;
    }

    if (flags.truncate) {
      const writable = await fileHandle.createWritable();
      await writable.truncate(0);
      await writable.close();
    }

    const fd = this.#nextFd++;
    this.#handles.set(fd, { nativeHandle: fileHandle, path: normalized, flags });
    return { fd, path: normalized, flags };
  }

  async close(handle: FileHandle): Promise<void> {
    if (!this.#handles.has(handle.fd)) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    this.#handles.delete(handle.fd);
  }

  async read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const file = await openHandle.nativeHandle.getFile();
    const blob = file.slice(offset, offset + len);
    const buffer = await blob.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const writeOffset = openHandle.flags.append
      ? (await openHandle.nativeHandle.getFile()).size
      : offset;
    const writable = await openHandle.nativeHandle.createWritable({ keepExistingData: true });
    await writable.seek(writeOffset);
    await writable.write(data as unknown as FileSystemWriteChunkType);
    await writable.close();
    return data.length;
  }

  async truncate(handle: FileHandle, size: number): Promise<void> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const writable = await openHandle.nativeHandle.createWritable({ keepExistingData: true });
    await writable.truncate(size);
    await writable.close();
  }

  async stat(path: string, _options?: { followSymlinks?: boolean }): Promise<FileStat> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);

    // Check if it's a directory
    const dirHandle = await this.#getDirectoryHandle(normalized);
    if (dirHandle) {
      return {
        type: 'directory',
        size: 0n,
        mode: 0o755,
        mtime: new Date(0),
        atime: new Date(0),
        ctime: new Date(0),
        linkCount: 1n,
      };
    }

    // Try as a file
    const { dir: parentPath, base } = this.#splitPath(normalized);
    const parentDir = await this.#getDirectoryHandle(parentPath);
    if (!parentDir) {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }

    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await parentDir.getFileHandle(base);
    } catch {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }

    const file = await fileHandle.getFile();
    const meta = await this.#meta.getMeta(normalized);
    return {
      type: 'file',
      size: BigInt(file.size),
      mode: meta?.mode ?? 0o644,
      mtime: new Date(meta?.mtime ?? file.lastModified),
      atime: new Date(meta?.atime ?? file.lastModified),
      ctime: new Date(meta?.mtime ?? file.lastModified),
      linkCount: 1n,
    };
  }

  async readdir(path: string): Promise<DirEntry[]> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    const dirHandle = await this.#getDirectoryHandle(normalized);
    if (!dirHandle) {
      throw new FileSystemError('not-directory', `Not a directory: ${path}`);
    }

    const atRoot = normalized === '/';
    const entries: DirEntry[] = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (atRoot && name === META_FILE) continue;
      entries.push({
        name,
        type: handle.kind === 'file' ? 'file' : 'directory',
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  async mkdir(path: string): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    const { dir: parentPath, base } = this.#splitPath(normalized);
    const parentDir = await this.#getDirectoryHandle(parentPath);
    if (!parentDir) {
      throw new FileSystemError('no-entry', `Parent directory not found: ${parentPath}`);
    }

    // Check if already exists
    try {
      await parentDir.getDirectoryHandle(base);
      throw new FileSystemError('exist', `Already exists: ${path}`);
    } catch (e) {
      if (e instanceof FileSystemError) throw e;
      // NotFoundError means we can create it
    }

    await parentDir.getDirectoryHandle(base, { create: true });
  }

  async unlink(path: string): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    const { dir: parentPath, base } = this.#splitPath(normalized);
    const parentDir = await this.#getDirectoryHandle(parentPath);
    if (!parentDir) {
      throw new FileSystemError('no-entry', `Parent directory not found: ${parentPath}`);
    }

    try {
      await parentDir.removeEntry(base);
    } catch (e: unknown) {
      if ((e as DOMException)?.name === 'NotFoundError') {
        throw new FileSystemError('no-entry', `No such file: ${path}`);
      }
      throw e;
    }
    await this.#meta.drop(normalized);
  }

  async rmdir(path: string): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    const { dir: parentPath, base } = this.#splitPath(normalized);
    const parentDir = await this.#getDirectoryHandle(parentPath);
    if (!parentDir) {
      throw new FileSystemError('no-entry', `Parent directory not found: ${parentPath}`);
    }

    try {
      await parentDir.removeEntry(base);
    } catch (e: unknown) {
      if ((e as DOMException)?.name === 'NotFoundError') {
        throw new FileSystemError('no-entry', `No such directory: ${path}`);
      }
      if ((e as DOMException)?.name === 'InvalidModificationError') {
        throw new FileSystemError('not-empty', `Directory not empty: ${path}`);
      }
      throw e;
    }
    await this.#meta.dropSubtree(normalized);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    this.#ensureInit();
    const oldNormalized = this.#normalizePath(oldPath);
    const newNormalized = this.#normalizePath(newPath);

    // OPFS doesn't have a native rename; we have to copy + delete
    const { dir: oldParentPath, base: oldBase } = this.#splitPath(oldNormalized);
    const { dir: newParentPath, base: newBase } = this.#splitPath(newNormalized);

    const oldParent = await this.#getDirectoryHandle(oldParentPath);
    const newParent = await this.#getDirectoryHandle(newParentPath);
    if (!oldParent || !newParent) {
      throw new FileSystemError('no-entry', 'Parent directory not found');
    }

    let sourceFile: FileSystemFileHandle | undefined;
    try {
      sourceFile = await oldParent.getFileHandle(oldBase);
    } catch {
      sourceFile = undefined;
    }

    if (sourceFile) {
      const file = await sourceFile.getFile();
      const data = new Uint8Array(await file.arrayBuffer());
      const destHandle = await newParent.getFileHandle(newBase, { create: true });
      const writable = await destHandle.createWritable();
      await writable.write(data);
      await writable.close();
      await oldParent.removeEntry(oldBase);
    } else {
      const sourceDir = await this.#getDirectoryHandle(oldNormalized);
      if (!sourceDir) {
        throw new FileSystemError('no-entry', `No such file or directory: ${oldPath}`);
      }
      const destDir = await newParent.getDirectoryHandle(newBase, { create: true });
      await this.#copyDirectory(sourceDir, destDir);
      await oldParent.removeEntry(oldBase, { recursive: true });
    }

    await this.#meta.rename(oldNormalized, newNormalized);
  }

  async #copyDirectory(src: FileSystemDirectoryHandle, dest: FileSystemDirectoryHandle): Promise<void> {
    for await (const [name, handle] of src.entries()) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        const destFile = await dest.getFileHandle(name, { create: true });
        const writable = await destFile.createWritable();
        await writable.write(data);
        await writable.close();
      } else {
        const childSrc = handle as FileSystemDirectoryHandle;
        const childDest = await dest.getDirectoryHandle(name, { create: true });
        await this.#copyDirectory(childSrc, childDest);
      }
    }
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new FileSystemError('unsupported', 'OPFS does not support symlinks');
  }

  async readlink(_path: string): Promise<string> {
    throw new FileSystemError('unsupported', 'OPFS does not support symlinks');
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new FileSystemError('unsupported', 'OPFS does not support hard links');
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    await this.#meta.setMode(normalized, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    await this.#meta.setTimes(normalized, atime.getTime(), mtime.getTime());
  }

  async getxattr(path: string, name: string): Promise<Uint8Array | undefined> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    return this.#meta.getxattr(normalized, name);
  }

  async setxattr(path: string, name: string, value: Uint8Array): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    await this.#meta.setxattr(normalized, name, value);
  }

  async listxattr(path: string): Promise<string[]> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    return this.#meta.listxattr(normalized);
  }

  async removexattr(path: string, name: string): Promise<void> {
    this.#ensureInit();
    const normalized = this.#normalizePath(path);
    await this.#requireExists(normalized, path);
    await this.#meta.removexattr(normalized, name);
  }

  async #requireExists(normalized: string, original: string): Promise<void> {
    const { dir, base } = this.#splitPath(normalized);
    const parent = await this.#getDirectoryHandle(dir);
    if (!parent) throw new FileSystemError('no-entry', `No such file or directory: ${original}`);
    try {
      await parent.getFileHandle(base);
    } catch {
      if (!(await this.#getDirectoryHandle(normalized))) {
        throw new FileSystemError('no-entry', `No such file or directory: ${original}`);
      }
    }
  }

  async mkfifo(_path: string): Promise<void> {
    throw new FileSystemError('unsupported', 'OPFS does not support mkfifo');
  }

  // --- Private helpers ---

  #ensureInit(): asserts this is { '#root': FileSystemDirectoryHandle } {
    if (!this.#root) {
      throw new FileSystemError('invalid', 'OPFSProvider not initialized. Call init() first.');
    }
  }

  #normalizePath(path: string): string {
    if (!path || path === '/') return '/';
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    const parts = path.split('/');
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }
    const normalized = '/' + resolved.join('/');

    // The mount-root metadata sidecar is provider-internal: it backs every
    // file's mode + xattr store. Reject it as an ordinary VFS path so a process
    // cannot open/stat/rename/unlink it and forge another file's capability
    // grant. It stays indistinguishable from a non-existent file. A file named
    // META_FILE in a subdirectory is a normal, usable file.
    if (normalized === '/' + META_FILE) {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }

    return normalized;
  }

  #splitPath(path: string): { dir: string; base: string } {
    if (path === '/') return { dir: '/', base: '' };
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash === 0 ? '/' : path.slice(0, lastSlash);
    const base = path.slice(lastSlash + 1);
    return { dir, base };
  }

  async #getDirectoryHandle(path: string): Promise<FileSystemDirectoryHandle | null> {
    if (path === '/') return this.#root!;
    const parts = path.split('/').filter(p => p !== '');
    let current: FileSystemDirectoryHandle = this.#root!;
    for (const part of parts) {
      try {
        current = await current.getDirectoryHandle(part);
      } catch {
        return null;
      }
    }
    return current;
  }
}
