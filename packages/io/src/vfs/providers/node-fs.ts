import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Stats, Dirent } from 'node:fs';
import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat, DescriptorType } from '../provider.ts';
import { FileSystemError } from '../provider.ts';

/** Options for constructing a NodeFsProvider. */
export interface NodeFsProviderOptions {
  /** Root directory on the host filesystem. All paths are relative to this. */
  root: string;
}

/**
 * Node.js native filesystem provider that wraps the `node:fs/promises` module.
 * All paths are resolved relative to the configured root directory.
 */
export class NodeFsProvider implements FileSystemProvider {
  #root: string;
  #nextFd = 3;
  #handles = new Map<number, { nativeHandle: fs.FileHandle; path: string; flags: OpenFlags }>();

  constructor(options: NodeFsProviderOptions) {
    this.#root = nodePath.resolve(options.root);
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {
    for (const { nativeHandle } of this.#handles.values()) {
      await nativeHandle.close();
    }
    this.#handles.clear();
  }

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    const resolved = this.#resolvePath(path);

    if (flags.directory) {
      // Verify it's a directory
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        throw new FileSystemError('not-directory', `Not a directory: ${path}`);
      }
      const fd = this.#nextFd++;
      return { fd, path, flags };
    }

    const fsFlags = this.#toFsFlags(flags);
    let nativeHandle: fs.FileHandle;
    try {
      nativeHandle = await fs.open(resolved, fsFlags);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }

