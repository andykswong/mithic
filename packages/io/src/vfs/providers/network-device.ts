import type { FileHandle, OpenFlags, DirEntry, FileStat, FileSystemProvider, SyncFileSystemProvider } from '../provider.ts';
import { FileSystemError } from '../provider.ts';
import type { SocketProvider, TcpSocket, UdpSocket } from '../../net/sockets.ts';
import type { MaybePromise } from '../../types.ts';
import { chainMaybePromise } from '../../types.ts';

type Protocol = 'tcp' | 'udp';

interface SocketHandle<Sync extends boolean = boolean> {
  protocol: Protocol;
  tcpSocket?: TcpSocket<Sync>;
  udpSocket?: UdpSocket<Sync>;
  remoteHost: string;
  remotePort: number;
}

export interface NetworkDeviceFsProviderOptions<Sync extends boolean = boolean> {
  sockets: SocketProvider<Sync>;
  protocol: Protocol;
}

/**
 * Virtual filesystem provider for /dev/tcp or /dev/udp.
 * Mount one instance at /dev/tcp (protocol='tcp') and one at /dev/udp (protocol='udp').
 * Paths are of the form <host>/<port> relative to the mount point.
 */
export class NetworkDeviceFsProvider<Sync extends boolean = boolean> implements FileSystemProvider<Sync> {
  readonly #sockets: SocketProvider<Sync>;
  readonly #protocol: Protocol;
  #nextFd = 200;
  #freeFds: number[] = [];
  #handles = new Map<number, SocketHandle<Sync>>();
  #pathToFd = new Map<string, { fd: number; refCount: number }>();
  #pendingOpens = new Map<string, Promise<FileHandle>>();

  constructor(options: NetworkDeviceFsProviderOptions<Sync>) {
    this.#sockets = options.sockets;
    this.#protocol = options.protocol;
  }

