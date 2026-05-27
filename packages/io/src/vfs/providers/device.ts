import type { FileHandle, OpenFlags, DirEntry, FileSystemProvider, FileStat } from '../provider.ts';
import { FileSystemError } from '../provider.ts';

/** Options for the DeviceProvider. */
export interface DeviceProviderOptions {
  stdin?: () => Promise<Uint8Array>;
  stdout?: (data: Uint8Array) => Promise<void>;
  stderr?: (data: Uint8Array) => Promise<void>;
}

const DEVICE_NAMES = ['null', 'zero', 'stdin', 'stdout', 'stderr'] as const;

/**
 * Synthetic /dev/* device provider.
 */
export class DeviceProvider implements FileSystemProvider {
  private stdinFn: () => Promise<Uint8Array>;
  private stdoutFn: (data: Uint8Array) => Promise<void>;
  private stderrFn: (data: Uint8Array) => Promise<void>;
  private nextFd = 3;
  private handles = new Map<number, string>();

  constructor(options?: DeviceProviderOptions) {
    this.stdinFn = options?.stdin ?? (async () => new Uint8Array(0));
    this.stdoutFn = options?.stdout ?? (async () => {});
    this.stderrFn = options?.stderr ?? (async () => {});
  }

  async init(): Promise<void> {}
  async dispose(): Promise<void> {}

  async open(path: string, _flags: OpenFlags): Promise<FileHandle> {
    const device = this.resolveDevice(path);
    const fd = this.nextFd++;
    this.handles.set(fd, device);
    return { fd, path, flags: _flags };
  }

  async close(handle: FileHandle): Promise<void> {
    if (!this.handles.has(handle.fd)) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    this.handles.delete(handle.fd);
  }

  async read(handle: FileHandle, _offset: number, len: number): Promise<Uint8Array> {
    const device = this.handles.get(handle.fd);
    if (!device) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    switch (device) {
      case 'null':
        return new Uint8Array(0);
      case 'zero':
        return new Uint8Array(len);
      case 'stdin':
        return this.stdinFn();
      case 'stdout':
      case 'stderr':
        return new Uint8Array(0);
      default:
        throw new FileSystemError('no-entry', `Unknown device: ${device}`);
    }
  }

  async write(handle: FileHandle, data: Uint8Array, _offset: number): Promise<number> {
    const device = this.handles.get(handle.fd);
    if (!device) {
      throw new FileSystemError('invalid', `Invalid file descriptor: ${handle.fd}`);
    }
    switch (device) {
      case 'null':
        return data.length;
      case 'zero':
        return data.length;
      case 'stdout':
        await this.stdoutFn(data);
        return data.length;
      case 'stderr':
        await this.stderrFn(data);
        return data.length;
      case 'stdin':
        throw new FileSystemError('not-permitted', 'Cannot write to stdin');
      default:
        throw new FileSystemError('no-entry', `Unknown device: ${device}`);
    }
  }

  async truncate(_handle: FileHandle, _size: number): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot truncate a device');
  }

  async stat(path: string, _options?: { followSymlinks?: boolean }): Promise<FileStat> {
    const normalized = this.normalizePath(path);
    if (normalized === '/') {
      const now = new Date();
      return {
        type: 'directory',
        size: 0n,
        mode: 0o755,
        mtime: now,
        atime: now,
        ctime: now,
        linkCount: 1n,
      };
    }
    this.resolveDevice(path); // validate device exists
    const now = new Date();
    return {
      type: 'character-device',
      size: 0n,
      mode: 0o666,
      mtime: now,
      atime: now,
      ctime: now,
      linkCount: 1n,
    };
  }

  async readdir(path: string): Promise<DirEntry[]> {
    const normalized = this.normalizePath(path);
    if (normalized !== '/') {
      throw new FileSystemError('not-directory', `Not a directory: ${path}`);
    }
    return DEVICE_NAMES.map(name => ({
      name,
      type: 'character-device' as const,
    }));
  }

  async mkdir(_path: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot create directories in /dev');
  }

  async unlink(_path: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot unlink devices');
  }

  async rmdir(_path: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot remove directories in /dev');
  }

  async rename(_oldPath: string, _newPath: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot rename devices');
  }

  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot create symlinks in /dev');
  }

  async readlink(_path: string): Promise<string> {
    throw new FileSystemError('invalid', 'Devices are not symlinks');
  }

  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot create links in /dev');
  }

  async chmod(_path: string, _mode: number): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot chmod devices');
  }

  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> {
    throw new FileSystemError('not-permitted', 'Cannot change timestamps of devices');
  }

  // --- Private helpers ---

  private normalizePath(path: string): string {
    if (!path || path === '/') return '/';
    // Remove leading slash and any trailing slash
    let normalized = path.replace(/\/+$/, '');
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }
    return normalized;
  }

  private resolveDevice(path: string): string {
    const normalized = this.normalizePath(path);
    // Path is like /null, /zero, /stdin, etc. or just null, zero, stdin
    const name = normalized.startsWith('/') ? normalized.slice(1) : normalized;
    if (!DEVICE_NAMES.includes(name as typeof DEVICE_NAMES[number])) {
      throw new FileSystemError('no-entry', `Unknown device: ${path}`);
    }
    return name;
  }
}
