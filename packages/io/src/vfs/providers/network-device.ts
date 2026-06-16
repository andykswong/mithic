import type { FileHandle, OpenFlags, DirEntry, FileStat, FileSystemProvider } from '../provider.ts';
import { FileSystemError } from '../provider.ts';
import type { SocketProvider, TcpSocket, UdpSocket } from '../../net/sockets.ts';

type Protocol = 'tcp' | 'udp';

interface SocketHandle {
  protocol: Protocol;
  tcpSocket?: TcpSocket;
  udpSocket?: UdpSocket;
  remoteHost: string;
  remotePort: number;
}

export interface NetworkDeviceFsProviderOptions {
  sockets: SocketProvider;
  protocol: Protocol;
}

/**
 * Virtual filesystem provider for /dev/tcp or /dev/udp.
 * Mount one instance at /dev/tcp (protocol='tcp') and one at /dev/udp (protocol='udp').
 * Paths are of the form <host>/<port> relative to the mount point.
 */
export class NetworkDeviceFsProvider implements FileSystemProvider {
  readonly #sockets: SocketProvider;
  readonly #protocol: Protocol;
  #nextFd = 200;
  #freeFds: number[] = [];
  #handles = new Map<number, SocketHandle>();
  #pathToFd = new Map<string, { fd: number; refCount: number }>();
  #pendingOpens = new Map<string, Promise<FileHandle>>();

  constructor(options: NetworkDeviceFsProviderOptions) {
    this.#sockets = options.sockets;
    this.#protocol = options.protocol;
  }

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    const parsed = this.#parsePath(path);
    if (!parsed.port) {
      throw new FileSystemError('invalid', `Invalid network path: ${path} (expected <host>/<port>)`);
    }

    const normalizedPath = `${parsed.host}/${parsed.port}`;
    const existing = this.#pathToFd.get(normalizedPath);
    if (existing && this.#handles.has(existing.fd)) {
      existing.refCount++;
      return { fd: existing.fd, path, flags };
    }

    const pending = this.#pendingOpens.get(normalizedPath);
    if (pending) {
      return pending.then(() => {
        const entry = this.#pathToFd.get(normalizedPath);
        if (entry && this.#handles.has(entry.fd)) {
          entry.refCount++;
          return { fd: entry.fd, path, flags };
        }
        return this.open(path, flags);
      });
    }

    const fd = this.#freeFds.length > 0 ? this.#freeFds.pop()! : this.#nextFd++;
    const handle: SocketHandle = {
      protocol: this.#protocol,
      remoteHost: parsed.host,
      remotePort: parsed.port,
    };

    const host = await this.#resolveHost(parsed.host);

    if (this.#protocol === 'tcp') {
      const openPromise = (async () => {
        const socket = await Promise.resolve(this.#sockets.createTcpSocket());
        try {
          await Promise.resolve(socket.connect({ host, port: parsed.port! }));
        } catch (e) {
          try { socket.close(); } catch { /* ignore */ }
          throw new FileSystemError('io', `Failed to connect to ${parsed.host}:${parsed.port}: ${e instanceof Error ? e.message : String(e)}`);
        }
        handle.tcpSocket = socket;
        this.#handles.set(fd, handle);
        this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
        return { fd, path, flags };
      })();
      this.#pendingOpens.set(normalizedPath, openPromise);
      return openPromise.finally(() => {
        this.#pendingOpens.delete(normalizedPath);
      });
    }

    const openPromise = (async () => {
      const socket = await Promise.resolve(this.#sockets.createUdpSocket());
      try {
        await Promise.resolve(socket.bind({ host: '0.0.0.0', port: 0 }));
      } catch (e) {
        try { socket.close(); } catch { /* ignore */ }
        throw new FileSystemError('io', `Failed to bind UDP socket: ${e instanceof Error ? e.message : String(e)}`);
      }
      handle.udpSocket = socket;
      this.#handles.set(fd, handle);
      this.#pathToFd.set(normalizedPath, { fd, refCount: 1 });
      return { fd, path, flags };
    })();
    this.#pendingOpens.set(normalizedPath, openPromise);
    return openPromise.finally(() => {
      this.#pendingOpens.delete(normalizedPath);
    });
  }

  close(handle: FileHandle): Promise<void> | void {
    const sock = this.#handles.get(handle.fd);
    if (!sock) return;
    const pathKey = `${sock.remoteHost}/${sock.remotePort}`;
    const entry = this.#pathToFd.get(pathKey);
    if (entry && entry.fd === handle.fd) {
      entry.refCount--;
      if (entry.refCount > 0) return;
      this.#pathToFd.delete(pathKey);
    }
    this.#handles.delete(handle.fd);
    this.#freeFds.push(handle.fd);
    if (sock.tcpSocket) {
      try { return Promise.resolve(sock.tcpSocket.close()); } catch { /* ignore */ }
    }
    if (sock.udpSocket) {
      try { return Promise.resolve(sock.udpSocket.close()); } catch { /* ignore */ }
    }
  }

  async read(handle: FileHandle, _offset: number, len: number): Promise<Uint8Array> {
    const sock = this.#handles.get(handle.fd);
    if (!sock) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);

    if (sock.protocol === 'tcp') {
      return Promise.resolve(sock.tcpSocket!.receive(len));
    }
    const result = await Promise.resolve(sock.udpSocket!.receive(len));
    return result.data;
  }

