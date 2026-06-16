import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat } from '../provider.ts';
import { FileSystemError } from '../provider.ts';

/** In-memory file entry. */
interface MemFileEntry {
  type: 'file';
  source: Uint8Array;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
}

/** In-memory directory entry. */
interface MemDirectoryEntry {
  type: 'directory';
  children: Map<string, MemEntry>;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
}

/** In-memory symlink entry. */
interface MemSymlinkEntry {
  type: 'symlink';
  target: string;
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
}

/** In-memory FIFO (named pipe) entry. */
interface MemFifoEntry {
  type: 'fifo';
  buffer: Uint8Array[];
  mode: number;
  mtime: Date;
  atime: Date;
  ctime: Date;
}

type MemEntry = MemFileEntry | MemDirectoryEntry | MemSymlinkEntry | MemFifoEntry;

/** Options for constructing a MemoryFsProvider. */
export interface MemoryProviderOptions {
  files?: Record<string, string | Uint8Array | { content: string | Uint8Array; mode?: number; mtime?: Date }>;
}

interface OpenFileHandle {
  entry: MemFileEntry | MemFifoEntry;
  path: string;
  flags: OpenFlags;
}

const MAX_SYMLINK_DEPTH = 40;
const encoder = new TextEncoder();

/**
 * In-memory filesystem provider with full Unix semantics.
 */
export class MemoryFsProvider implements FileSystemProvider {
  private root: MemDirectoryEntry;
  private handles = new Map<number, OpenFileHandle>();
  private nextFd = 3; // 0, 1, 2 reserved for stdio

  constructor(options?: MemoryProviderOptions) {
    const now = new Date();
    this.root = {
      type: 'directory',
      children: new Map(),
      mode: 0o755,
      mtime: now,
      atime: now,
      ctime: now,
    };

    if (options?.files) {
      for (const [path, value] of Object.entries(options.files)) {
        let content: Uint8Array;
        let mode = 0o644;
        let mtime = now;

        if (typeof value === 'string') {
          content = encoder.encode(value);
        } else if (value instanceof Uint8Array) {
          content = value;
        } else {
          content = typeof value.content === 'string' ? encoder.encode(value.content) : value.content;
          if (value.mode !== undefined) mode = value.mode;
          if (value.mtime !== undefined) mtime = value.mtime;
        }

        this.createFileAt(path, content, mode, mtime);
      }
    }
  }

  init(): void {}
  dispose(): void {}

  open(path: string, flags: OpenFlags): FileHandle {
    const normalized = this.normalizePath(path);

    if (flags.directory) {
      // Verify that path is a directory
      const entry = this.resolveEntry(normalized, true);
      if (!entry || entry.type !== 'directory') {
        throw new FileSystemError('not-directory', `Not a directory: ${path}`);
      }
      const fd = this.nextFd++;
      return { fd, path: normalized, flags };
    }

    let entry = this.resolveEntry(normalized, true);

    if (entry && flags.exclusive && flags.create) {
      throw new FileSystemError('exist', `File already exists: ${path}`);
    }

    if (!entry) {
      if (!flags.create) {
        throw new FileSystemError('no-entry', `File not found: ${path}`);
      }
      // Create the file — parent must exist
      const { dir, base } = this.splitPath(normalized);
      const parent = this.resolveEntry(dir, true);
      if (!parent || parent.type !== 'directory') {
        throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
      }
      const now = new Date();
      const newFile: MemFileEntry = {
        type: 'file',
        source: new Uint8Array(0),
        mode: 0o644,
        mtime: now,
        atime: now,
        ctime: now,
      };
      parent.children.set(base, newFile);
      parent.mtime = now;
      entry = newFile;
    }

    if (entry.type === 'directory') {
      throw new FileSystemError('is-directory', `Is a directory: ${path}`);
    }

    if (entry.type !== 'file' && entry.type !== 'fifo') {
      throw new FileSystemError('invalid', `Cannot open non-file: ${path}`);
    }

    if (flags.truncate && entry.type === 'file') {
      entry.source = new Uint8Array(0);
      entry.mtime = new Date();
      entry.ctime = new Date();
    }

    const fd = this.nextFd++;
    this.handles.set(fd, { entry, path: normalized, flags });
    return { fd, path: normalized, flags };
  }