  open(path: string, flags: OpenFlags): MaybePromise<FileHandle, Sync> {
    const parsed = this.#parsePath(path);
    if (!parsed.port) {
      throw new FileSystemError('invalid', `Invalid network path: ${path} (expected <host>/<port>)`);
    }

    const normalizedPath = `${parsed.host}/${parsed.port}`;
    const existing = this.#pathToFd.get(normalizedPath);
    if (existing && this.#handles.has(existing.fd)) {
      existing.refCount++;
      return { fd: existing.fd, path, flags } as MaybePromise<FileHandle, Sync>;
    }

    const pending = this.#pendingOpens.get(normalizedPath);
    if (pending) {
      return pending.then(() => {
        const entry = this.#pathToFd.get(normalizedPath);
        if (entry && this.#handles.has(entry.fd)) {
          entry.refCount++;
          return { fd: entry.fd, path, flags } as FileHandle;
        }
        return this.open(path, flags) as Promise<FileHandle>;
      }) as MaybePromise<FileHandle, Sync>;
    }

    const fd = this.#freeFds.length > 0 ? this.#freeFds.pop()! : this.#nextFd++;
    const handle: SocketHandle<Sync> = {
      protocol: this.#protocol,
      remoteHost: parsed.host,
      remotePort: parsed.port,
    };

    const resolvedHost = this.#resolveHost(parsed.host);

    if (this.#protocol === 'tcp') {
      const result = chainMaybePromise(resolvedHost, (host) =>
        chainMaybePromise(this.#sockets.createTcpSocket(), (socket) => {
          let connectResult: MaybePromise<void, Sync>;
          try {
            connectResult = socket.connect({ host, port: parsed.port! }) as MaybePromise<void, Sync>;
          } catch (e) {
            try { socket.close(); } catch { /* ignore */ }
            throw new FileSystemError('io', `Failed to connect to ${parsed.host}:${parsed.port}: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (connectResult instanceof Promise) {
            return connectResult.then(() => {
              handle.tcpSocket = socket;
              this.#handles.set(fd, handle);
              this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
              return { fd, path, flags } as FileHandle;
            }).catch((e: unknown) => {
              try { socket.close(); } catch { /* ignore */ }
              throw new FileSystemError('io', `Failed to connect to ${parsed.host}:${parsed.port}: ${e instanceof Error ? e.message : String(e)}`);
            }) as MaybePromise<FileHandle, Sync>;
          }
          handle.tcpSocket = socket;
          this.#handles.set(fd, handle);
          this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
          return { fd, path, flags } as MaybePromise<FileHandle, Sync>;
        }),
      ) as MaybePromise<FileHandle, Sync>;

      if (result instanceof Promise) {
        this.#pendingOpens.set(normalizedPath, result as Promise<FileHandle>);
        return (result as Promise<FileHandle>).finally(() => {
          this.#pendingOpens.delete(normalizedPath);
        }) as MaybePromise<FileHandle, Sync>;
      }
      return result;
    }

    const result = chainMaybePromise(this.#sockets.createUdpSocket(), (socket) => {
      let bindResult: MaybePromise<void, Sync>;
      try {
        bindResult = socket.bind({ host: '0.0.0.0', port: 0 }) as MaybePromise<void, Sync>;
      } catch (e) {
        try { socket.close(); } catch { /* ignore */ }
        throw new FileSystemError('io', `Failed to bind UDP socket: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (bindResult instanceof Promise) {
        return bindResult.then(() => {
          handle.udpSocket = socket;
          this.#handles.set(fd, handle);
          this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
          return { fd, path, flags } as FileHandle;
        }).catch((e: unknown) => {
          try { socket.close(); } catch { /* ignore */ }
          throw new FileSystemError('io', `Failed to bind UDP socket: ${e instanceof Error ? e.message : String(e)}`);
        }) as MaybePromise<FileHandle, Sync>;
      }
      handle.udpSocket = socket;
      this.#handles.set(fd, handle);
      this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
      return { fd, path, flags } as MaybePromise<FileHandle, Sync>;
    }) as MaybePromise<FileHandle, Sync>;

    if (result instanceof Promise) {
      this.#pendingOpens.set(normalizedPath, result as Promise<FileHandle>);
      return (result as Promise<FileHandle>).finally(() => {
        this.#pendingOpens.delete(normalizedPath);
      }) as MaybePromise<FileHandle, Sync>;
    }
    return result;
  }

  close(handle: FileHandle): MaybePromise<void, Sync> {
    const sock = this.#handles.get(handle.fd);
    if (!sock) return undefined as MaybePromise<void, Sync>;
    const pathKey = `${sock.remoteHost}/${sock.remotePort}`;
    const entry = this.#pathToFd.get(pathKey);
    if (entry && entry.fd === handle.fd) {
      entry.refCount--;
      if (entry.refCount > 0) return undefined as MaybePromise<void, Sync>;
      this.#pathToFd.delete(pathKey);
    }
    this.#handles.delete(handle.fd);
    this.#freeFds.push(handle.fd);
    if (sock.tcpSocket) {
      try { return sock.tcpSocket.close() as MaybePromise<void, Sync>; } catch { /* ignore */ }
    }
    if (sock.udpSocket) {
      try { return sock.udpSocket.close() as MaybePromise<void, Sync>; } catch { /* ignore */ }
    }
    return undefined as MaybePromise<void, Sync>;
  }

  read(handle: FileHandle, _offset: number, len: number): MaybePromise<Uint8Array, Sync> {
    const sock = this.#handles.get(handle.fd);
    if (!sock) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);

    if (sock.protocol === 'tcp') {
      return sock.tcpSocket!.receive(len) as MaybePromise<Uint8Array, Sync>;
    }
    const result = sock.udpSocket!.receive(len);
    if (result instanceof Promise) {
      return result.then(r => r.data) as MaybePromise<Uint8Array, Sync>;
    }
    return (result as { data: Uint8Array }).data as MaybePromise<Uint8Array, Sync>;
  }

  write(handle: FileHandle, data: Uint8Array, _offset: number): MaybePromise<number, Sync> {
    const sock = this.#handles.get(handle.fd);
    if (!sock) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);

    if (sock.protocol === 'tcp') {
      return sock.tcpSocket!.send(data) as MaybePromise<number, Sync>;
    }
    return sock.udpSocket!.send(data, { host: sock.remoteHost, port: sock.remotePort }) as MaybePromise<number, Sync>;
  }

  truncate(_handle: FileHandle, _size: number): MaybePromise<void, Sync> {
    throw new FileSystemError('not-permitted', 'Cannot truncate network sockets');
  }

  stat(path: string): MaybePromise<FileStat, Sync> {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return { type: 'directory', size: 0n, mode: 0o755, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n } as MaybePromise<FileStat, Sync>;
    }
    const parts = normalized.split('/');
    // <host> — intermediate directory
    if (parts.length === 1) {
      return { type: 'directory', size: 0n, mode: 0o755, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n } as MaybePromise<FileStat, Sync>;
    }
    // <host>/<port> — character device
    if (parts.length === 2) {
      const port = parseInt(parts[1], 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        throw new FileSystemError('no-entry', `Invalid port: ${parts[1]}`);
      }
      return { type: 'character-device', size: 0n, mode: 0o666, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n } as MaybePromise<FileStat, Sync>;
    }
    throw new FileSystemError('no-entry', `Unknown network device path: ${path}`);
  }