    const fd = this.#nextFd++;
    this.#handles.set(fd, { nativeHandle, path, flags });
    return { fd, path, flags };
  }

  async close(handle: FileHandle): Promise<void> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    await openHandle.nativeHandle.close();
    this.#handles.delete(handle.fd);
  }

  async read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const buffer = new Uint8Array(len);
    const { bytesRead } = await openHandle.nativeHandle.read(buffer, 0, len, offset);
    return buffer.slice(0, bytesRead);
  }

  async write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    const writeOffset = openHandle.flags.append ? null : offset;
    const { bytesWritten } = await openHandle.nativeHandle.write(data, 0, data.length, writeOffset);
    return bytesWritten;
  }

  async truncate(handle: FileHandle, size: number): Promise<void> {
    const openHandle = this.#handles.get(handle.fd);
    if (!openHandle) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    await openHandle.nativeHandle.truncate(size);
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat> {
    const resolved = this.#resolvePath(path);
    const followSymlinks = options?.followSymlinks !== false;
    try {
      const stat = followSymlinks ? await fs.stat(resolved) : await fs.lstat(resolved);
      return this.#mapStat(stat);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const resolved = this.#resolvePath(path);
    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const result: DirEntry[] = entries.map(entry => ({
        name: entry.name,
        type: this.#direntType(entry),
      }));
      result.sort((a, b) => a.name.localeCompare(b.name));
      return result;
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async mkdir(path: string): Promise<void> {
    const resolved = this.#resolvePath(path);
    try {
      await fs.mkdir(resolved);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async unlink(path: string): Promise<void> {
    const resolved = this.#resolvePath(path);
    try {
      await fs.unlink(resolved);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async rmdir(path: string): Promise<void> {
    const resolved = this.#resolvePath(path);
    try {
      await fs.rmdir(resolved);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const resolvedOld = this.#resolvePath(oldPath);
    const resolvedNew = this.#resolvePath(newPath);
    try {
      await fs.rename(resolvedOld, resolvedNew);
    } catch (e: unknown) {
      throw this.#mapError(e, oldPath);
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const resolvedLink = this.#resolvePath(linkPath);
    const resolvedTarget = target.startsWith('/')
      ? this.#resolvePath(target)
      : nodePath.resolve(nodePath.dirname(resolvedLink), target);
    if (!resolvedTarget.startsWith(this.#root + nodePath.sep) && resolvedTarget !== this.#root) {
      throw new FileSystemError('access', `Symlink target escapes root: ${target}`);
    }
    try {
      await fs.symlink(target, resolvedLink);
    } catch (e: unknown) {
      throw this.#mapError(e, linkPath);
    }
  }

  async readlink(path: string): Promise<string> {
    const resolved = this.#resolvePath(path);
    try {
      return await fs.readlink(resolved);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const resolvedExisting = this.#resolvePath(existingPath);
    const resolvedNew = this.#resolvePath(newPath);
    try {
      await fs.link(resolvedExisting, resolvedNew);
    } catch (e: unknown) {
      throw this.#mapError(e, existingPath);
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const resolved = this.#resolvePath(path);
    try {
      await fs.chmod(resolved, mode);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const resolved = this.#resolvePath(path);
    try {
      await fs.utimes(resolved, atime, mtime);
    } catch (e: unknown) {
      throw this.#mapError(e, path);
    }
  }

  async realpath(path: string): Promise<string> {
    const resolved = this.#resolvePath(path);
    try {
      const real = await fs.realpath(resolved);
      if (!real.startsWith(this.#root + nodePath.sep) && real !== this.#root) {
        throw new FileSystemError('access', `Resolved path escapes root: ${path}`);
      }
      return '/' + nodePath.relative(this.#root, real);
    } catch (e: unknown) {
      if (e instanceof FileSystemError) throw e;
      throw this.#mapError(e, path);
    }
  }

  // --- Private helpers ---

  #resolvePath(path: string): string {
    // Normalize and prevent path traversal
    const normalized = nodePath.normalize(path.startsWith('/') ? path : '/' + path);
    const resolved = nodePath.join(this.#root, normalized);
    const resolvedNormalized = nodePath.resolve(resolved);

    // Ensure the resolved path is within root
    if (!resolvedNormalized.startsWith(this.#root + nodePath.sep) && resolvedNormalized !== this.#root) {
      throw new FileSystemError('access', `Path traversal detected: ${path}`);
    }

    return resolvedNormalized;
  }

  #toFsFlags(flags: OpenFlags): string {
    if (flags.create && flags.exclusive) return 'wx';
    if (flags.create && flags.truncate && flags.write && flags.read) return 'w+';
    if (flags.create && flags.truncate && flags.write) return 'w';
    if (flags.create && flags.append) return 'a';
    if (flags.create && flags.write && flags.read) return 'w+';
    if (flags.create && flags.write) return 'w';
    if (flags.append && flags.read) return 'a+';
    if (flags.append) return 'a';
    if (flags.write && flags.read) return 'r+';
    if (flags.write) return 'r+';
    if (flags.truncate && flags.write) return 'w';
    return 'r';
  }

  #mapStat(stat: Stats): FileStat {
    let type: DescriptorType;
    if (stat.isFile()) type = 'file';
    else if (stat.isDirectory()) type = 'directory';
    else if (stat.isSymbolicLink()) type = 'symlink';
    else if (stat.isBlockDevice()) type = 'block-device';
    else if (stat.isCharacterDevice()) type = 'character-device';
    else if (stat.isFIFO()) type = 'fifo';
    else if (stat.isSocket()) type = 'socket';
    else type = 'unknown';

    return {
      type,
      size: BigInt(stat.size),
      mode: stat.mode & 0o7777,
      mtime: stat.mtime,
      atime: stat.atime,
      ctime: stat.ctime,
      linkCount: BigInt(stat.nlink),
    };
  }

  #direntType(entry: Dirent): DescriptorType {
    if (entry.isFile()) return 'file';
    if (entry.isDirectory()) return 'directory';
    if (entry.isSymbolicLink()) return 'symlink';
    if (entry.isBlockDevice()) return 'block-device';
    if (entry.isCharacterDevice()) return 'character-device';
    if (entry.isFIFO()) return 'fifo';
    if (entry.isSocket()) return 'socket';
    return 'unknown';
  }

  #mapError(e: unknown, path: string): FileSystemError {
    const err = e as NodeJS.ErrnoException;
    switch (err?.code) {
      case 'ENOENT': return new FileSystemError('no-entry', `No such file or directory: ${path}`);
      case 'EEXIST': return new FileSystemError('exist', `Already exists: ${path}`);
      case 'ENOTDIR': return new FileSystemError('not-directory', `Not a directory: ${path}`);
      case 'EISDIR': return new FileSystemError('is-directory', `Is a directory: ${path}`);
      case 'ENOTEMPTY': return new FileSystemError('not-empty', `Directory not empty: ${path}`);
      case 'EACCES':
      case 'EPERM': return new FileSystemError('not-permitted', `Permission denied: ${path}`);
      case 'ENOSPC': return new FileSystemError('insufficient-space', `No space left: ${path}`);
      case 'ELOOP': return new FileSystemError('loop', `Too many symlinks: ${path}`);
      case 'ENAMETOOLONG': return new FileSystemError('name-too-long', `Name too long: ${path}`);
      case 'EXDEV': return new FileSystemError('cross-device', `Cross-device link: ${path}`);
      default: return new FileSystemError('io', `I/O error: ${path} (${err?.code ?? 'unknown'})`);
    }
  }
}