  close(handle: FileHandle): void {
    if (!this.handles.has(handle.fd)) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    this.handles.delete(handle.fd);
  }

  read(handle: FileHandle, offset: number, len: number): Uint8Array {
    const openHandle = this.handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const { entry } = openHandle;
    entry.atime = new Date();

    if (entry.type === 'fifo') {
      if (entry.buffer.length === 0) {
        return new Uint8Array(0);
      }
      return entry.buffer.shift()!;
    }

    const start = Math.min(offset, entry.source.length);
    const end = Math.min(start + len, entry.source.length);
    return entry.source.slice(start, end);
  }

  write(handle: FileHandle, data: Uint8Array, offset: number): number {
    const openHandle = this.handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const { entry, flags } = openHandle;

    if (entry.type === 'fifo') {
      entry.buffer.push(new Uint8Array(data));
      const now = new Date();
      entry.mtime = now;
      entry.ctime = now;
      return data.length;
    }

    const writeOffset = flags.append ? entry.source.length : offset;
    const needed = writeOffset + data.length;
    if (needed > entry.source.length) {
      const newBuf = new Uint8Array(needed);
      newBuf.set(entry.source);
      entry.source = newBuf;
    }
    entry.source.set(data, writeOffset);
    const now = new Date();
    entry.mtime = now;
    entry.ctime = now;
    return data.length;
  }

  truncate(handle: FileHandle, size: number): void {
    const openHandle = this.handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const { entry } = openHandle;

    if (entry.type === 'fifo') {
      return; // no-op for FIFOs
    }

    if (size < entry.source.length) {
      entry.source = entry.source.slice(0, size);
    } else if (size > entry.source.length) {
      const newBuf = new Uint8Array(size);
      newBuf.set(entry.source);
      entry.source = newBuf;
    }
    const now = new Date();
    entry.mtime = now;
    entry.ctime = now;
  }

