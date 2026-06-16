import type { FileHandle, OpenFlags, DirEntry, FileStat, FileSystemProvider } from '../provider.ts';
import { FileSystemError } from '../provider.ts';

const DEVICE_NAMES = ['null', 'zero', 'random', 'urandom', 'stdin', 'stdout', 'stderr'] as const;
type DeviceName = typeof DEVICE_NAMES[number];

export interface StdinHandler {
  read(len: number): Uint8Array | undefined;
  blockingRead(len: number): Uint8Array;
}

export interface StdoutHandler {
  write(data: Uint8Array): void;
}

export interface DeviceFsProviderOptions {
  stdin?: StdinHandler;
  stdout?: StdoutHandler;
  stderr?: StdoutHandler;
}

/**
 * Synchronous /dev filesystem provider.
 * Implements character device semantics for null, zero, stdin, stdout, stderr.
 */
export class DeviceFsProvider implements FileSystemProvider {
  #stdin: StdinHandler;
  #stdout: StdoutHandler;
  #stderr: StdoutHandler;
  #nextFd = 100;
  #handles = new Map<number, DeviceName>();

  constructor(options?: DeviceFsProviderOptions) {
    this.#stdin = options?.stdin ?? { read: () => undefined, blockingRead: () => new Uint8Array(0) };
    this.#stdout = options?.stdout ?? { write() {} };
    this.#stderr = options?.stderr ?? { write() {} };
  }

  open(path: string, flags: OpenFlags): FileHandle {
    const device = this.#resolveDevice(path);
    const fd = this.#nextFd++;
    this.#handles.set(fd, device);
    return { fd, path, flags };
  }

  close(handle: FileHandle): void {
    this.#handles.delete(handle.fd);
  }

  read(handle: FileHandle, _offset: number, len: number): Uint8Array {
    const device = this.#handles.get(handle.fd);
    if (!device) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);
    switch (device) {
      case 'null': return new Uint8Array(0);
      case 'zero': return new Uint8Array(len);
      case 'random':
      case 'urandom': {
        const buf = new Uint8Array(len);
        crypto.getRandomValues(buf);
        return buf;
      }
      case 'stdin': return this.#stdin.blockingRead(len);
      default: return new Uint8Array(0);
    }
  }

  write(handle: FileHandle, data: Uint8Array, _offset: number): number {
    const device = this.#handles.get(handle.fd);
    if (!device) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);
    switch (device) {
      case 'null':
      case 'zero':
      case 'random':
      case 'urandom':
        return data.byteLength;
      case 'stdout':
        this.#stdout.write(data);
        return data.byteLength;
      case 'stderr':
        this.#stderr.write(data);
        return data.byteLength;
      case 'stdin':
        throw new FileSystemError('not-permitted', 'Cannot write to stdin');
      default:
        return data.byteLength;
    }
  }

  truncate(_handle: FileHandle, _size: number): void {}

  stat(path: string): FileStat {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return { type: 'directory', size: 0n, mode: 0o755, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n };
    }
    this.#resolveDevice(path);
    return { type: 'character-device', size: 0n, mode: 0o666, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n };
  }

  readdir(path: string): DirEntry[] {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized !== '') throw new FileSystemError('not-directory', `Not a directory: ${path}`);
    return DEVICE_NAMES.map(name => ({ name, type: 'character-device' as const }));
  }

  mkdir(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot mkdir in /dev'); }
  unlink(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot unlink in /dev'); }
  rmdir(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot rmdir in /dev'); }
  rename(_o: string, _n: string): void { throw new FileSystemError('not-permitted', 'Cannot rename in /dev'); }
  symlink(_t: string, _l: string): void { throw new FileSystemError('not-permitted', 'Cannot symlink in /dev'); }
  readlink(_path: string): string { throw new FileSystemError('invalid', 'Devices are not symlinks'); }
  link(_e: string, _n: string): void { throw new FileSystemError('not-permitted', 'Cannot link in /dev'); }
  chmod(_path: string, _mode: number): void {}
  utimes(_path: string, _atime: Date, _mtime: Date): void {}
  mkfifo(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot mkfifo in /dev'); }

  #resolveDevice(path: string): DeviceName {
    const name = path.replace(/^\/+/, '');
    if (!DEVICE_NAMES.includes(name as DeviceName)) {
      throw new FileSystemError('no-entry', `Unknown device: ${path}`);
    }
    return name as DeviceName;
  }
}
