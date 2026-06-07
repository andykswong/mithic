import type { FileHandle, OpenFlags, DirEntry, FileStat, SyncFileSystemProvider } from './provider.ts';
import { FileSystemError } from './provider.ts';
import { normalizePath } from './path-utils.ts';

interface MountEntry {
  mountPoint: string;
  provider: SyncFileSystemProvider;
}

/**
 * Synchronous VFS mount router. Longest-prefix matching to resolve paths to providers.
 * All operations are synchronous — suitable for use with SyncFsDescriptorHandler.
 */
export class SyncFileSystemRouter implements SyncFileSystemProvider {
  #mounts: MountEntry[] = [];

  mount(mountPoint: string, provider: SyncFileSystemProvider): void {
    const normalized = normalizePath(mountPoint);
    this.#mounts = this.#mounts.filter(m => m.mountPoint !== normalized);
    this.#mounts.push({ mountPoint: normalized, provider });
    this.#mounts.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
    provider.init?.();
  }

  unmount(mountPoint: string): void {
    const normalized = normalizePath(mountPoint);
    const entry = this.#mounts.find(m => m.mountPoint === normalized);
    entry?.provider.dispose?.();
    this.#mounts = this.#mounts.filter(m => m.mountPoint !== normalized);
  }

  #resolve(absolutePath: string): { provider: SyncFileSystemProvider; relativePath: string } {
    const normalized = normalizePath(absolutePath);
    for (const { mountPoint, provider } of this.#mounts) {
      if (mountPoint === '/') {
        return { provider, relativePath: normalized === '/' ? '/' : normalized.slice(1) };
      }
      if (normalized === mountPoint || normalized.startsWith(mountPoint + '/')) {
        const relativePath = normalized === mountPoint ? '/' : normalized.slice(mountPoint.length + 1);
        return { provider, relativePath: relativePath || '/' };
      }
    }
    throw new FileSystemError('no-entry', `No mount found for path: ${absolutePath}`);
  }

  open(path: string, flags: OpenFlags): FileHandle {
    const { provider, relativePath } = this.#resolve(path);
    const handle = provider.open(relativePath, flags);
    return { ...handle, path };
  }

  close(handle: FileHandle): void {
    const { provider } = this.#resolve(handle.path);
    provider.close(handle);
  }

  read(handle: FileHandle, offset: number, len: number): Uint8Array {
    const { provider } = this.#resolve(handle.path);
    return provider.read(handle, offset, len);
  }

  write(handle: FileHandle, data: Uint8Array, offset: number): number {
    const { provider } = this.#resolve(handle.path);
    return provider.write(handle, data, offset);
  }

  truncate(handle: FileHandle, size: number): void {
    const { provider } = this.#resolve(handle.path);
    provider.truncate(handle, size);
  }

  stat(path: string, options?: { followSymlinks?: boolean }): FileStat {
    const { provider, relativePath } = this.#resolve(path);
    return provider.stat(relativePath, options);
  }

  readdir(path: string): DirEntry[] {
    const { provider, relativePath } = this.#resolve(path);
    const entries = provider.readdir(relativePath);

    const normalized = normalizePath(path);
    const prefix = normalized === '/' ? '/' : normalized + '/';
    const seen = new Set(entries.map(e => e.name));
    for (const { mountPoint } of this.#mounts) {
      if (mountPoint === '/') continue;
      if (mountPoint.startsWith(prefix)) {
        const remainder = mountPoint.slice(prefix.length);
        if (!remainder.includes('/')) {
          if (!seen.has(remainder)) {
            entries.push({ name: remainder, type: 'directory' });
            seen.add(remainder);
          }
        }
      }
    }
    return entries;
  }

  mkdir(path: string): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.mkdir(relativePath);
  }

  unlink(path: string): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.unlink(relativePath);
  }

  rmdir(path: string): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.rmdir(relativePath);
  }

  rename(oldPath: string, newPath: string): void {
    const oldR = this.#resolve(oldPath);
    const newR = this.#resolve(newPath);
    if (oldR.provider !== newR.provider) {
      throw new FileSystemError('cross-device', 'Cannot rename across mount points');
    }
    oldR.provider.rename(oldR.relativePath, newR.relativePath);
  }

  symlink(target: string, linkPath: string): void {
    const { provider, relativePath } = this.#resolve(linkPath);
    provider.symlink(target, relativePath);
  }

  readlink(path: string): string {
    const { provider, relativePath } = this.#resolve(path);
    return provider.readlink(relativePath);
  }

  link(existingPath: string, newPath: string): void {
    const oldR = this.#resolve(existingPath);
    const newR = this.#resolve(newPath);
    if (oldR.provider !== newR.provider) {
      throw new FileSystemError('cross-device', 'Cannot link across mount points');
    }
    oldR.provider.link(oldR.relativePath, newR.relativePath);
  }

  chmod(path: string, mode: number): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.chmod(relativePath, mode);
  }

  utimes(path: string, atime: Date, mtime: Date): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.utimes(relativePath, atime, mtime);
  }

  mkfifo(path: string): void {
    const { provider, relativePath } = this.#resolve(path);
    provider.mkfifo(relativePath);
  }
}
