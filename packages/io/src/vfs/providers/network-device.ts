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

/**
 * One entry in a {@link NetworkDeviceFsProviderOptions.allow} host allowlist.
 * `host` is matched case-insensitively against the REQUESTED host (the literal
 * path segment, before DNS resolution — so the gate keys on what the caller
 * asked for, not on a resolved IP that DNS rebinding could vary). When `port`
 * is omitted, any port on `host` is permitted.
 */
export interface NetworkAllowEntry {
  host: string;
  port?: number;
}

export interface NetworkDeviceFsProviderOptions {
  sockets: SocketProvider;
  protocol: Protocol;
  /**
   * Capability gate: an explicit allowlist of `host[:port]` targets this device
   * may connect to. Enforced deny-by-default — an `open` of a host:port NOT on
   * the list is rejected with FileSystemError('access') BEFORE any socket is
   * created (so no SSRF / no connection side-effect). An empty array denies
   * everything. When OMITTED (`undefined`), the device is ungated and the mount
   * site is responsible for restricting reachability (e.g. the kernel `fs`
   * capability on the `/dev/tcp` subtree). The capability-safe wiring derives
   * this list from the spawning process's `net` capability origins — see
   * {@link mountNetworkDevices}.
   */
  allow?: NetworkAllowEntry[];
}

/**
 * Virtual filesystem provider for /dev/tcp or /dev/udp.
 * Mount one instance at /dev/tcp (protocol='tcp') and one at /dev/udp (protocol='udp').
 * Paths are of the form <host>/<port> relative to the mount point.
 */
export class NetworkDeviceFsProvider implements FileSystemProvider {
  readonly #sockets: SocketProvider;
  readonly #protocol: Protocol;
  readonly #allow: NetworkAllowEntry[] | undefined;
  #nextFd = 200;
  #freeFds: number[] = [];
  #handles = new Map<number, SocketHandle>();
  #pathToFd = new Map<string, { fd: number; refCount: number }>();
  #pendingOpens = new Map<string, Promise<FileHandle>>();

  constructor(options: NetworkDeviceFsProviderOptions) {
    this.#sockets = options.sockets;
    this.#protocol = options.protocol;
    this.#allow = options.allow ? options.allow.map(e => ({ host: e.host.toLowerCase(), port: e.port })) : undefined;
  }

