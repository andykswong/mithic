import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat } from './provider.ts';
import { FileSystemError } from './provider.ts';
import { normalizePath } from './path-utils.ts';

/** Result of resolving a path against mount points. */
export interface ResolveResult {
  provider: FileSystemProvider;
  relativePath: string;
  mountPoint: string;
}

/**
 * VFS mount router. Uses longest-prefix matching to resolve paths to providers.
 * Implements FileSystemProvider so it can be composed (e.g., mounted inside another router).
 */
export class FileSystemRouter implements FileSystemProvider {
  private mounts: Array<{ mountPoint: string; provider: FileSystemProvider }> = [];

  /** Mount a provider at a path prefix. */
  async mount(mountPoint: string, provider: FileSystemProvider): Promise<void> {
    const normalized = normalizePath(mountPoint);
    // Remove existing mount at same point
    this.mounts = this.mounts.filter(m => m.mountPoint !== normalized);
    this.mounts.push({ mountPoint: normalized, provider });
    // Sort by path length descending (longest first)
    this.mounts.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
    if (provider.init) {
      await provider.init();
    }
  }

  /** Unmount a provider. */
  async unmount(mountPoint: string): Promise<void> {
    const normalized = normalizePath(mountPoint);
    const entry = this.mounts.find(m => m.mountPoint === normalized);
    if (entry && entry.provider.dispose) {
      await entry.provider.dispose();
    }
    this.mounts = this.mounts.filter(m => m.mountPoint !== normalized);
  }

  /** Get all mount points. */
  getMounts(): Map<string, FileSystemProvider> {
    const map = new Map<string, FileSystemProvider>();
    for (const { mountPoint, provider } of this.mounts) {
      map.set(mountPoint, provider);
    }
    return map;
  }

  /** Resolve a path to (provider, relativePath, mountPoint). */
  resolve(absolutePath: string): ResolveResult {
    const normalized = normalizePath(absolutePath);
    for (const { mountPoint, provider } of this.mounts) {
      if (mountPoint === '/') {
        // Root mount matches everything
        const relativePath = normalized === '/' ? '/' : normalized.slice(1);
        return { provider, relativePath, mountPoint };
      }
      if (normalized === mountPoint || normalized.startsWith(mountPoint + '/')) {
        const relativePath = normalized === mountPoint
          ? '/'
          : normalized.slice(mountPoint.length + 1);
        return { provider, relativePath: relativePath || '/', mountPoint };
      }
    }
    throw new FileSystemError('no-entry', `No mount found for path: ${absolutePath}`);
  }

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    const { provider, relativePath } = this.resolve(path);
    const handle = await provider.open(relativePath, flags);
    return { ...handle, path };
  }

  async close(handle: FileHandle): Promise<void> {
    const { provider } = this.resolve(handle.path);
    return provider.close(handle);
  }

  async read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array> {
    const { provider } = this.resolve(handle.path);
    return provider.read(handle, offset, len);
  }

  async write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number> {
    const { provider } = this.resolve(handle.path);
    return provider.write(handle, data, offset);
  }

  async truncate(handle: FileHandle, size: number): Promise<void> {
    const { provider } = this.resolve(handle.path);
    return provider.truncate(handle, size);
  }

  async stat(path: string, options?: { followSymlinks?: boolean }): Promise<FileStat> {
    const { provider, relativePath } = this.resolve(path);
    return provider.stat(relativePath, options);
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const { provider, relativePath } = this.resolve(path);
    return provider.readdir(relativePath);
  }

  async mkdir(path: string): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.mkdir(relativePath);
  }

  async unlink(path: string): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.unlink(relativePath);
  }

  async rmdir(path: string): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.rmdir(relativePath);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldResolved = this.resolve(oldPath);
    const newResolved = this.resolve(newPath);
    if (oldResolved.provider !== newResolved.provider) {
      throw new FileSystemError('cross-device', 'Cannot rename across mount points');
    }
    return oldResolved.provider.rename(oldResolved.relativePath, newResolved.relativePath);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const { provider, relativePath } = this.resolve(linkPath);
    return provider.symlink(target, relativePath);
  }

  async readlink(path: string): Promise<string> {
    const { provider, relativePath } = this.resolve(path);
    return provider.readlink(relativePath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const oldResolved = this.resolve(existingPath);
    const newResolved = this.resolve(newPath);
    if (oldResolved.provider !== newResolved.provider) {
      throw new FileSystemError('cross-device', 'Cannot link across mount points');
    }
    return oldResolved.provider.link(oldResolved.relativePath, newResolved.relativePath);
  }

  async chmod(path: string, mode: number): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.chmod(relativePath, mode);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.utimes(relativePath, atime, mtime);
  }

  async mkfifo(path: string): Promise<void> {
    const { provider, relativePath } = this.resolve(path);
    return provider.mkfifo(relativePath);
  }

  async realpath(path: string): Promise<string> {
    const { provider, relativePath, mountPoint } = this.resolve(path);
    if (provider.realpath) {
      const resolved = await provider.realpath(relativePath);
      return mountPoint === '/'
        ? '/' + resolved.replace(/^\//, '')
        : mountPoint + '/' + resolved.replace(/^\//, '');
    }
    // Default: just return the normalized path
    return normalizePath(path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (err) {
      if (err instanceof FileSystemError && err.code === 'no-entry') {
        return false;
      }
      throw err;
    }
  }
}