  async write(handle: FileHandle, data: Uint8Array, _offset: number): Promise<number> {
    const sock = this.#handles.get(handle.fd);
    if (!sock) throw new FileSystemError('invalid', `Invalid fd: ${handle.fd}`);

    if (sock.protocol === 'tcp') {
      return Promise.resolve(sock.tcpSocket!.send(data));
    }
    return Promise.resolve(sock.udpSocket!.send(data, { host: sock.remoteHost, port: sock.remotePort }));
  }

  truncate(_handle: FileHandle, _size: number): void {
    throw new FileSystemError('not-permitted', 'Cannot truncate network sockets');
  }

  stat(path: string): FileStat {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return { type: 'directory', size: 0n, mode: 0o755, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n };
    }
    const parts = normalized.split('/');
    if (parts.length === 1) {
      return { type: 'directory', size: 0n, mode: 0o755, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n };
    }
    if (parts.length === 2) {
      const port = parseInt(parts[1], 10);
      if (isNaN(port) || port < 0 || port > 65535) {
        throw new FileSystemError('no-entry', `Invalid port: ${parts[1]}`);
      }
      return { type: 'character-device', size: 0n, mode: 0o666, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), linkCount: 1n };
    }
    throw new FileSystemError('no-entry', `Unknown network device path: ${path}`);
  }

  readdir(path: string): DirEntry[] {
    const normalized = path.replace(/^\/+|\/+$/g, '');
    if (normalized === '') {
      return [];
    }
    throw new FileSystemError('not-directory', `Not a directory: ${path}`);
  }

  mkdir(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot mkdir on network devices'); }
  unlink(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot unlink network devices'); }
  rmdir(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot rmdir on network devices'); }
  rename(_o: string, _n: string): void { throw new FileSystemError('not-permitted', 'Cannot rename network devices'); }
  symlink(_t: string, _l: string): void { throw new FileSystemError('not-permitted', 'Cannot symlink network devices'); }
  readlink(_path: string): string { throw new FileSystemError('invalid', 'Network devices are not symlinks'); }
  link(_e: string, _n: string): void { throw new FileSystemError('not-permitted', 'Cannot link network devices'); }
  chmod(_path: string, _mode: number): void {}
  utimes(_path: string, _atime: Date, _mtime: Date): void {}
  mkfifo(_path: string): void { throw new FileSystemError('not-permitted', 'Cannot mkfifo on network devices'); }

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

  async #resolveHost(host: string): Promise<string> {
    const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    const ipv6Regex = /^[0-9a-fA-F]*:[0-9a-fA-F:]*$/;
    if (ipv4Regex.test(host) || ipv6Regex.test(host)) {
      return host;
    }
    const addresses = await Promise.resolve(this.#sockets.resolveName(host));
    if (addresses.length === 0) {
      throw new FileSystemError('io', `DNS resolution failed for: ${host}`);
    }
    return addresses[0].address;
  }
}