  async open(path: string, flags: OpenFlags): Promise<FileHandle> {
    const parsed = this.#parsePath(path);
    if (!parsed.port) {
      throw new FileSystemError('invalid', `Invalid network path: ${path} (expected <host>/<port>)`);
    }

    // Capability gate FIRST — before any socket is created — so a denied target
    // has no connection side-effect (SSRF-safe). Keyed on the REQUESTED host.
    if (!this.#isAllowed(parsed.host, parsed.port)) {
      throw new FileSystemError('access', `Permission denied: ${this.#protocol}/${parsed.host}/${parsed.port} not permitted by net capability`);
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

  /**
   * Capability gate: is `host:port` permitted? Ungated (no allowlist) → always
   * true. Otherwise the requested host must match an entry (case-insensitive),
   * and the entry's port must match (or be omitted = any port).
   */
  #isAllowed(host: string, port: number): boolean {
    if (this.#allow === undefined) return true;
    const h = host.toLowerCase();
    return this.#allow.some(e => e.host === h && (e.port === undefined || e.port === port));
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

/** The subset of {@link import('../router.ts').FileSystemRouter} this helper needs. */
export interface MountableRouter {
  mount(mountPoint: string, provider: FileSystemProvider): Promise<void> | void;
}

export interface MountNetworkDevicesOptions {
  sockets: SocketProvider;
  /**
   * Host allowlist shared by both `/dev/tcp` and `/dev/udp` (see
   * {@link NetworkDeviceFsProviderOptions.allow}). Derive it from the spawning
   * process's `net` capability origins via {@link netOriginsToAllow}. Omit to
   * mount UNGATED devices (only safe when the mount site otherwise restricts the
   * `/dev/tcp`+`/dev/udp` subtree, e.g. via the kernel `fs` capability).
   */
  allow?: NetworkAllowEntry[];
  /** Mount point for TCP (default `/dev/tcp`). */
  tcpMountPoint?: string;
  /** Mount point for UDP (default `/dev/udp`). */
  udpMountPoint?: string;
}

/**
 * Mount the raw-socket network devices at `/dev/tcp` and `/dev/udp` on `router`.
 *
 * This is the io-side half of the `/dev/tcp` path. Opening
 * `/dev/tcp/<host>/<port>` (or `/dev/udp/...`) through the VFS yields a
 * bidirectional stream fd, capability-gated by `allow` (deny-by-default when an
 * allowlist is supplied). Reads/writes on that fd map to socket receive/send.
 *
 * CROSS-CLUSTER INTEGRATION NOTE — what remains to make `exec 3<>/dev/tcp/...`
 * work end-to-end through the shell:
 *   1. KERNEL (mount hook): the kernel does not build the VFS — its caller does
 *      (the server/host integration or a test). The host must call
 *      `mountNetworkDevices(vfs, { sockets, allow: netOriginsToAllow(netOrigins) })`
 *      when constructing the router it hands to `new Kernel({ vfs })`, deriving
 *      `allow` from the process's `net` capability origins. Opening a
 *      `/dev/tcp/...` path then ALSO passes through the kernel's existing `fs`
 *      capability check on the `/dev/tcp` subtree (`#canonicalCheckedPath`), so a
 *      guest needs BOTH an `fs` grant on `/dev/tcp` AND a host on this allowlist —
 *      two independent gates, no ungated networking. No kernel SOURCE change is
 *      required for this; only the VFS-construction site wires the mount.
 *   2. SHELL (numbered-fd table + `<>`): `exec 3<>/dev/tcp/host/port`,
 *      `echo >&3`, `read -u 3`, and redirects to/from the device require the
 *      shell's numbered-fd table and the `<>` (read-write) redirect operator
 *      (parity finding H4 — owned by the shell agent). The shell opens the path
 *      via `fs/open` with `{read,write}` and reads/writes via `fs/read`/`fs/write`
 *      on the returned fd — exactly the surface this provider implements.
 * The provider + mount + capability gate proven here are the complete io-side
 * contribution; (1) is a one-line wiring at the host and (2) is the shell agent's.
 */
export async function mountNetworkDevices(router: MountableRouter, options: MountNetworkDevicesOptions): Promise<void> {
  const tcpMount = options.tcpMountPoint ?? '/dev/tcp';
  const udpMount = options.udpMountPoint ?? '/dev/udp';
  await router.mount(tcpMount, new NetworkDeviceFsProvider({
    sockets: options.sockets,
    protocol: 'tcp',
    ...(options.allow !== undefined ? { allow: options.allow } : {}),
  }));
  await router.mount(udpMount, new NetworkDeviceFsProvider({
    sockets: options.sockets,
    protocol: 'udp',
    ...(options.allow !== undefined ? { allow: options.allow } : {}),
  }));
}

/**
 * Convert `net` capability origins (e.g. `https://api.example.com`,
 * `tcp://127.0.0.1:9000`, `host:port`, or a bare `host`) into
 * {@link NetworkAllowEntry}s for {@link mountNetworkDevices}. Unparseable
 * entries are dropped. `http`/`https` map to their default port (80/443) when no
 * explicit port is present; `tcp`/`udp`/bare `host:port` carry the stated port;
 * a bare `host` permits any port on that host.
 */
export function netOriginsToAllow(origins: readonly string[]): NetworkAllowEntry[] {
  const out: NetworkAllowEntry[] = [];
  for (const origin of origins) {
    const entry = parseOriginToAllow(origin);
    if (entry) out.push(entry);
  }
  return out;
}

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

function parseOriginToAllow(origin: string): NetworkAllowEntry | undefined {
  const raw = origin.trim();
  if (raw === '') return undefined;
  // URL-shaped (scheme://host[:port]).
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    let u: URL;
    try { u = new URL(raw); } catch { return undefined; }
    if (!u.hostname) return undefined;
    const host = u.hostname.toLowerCase();
    if (u.port) return { host, port: Number(u.port) };
    const def = DEFAULT_PORTS[u.protocol];
    return def !== undefined ? { host, port: def } : { host };
  }
  // Bare `host:port` (a single colon, port numeric) — but not a bare IPv6.
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && raw.indexOf(':') === colon) {
    const host = raw.slice(0, colon).toLowerCase();
    const portStr = raw.slice(colon + 1);
    const port = Number(portStr);
    if (host && /^\d+$/.test(portStr) && port >= 0 && port <= 65535) {
      return { host, port };
    }
  }
  // Bare host (any port). Reject obvious garbage (whitespace).
  if (/\s/.test(raw)) return undefined;
  if (raw.includes(':')) return undefined; // ambiguous (e.g. malformed)
  return { host: raw.toLowerCase() };
}