  stat(path: string, options?: { followSymlinks?: boolean }): FileStat {
    const normalized = this.normalizePath(path);
    const followSymlinks = options?.followSymlinks !== false;
    const entry = this.resolveEntry(normalized, followSymlinks);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }
    return this.entryToStat(entry);
  }

  readdir(path: string): DirEntry[] {
    const normalized = this.normalizePath(path);
    const entry = this.resolveEntry(normalized, true);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such directory: ${path}`);
    }
    if (entry.type !== 'directory') {
      throw new FileSystemError('not-directory', `Not a directory: ${path}`);
    }
    const entries: DirEntry[] = [];
    for (const [name, child] of entry.children) {
      entries.push({ name, type: child.type });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  mkdir(path: string): void {
    const normalized = this.normalizePath(path);
    const { dir, base } = this.splitPath(normalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    if (parent.children.has(base)) {
      throw new FileSystemError('exist', `Already exists: ${path}`);
    }
    const now = new Date();
    parent.children.set(base, {
      type: 'directory',
      children: new Map(),
      mode: 0o755,
      mtime: now,
      atime: now,
      ctime: now,
    });
    parent.mtime = now;
  }

  unlink(path: string): void {
    const normalized = this.normalizePath(path);
    const { dir, base } = this.splitPath(normalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    const entry = parent.children.get(base);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file: ${path}`);
    }
    if (entry.type === 'directory') {
      throw new FileSystemError('is-directory', `Is a directory: ${path}`);
    }
    parent.children.delete(base);
    parent.mtime = new Date();
  }

  rmdir(path: string): void {
    const normalized = this.normalizePath(path);
    const { dir, base } = this.splitPath(normalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    const entry = parent.children.get(base);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such directory: ${path}`);
    }
    if (entry.type !== 'directory') {
      throw new FileSystemError('not-directory', `Not a directory: ${path}`);
    }
    if (entry.children.size > 0) {
      throw new FileSystemError('not-empty', `Directory not empty: ${path}`);
    }
    parent.children.delete(base);
    parent.mtime = new Date();
  }

  rename(oldPath: string, newPath: string): void {
    const oldNormalized = this.normalizePath(oldPath);
    const newNormalized = this.normalizePath(newPath);
    const { dir: oldDir, base: oldBase } = this.splitPath(oldNormalized);
    const { dir: newDir, base: newBase } = this.splitPath(newNormalized);

    const oldParent = this.resolveEntry(oldDir, true);
    if (!oldParent || oldParent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Source parent not found: ${oldDir}`);
    }
    const entry = oldParent.children.get(oldBase);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file or directory: ${oldPath}`);
    }

    const newParent = this.resolveEntry(newDir, true);
    if (!newParent || newParent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Destination parent not found: ${newDir}`);
    }

    oldParent.children.delete(oldBase);
    newParent.children.set(newBase, entry);
    const now = new Date();
    oldParent.mtime = now;
    newParent.mtime = now;
  }

  symlink(target: string, linkPath: string): void {
    const normalized = this.normalizePath(linkPath);
    const { dir, base } = this.splitPath(normalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    if (parent.children.has(base)) {
      throw new FileSystemError('exist', `Already exists: ${linkPath}`);
    }
    const now = new Date();
    parent.children.set(base, {
      type: 'symlink',
      target,
      mode: 0o777,
      mtime: now,
      atime: now,
      ctime: now,
    });
    parent.mtime = now;
  }

  readlink(path: string): string {
    const normalized = this.normalizePath(path);
    const entry = this.resolveEntry(normalized, false);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file: ${path}`);
    }
    if (entry.type !== 'symlink') {
      throw new FileSystemError('invalid', `Not a symlink: ${path}`);
    }
    return entry.target;
  }

  link(existingPath: string, newPath: string): void {
    const existingNormalized = this.normalizePath(existingPath);
    const newNormalized = this.normalizePath(newPath);
    const entry = this.resolveEntry(existingNormalized, true);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file: ${existingPath}`);
    }
    if (entry.type === 'directory') {
      throw new FileSystemError('not-permitted', `Cannot hard link a directory: ${existingPath}`);
    }
    const { dir, base } = this.splitPath(newNormalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    if (parent.children.has(base)) {
      throw new FileSystemError('exist', `Already exists: ${newPath}`);
    }
    parent.children.set(base, entry);
    parent.mtime = new Date();
  }

  chmod(path: string, mode: number): void {
    const normalized = this.normalizePath(path);
    const entry = this.resolveEntry(normalized, true);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }
    entry.mode = mode;
    entry.ctime = new Date();
  }

  utimes(path: string, atime: Date, mtime: Date): void {
    const normalized = this.normalizePath(path);
    const entry = this.resolveEntry(normalized, true);
    if (!entry) {
      throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
    }
    entry.atime = atime;
    entry.mtime = mtime;
  }

  mkfifo(path: string): void {
    const normalized = this.normalizePath(path);
    const { dir, base } = this.splitPath(normalized);
    const parent = this.resolveEntry(dir, true);
    if (!parent || parent.type !== 'directory') {
      throw new FileSystemError('no-entry', `Parent directory not found: ${dir}`);
    }
    if (parent.children.has(base)) {
      throw new FileSystemError('exist', `Already exists: ${path}`);
    }
    const now = new Date();
    parent.children.set(base, {
      type: 'fifo',
      buffer: [],
      mode: 0o644,
      mtime: now,
      atime: now,
      ctime: now,
    });
    parent.mtime = now;
  }

  realpath(path: string): string {
    const normalized = this.normalizePath(path);
    return this.resolveSymlinkPath(normalized, 0);
  }

  // --- Private helpers ---

  private normalizePath(path: string): string {
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
    return '/' + resolved.join('/');
  }

  private splitPath(path: string): { dir: string; base: string } {
    if (path === '/') return { dir: '/', base: '' };
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash === 0 ? '/' : path.slice(0, lastSlash);
    const base = path.slice(lastSlash + 1);
    return { dir, base };
  }

  private resolveEntry(path: string, followSymlinks: boolean, depth = 0): MemEntry | undefined {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new FileSystemError('loop', `Too many levels of symbolic links: ${path}`);
    }
    if (path === '/') return this.root;

    const parts = path.split('/').filter(p => p !== '');
    let current: MemEntry = this.root;

    for (let i = 0; i < parts.length; i++) {
      if (current.type === 'symlink') {
        const target = current.target;
        const resolvedTarget = this.normalizePath(target);
        current = this.resolveEntry(resolvedTarget, true, depth + 1) as MemEntry;
        if (!current) return undefined;
      }
      if (current.type !== 'directory') {
        return undefined;
      }
      const child = current.children.get(parts[i]);
      if (!child) return undefined;
      current = child;
    }

    // Final entry: resolve symlink if requested
    if (followSymlinks && current.type === 'symlink') {
      const target = current.target;
      const resolvedTarget = this.normalizePath(target);
      return this.resolveEntry(resolvedTarget, true, depth + 1);
    }

    return current;
  }

  private resolveSymlinkPath(path: string, depth: number): string {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new FileSystemError('loop', `Too many levels of symbolic links: ${path}`);
    }
    if (path === '/') return '/';

    const parts = path.split('/').filter(p => p !== '');
    const resolvedParts: string[] = [];
    let current: MemEntry = this.root;

    for (const part of parts) {
      if (current.type !== 'directory') {
        throw new FileSystemError('not-directory', 'Not a directory in path');
      }
      const child = current.children.get(part);
      if (!child) {
        throw new FileSystemError('no-entry', `No such file or directory: ${path}`);
      }
      if (child.type === 'symlink') {
        const target = this.normalizePath(child.target);
        const resolved = this.resolveSymlinkPath(target, depth + 1);
        // Restart resolution from the resolved target
        const remaining = parts.slice(parts.indexOf(part) + 1);
        if (remaining.length > 0) {
          return this.resolveSymlinkPath(resolved + '/' + remaining.join('/'), depth + 1);
        }
        return resolved;
      }
      resolvedParts.push(part);
      current = child;
    }

    return '/' + resolvedParts.join('/');
  }

  private entryToStat(entry: MemEntry): FileStat {
    let size = 0n;
    if (entry.type === 'file') {
      size = BigInt(entry.source.length);
    }
    return {
      type: entry.type,
      size,
      mode: entry.mode,
      mtime: entry.mtime,
      atime: entry.atime,
      ctime: entry.ctime,
      linkCount: 1n,
    };
  }

  private createFileAt(path: string, content: Uint8Array, mode: number, mtime: Date): void {
    const normalized = this.normalizePath(path);
    const parts = normalized.split('/').filter(p => p !== '');
    let current: MemDirectoryEntry = this.root;

    // Create parent directories as needed
    for (let i = 0; i < parts.length - 1; i++) {
      let child = current.children.get(parts[i]);
      if (!child) {
        const now = new Date();
        child = {
          type: 'directory',
          children: new Map(),
          mode: 0o755,
          mtime: now,
          atime: now,
          ctime: now,
        };
        current.children.set(parts[i], child);
      }
      if (child.type !== 'directory') {
        throw new FileSystemError('not-directory', `Not a directory: ${parts[i]}`);
      }
      current = child;
    }

    const fileName = parts[parts.length - 1];
    current.children.set(fileName, {
      type: 'file',
      source: content,
      mode,
      mtime,
      atime: mtime,
      ctime: mtime,
    });
  }
}