  readdir(path: string): MaybePromise<DirEntry[], Sync> {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return [] as DirEntry[] as MaybePromise<DirEntry[], Sync>;
    }
    throw new FileSystemError('not-directory', `Not a directory: ${path}`);
  }

  mkdir(_path: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot mkdir on network devices'); }
  unlink(_path: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot unlink network devices'); }
  rmdir(_path: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot rmdir on network devices'); }
  rename(_o: string, _n: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot rename network devices'); }
  symlink(_t: string, _l: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot symlink network devices'); }
  readlink(_path: string): MaybePromise<string, Sync> { throw new FileSystemError('invalid', 'Network devices are not symlinks'); }
  link(_e: string, _n: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot link network devices'); }
  chmod(_path: string, _mode: number): MaybePromise<void, Sync> { return undefined as MaybePromise<void, Sync>; }
  utimes(_path: string, _atime: Date, _mtime: Date): MaybePromise<void, Sync> { return undefined as MaybePromise<void, Sync>; }
  mkfifo(_path: string): MaybePromise<void, Sync> { throw new FileSystemError('not-permitted', 'Cannot mkfifo on network devices'); }

  dispose(): void {
    for (const [, sock] of this.#handles) {
      if (sock.tcpSocket) try { sock.tcpSocket.close(); } catch { /* ignore */ }
      if (sock.udpSocket) try { sock.udpSocket.close(); } catch { /* ignore */ }
    }
    this.#handles.clear();
  }

  #parsePath(path: string): { host: string; port: number | undefined } {
    const normalized = path.replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (parts.length > 2) {
      throw new FileSystemError('invalid', `Too many path segments: ${path} (expected <host>/<port>)`);
    }
    if (parts.length < 2) {
      return { host: parts[0] ?? '', port: undefined };
    }
    const host = parts[0];
    const port = parseInt(parts[1], 10);
    if (isNaN(port) || port < 0 || port > 65535) {
      throw new FileSystemError('invalid', `Invalid port number: ${parts[1]}`);
    }
    return { host, port };
  }

  #resolveHost(host: string): MaybePromise<string, Sync> {
    const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const ipv6Regex = /^[0-9a-fA-F]*:[0-9a-fA-F:]*$/;
    if (ipv4Regex.test(host) || ipv6Regex.test(host)) {
      return host as MaybePromise<string, Sync>;
    }
    const addresses = this.#sockets.resolveName(host);
    if (addresses instanceof Promise) {
      return addresses.then((addrs) => {
        if (addrs.length === 0) {
          throw new FileSystemError('io', `DNS resolution failed for: ${host}`);
        }
        return addrs[0].address;
      }) as MaybePromise<string, Sync>;
    }
    const syncAddrs = addresses as { family: string; address: string }[];
    if (syncAddrs.length === 0) {
      throw new FileSystemError('io', `DNS resolution failed for: ${host}`);
    }
    return syncAddrs[0].address as MaybePromise<string, Sync>;
  }
}

export type SyncNetworkDeviceFsProvider = NetworkDeviceFsProvider<true> & SyncFileSystemProvider;
