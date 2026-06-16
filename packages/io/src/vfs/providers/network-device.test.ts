import { expect, describe, it, beforeEach } from 'vitest';
import { NetworkDeviceFsProvider } from './network-device.ts';
import { FileSystemError } from '../provider.ts';
import type { SyncSocketProvider, SyncTcpSocket, SyncUdpSocket, IpAddress, SocketAddress } from '../../net/sockets.ts';

function expectThrows<T extends Error = Error>(fn: () => unknown): T {
  let err: T | undefined;
  expect(() => { try { fn(); } catch (e) { err = e as T; throw e; } }).toThrow();
  return err!;
}

function createMockTcpSocket(): SyncTcpSocket & { calls: string[]; sendData: Uint8Array[]; receiveData: Uint8Array } {
  const socket = {
    calls: [] as string[],
    sendData: [] as Uint8Array[],
    receiveData: new Uint8Array([72, 101, 108, 108, 111]),
    bind(address: SocketAddress): void { socket.calls.push(`bind:${address.host}:${address.port}`); },
    connect(address: SocketAddress): void { socket.calls.push(`connect:${address.host}:${address.port}`); },
    listen(_backlog?: number): void { socket.calls.push('listen'); },
    accept(): SyncTcpSocket { socket.calls.push('accept'); return createMockTcpSocket(); },
    send(data: Uint8Array): number { socket.calls.push('send'); socket.sendData.push(data); return data.byteLength; },
    receive(_len: number): Uint8Array { socket.calls.push('receive'); return socket.receiveData; },
    shutdown(): void { socket.calls.push('shutdown'); },
    close(): void { socket.calls.push('close'); },
    localAddress(): SocketAddress | undefined { return undefined; },
    remoteAddress(): SocketAddress | undefined { return undefined; },
  };
  return socket;
}

function createMockUdpSocket(): SyncUdpSocket & { calls: string[]; sendData: Array<{ data: Uint8Array; addr: SocketAddress }>; receiveData: Uint8Array } {
  const socket = {
    calls: [] as string[],
    sendData: [] as Array<{ data: Uint8Array; addr: SocketAddress }>,
    receiveData: new Uint8Array([85, 68, 80]),
    bind(address: SocketAddress): void { socket.calls.push(`bind:${address.host}:${address.port}`); },
    send(data: Uint8Array, remoteAddress: SocketAddress): number {
      socket.calls.push('send');
      socket.sendData.push({ data, addr: remoteAddress });
      return data.byteLength;
    },
    receive(_len: number): { data: Uint8Array; remoteAddress: SocketAddress } {
      socket.calls.push('receive');
      return { data: socket.receiveData, remoteAddress: { host: '127.0.0.1', port: 9999 } };
    },
    close(): void { socket.calls.push('close'); },
    localAddress(): SocketAddress | undefined { return undefined; },
  };
  return socket;
}

function createMockSocketProvider(): SyncSocketProvider & { lastTcp: ReturnType<typeof createMockTcpSocket> | null; lastUdp: ReturnType<typeof createMockUdpSocket> | null; allTcp: ReturnType<typeof createMockTcpSocket>[]; resolveResult: IpAddress[]; resolvedNames: string[] } {
  const provider = {
    lastTcp: null as ReturnType<typeof createMockTcpSocket> | null,
    lastUdp: null as ReturnType<typeof createMockUdpSocket> | null,
    allTcp: [] as ReturnType<typeof createMockTcpSocket>[],
    resolveResult: [{ family: 'ipv4' as const, address: '93.184.216.34' }] as IpAddress[],
    resolvedNames: [] as string[],
    createTcpSocket(): SyncTcpSocket {
      provider.lastTcp = createMockTcpSocket();
      provider.allTcp.push(provider.lastTcp);
      return provider.lastTcp;
    },
    createUdpSocket(): SyncUdpSocket {
      provider.lastUdp = createMockUdpSocket();
      return provider.lastUdp;
    },
    resolveName(name: string): IpAddress[] {
      provider.resolvedNames.push(name);
      return provider.resolveResult;
    },
  };
  return provider;
}

describe('NetworkDeviceFsProvider (tcp)', () => {
  let provider: NetworkDeviceFsProvider<true>;
  let mockSockets: ReturnType<typeof createMockSocketProvider>;

  beforeEach(() => {
    mockSockets = createMockSocketProvider();
    provider = new NetworkDeviceFsProvider({ sockets: mockSockets, protocol: 'tcp' });
  });

  describe('stat', () => {
    it('returns directory type for root', () => {
      const stat = provider.stat('/');
      expect(stat.type).toBe('directory');
    });

    it('returns directory type for /host (intermediate path)', () => {
      const stat = provider.stat('/localhost');
      expect(stat.type).toBe('directory');
    });

    it('returns character-device type for /host/port', () => {
      const stat = provider.stat('/localhost/8080');
      expect(stat.type).toBe('character-device');
      expect(stat.mode).toBe(0o666);
    });

    it('throws no-entry for invalid port', () => {
      const err = expectThrows<FileSystemError>(() => provider.stat('/host/99999'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });

    it('throws no-entry for too many segments', () => {
      const err = expectThrows<FileSystemError>(() => provider.stat('/host/port/extra'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('no-entry');
    });
  });

  describe('readdir', () => {
    it('returns empty array for root (dynamic hosts)', () => {
      const entries = provider.readdir('/');
      expect(entries).toEqual([]);
    });

    it('throws not-directory for host path', () => {
      const err = expectThrows<FileSystemError>(() => provider.readdir('/localhost'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-directory');
    });
  });

  describe('open', () => {
    it('creates TCP socket and connects', () => {
      const handle = provider.open('/127.0.0.1/8080', { read: true, write: true });
      expect(handle.fd >= 200).toBe(true);
      expect(mockSockets.lastTcp).toBeTruthy();
      expect(mockSockets.lastTcp!.calls).toContain('connect:127.0.0.1:8080');
      provider.close(handle);
    });

    it('resolves hostname via DNS', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '93.184.216.34' }];
      const handle = provider.open('/example.com/80', { read: true, write: true });
      expect(mockSockets.lastTcp!.calls).toContain('connect:93.184.216.34:80');
      provider.close(handle);
    });

    it('throws io error when connection fails', () => {
      const failingSockets: SyncSocketProvider = {
        createTcpSocket() {
          return {
            ...createMockTcpSocket(),
            connect() { throw new Error('Connection refused'); },
          };
        },
        createUdpSocket() { return createMockUdpSocket(); },
        resolveName() { return []; },
      };
      const failProvider = new NetworkDeviceFsProvider({ sockets: failingSockets, protocol: 'tcp' });
      const err = expectThrows<FileSystemError>(() => failProvider.open('/127.0.0.1/9999', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('io');
    });

    it('throws when port is missing', () => {
      const err = expectThrows<FileSystemError>(() => provider.open('/localhost', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });

    it('throws when DNS resolution returns empty', () => {
      mockSockets.resolveResult = [];
      const err = expectThrows<FileSystemError>(() => provider.open('/nosuchhost.invalid/80', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('io');
    });
  });

  describe('read', () => {
    it('reads data from TCP socket', () => {
      const handle = provider.open('/127.0.0.1/8080', { read: true });
      const data = provider.read(handle, 0, 1024);
      expect(data).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
      expect(mockSockets.lastTcp!.calls).toContain('receive');
      provider.close(handle);
    });

    it('throws on invalid fd', () => {
      const err = expectThrows<FileSystemError>(() => provider.read({ fd: 999, path: '', flags: {} }, 0, 100));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });
  });

  describe('write', () => {
    it('sends data to TCP socket', () => {
      const handle = provider.open('/127.0.0.1/8080', { write: true });
      const payload = new TextEncoder().encode('hello');
      const written = provider.write(handle, payload, 0);
      expect(written).toBe(5);
      expect(mockSockets.lastTcp!.calls).toContain('send');
      expect(mockSockets.lastTcp!.sendData[0]).toEqual(payload);
      provider.close(handle);
    });

    it('throws on invalid fd', () => {
      const err = expectThrows<FileSystemError>(() => provider.write({ fd: 999, path: '', flags: {} }, new Uint8Array(1), 0));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });
  });

  describe('close', () => {
    it('closes TCP socket', () => {
      const handle = provider.open('/127.0.0.1/8080', { read: true });
      provider.close(handle);
      expect(mockSockets.lastTcp!.calls).toContain('close');
    });

    it('does not throw for unknown fd', () => {
      expect(() => provider.close({ fd: 999, path: '', flags: {} })).not.toThrow();
    });
  });

  describe('mutation operations throw not-permitted', () => {
    it('mkdir throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.mkdir('/host'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('unlink throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.unlink('/host/80'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('rmdir throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.rmdir('/'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('rename throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.rename('/a', '/b'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('symlink throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.symlink('/a', '/b'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('link throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.link('/a', '/b'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('mkfifo throws', () => {
      const err = expectThrows<FileSystemError>(() => provider.mkfifo('/pipe'));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
    });

    it('truncate throws', () => {
      const handle = provider.open('/127.0.0.1/80', { write: true });
      const err = expectThrows<FileSystemError>(() => provider.truncate(handle, 0));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('not-permitted');
      provider.close(handle);
    });
  });

  describe('dispose', () => {
    it('closes all open sockets', () => {
      provider.open('/127.0.0.1/80', { read: true });
      const tcp1 = mockSockets.lastTcp!;
      provider.dispose();
      expect(tcp1.calls).toContain('close');
    });
  });

  describe('concurrent connections', () => {
    it('opens multiple fds simultaneously with unique fd numbers', () => {
      const h1 = provider.open('/127.0.0.1/8080', { read: true, write: true });
      const h2 = provider.open('/127.0.0.1/9090', { read: true, write: true });
      expect(h1.fd).not.toBe(h2.fd);
      expect(mockSockets.allTcp.length).toBe(2);
      provider.close(h1);
      provider.close(h2);
    });

    it('each fd reads/writes independently', () => {
      const h1 = provider.open('/127.0.0.1/8080', { read: true, write: true });
      const tcp1 = mockSockets.lastTcp!;
      tcp1.receiveData = new Uint8Array([1, 2, 3]);

      const h2 = provider.open('/127.0.0.1/9090', { read: true, write: true });
      const tcp2 = mockSockets.lastTcp!;
      tcp2.receiveData = new Uint8Array([4, 5, 6]);

      expect(provider.read(h1, 0, 100)).toEqual(new Uint8Array([1, 2, 3]));
      expect(provider.read(h2, 0, 100)).toEqual(new Uint8Array([4, 5, 6]));

      provider.write(h1, new Uint8Array([10]), 0);
      provider.write(h2, new Uint8Array([20]), 0);
      expect(tcp1.sendData[0]).toEqual(new Uint8Array([10]));
      expect(tcp2.sendData[0]).toEqual(new Uint8Array([20]));

      provider.close(h1);
      provider.close(h2);
    });
  });

  describe('read after write (bidirectional)', () => {
    it('can write then read on same handle', () => {
      const handle = provider.open('/127.0.0.1/8080', { read: true, write: true });
      const payload = new TextEncoder().encode('request');
      provider.write(handle, payload, 0);
      const response = provider.read(handle, 0, 1024);
      expect(response).toEqual(mockSockets.lastTcp!.receiveData);
      expect(mockSockets.lastTcp!.calls).toContain('send');
      expect(mockSockets.lastTcp!.calls).toContain('receive');
      provider.close(handle);
    });
  });

  describe('error during receive', () => {
    it('propagates socket receive error', () => {
      const failingSockets: SyncSocketProvider = {
        createTcpSocket() {
          return {
            ...createMockTcpSocket(),
            receive() { throw new Error('Connection reset'); },
          };
        },
        createUdpSocket() { return createMockUdpSocket(); },
        resolveName() { return [{ family: 'ipv4' as const, address: '127.0.0.1' }]; },
      };
      const failProvider = new NetworkDeviceFsProvider({ sockets: failingSockets, protocol: 'tcp' });
      const handle = failProvider.open('/127.0.0.1/8080', { read: true });
      const err = expectThrows<Error>(() => failProvider.read(handle, 0, 1024));
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Connection reset');
    });
  });

  describe('error during send', () => {
    it('propagates socket send error', () => {
      const failingSockets: SyncSocketProvider = {
        createTcpSocket() {
          return {
            ...createMockTcpSocket(),
            send() { throw new Error('Broken pipe'); },
          };
        },
        createUdpSocket() { return createMockUdpSocket(); },
        resolveName() { return [{ family: 'ipv4' as const, address: '127.0.0.1' }]; },
      };
      const failProvider = new NetworkDeviceFsProvider({ sockets: failingSockets, protocol: 'tcp' });
      const handle = failProvider.open('/127.0.0.1/8080', { write: true });
      const err = expectThrows<Error>(() => failProvider.write(handle, new Uint8Array([1]), 0));
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe('Broken pipe');
    });
  });

  describe('fd recycling', () => {
    it('reuses fd after close', () => {
      const h1 = provider.open('/127.0.0.1/8080', { read: true });
      const fd1 = h1.fd;
      provider.close(h1);

      const h2 = provider.open('/127.0.0.1/9090', { read: true });
      expect(h2.fd).toBe(fd1);
      provider.close(h2);
    });

    it('uses free list in LIFO order', () => {
      const h1 = provider.open('/127.0.0.1/8080', { read: true });
      const h2 = provider.open('/127.0.0.1/9090', { read: true });
      const fd1 = h1.fd;
      const fd2 = h2.fd;
      provider.close(h1);
      provider.close(h2);

      const h3 = provider.open('/127.0.0.1/3000', { read: true });
      expect(h3.fd).toBe(fd2);
      const h4 = provider.open('/127.0.0.1/4000', { read: true });
      expect(h4.fd).toBe(fd1);
      provider.close(h3);
      provider.close(h4);
    });

    it('allocates new fd when free list is empty', () => {
      const h1 = provider.open('/127.0.0.1/8080', { read: true });
      const h2 = provider.open('/127.0.0.1/9090', { read: true });
      const fd2 = h2.fd;
      // Don't close h1 or h2 - free list is empty, next should be fd2 + 1
      const h3 = provider.open('/127.0.0.1/3000', { read: true });
      expect(h3.fd).toBe(fd2 + 1);
      provider.close(h1);
      provider.close(h2);
      provider.close(h3);
    });
  });

  describe('IPv6 address detection', () => {
    it('treats address with colons as IPv6 (no DNS)', () => {
      const handle = provider.open('/::1/8080', { read: true });
      expect(mockSockets.lastTcp).toBeTruthy();
      expect(mockSockets.lastTcp!.calls).toContain('connect:::1:8080');
      expect(mockSockets.resolvedNames.length).toBe(0);
      provider.close(handle);
    });

    it('treats full IPv6 address as literal (no DNS)', () => {
      const handle = provider.open('/2001:db8::1/443', { read: true });
      expect(mockSockets.lastTcp!.calls).toContain('connect:2001:db8::1:443');
      expect(mockSockets.resolvedNames.length).toBe(0);
      provider.close(handle);
    });

    it('hostname that looks like hex "cafe" goes through DNS', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '1.2.3.4' }];
      const handle = provider.open('/cafe/80', { read: true });
      expect(mockSockets.resolvedNames).toContain('cafe');
      expect(mockSockets.lastTcp!.calls).toContain('connect:1.2.3.4:80');
      provider.close(handle);
    });

    it('hostname "dead" goes through DNS', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '5.6.7.8' }];
      const handle = provider.open('/dead/80', { read: true });
      expect(mockSockets.resolvedNames).toContain('dead');
      provider.close(handle);
    });

    it('hostname "bad" goes through DNS', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '9.10.11.12' }];
      const handle = provider.open('/bad/80', { read: true });
      expect(mockSockets.resolvedNames).toContain('bad');
      provider.close(handle);
    });

    it('hostname "abc" goes through DNS', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '1.1.1.1' }];
      const handle = provider.open('/abc/80', { read: true });
      expect(mockSockets.resolvedNames).toContain('abc');
      provider.close(handle);
    });
  });

  describe('path validation', () => {
    it('rejects path with extra segments', () => {
      const err = expectThrows<FileSystemError>(() => provider.open('/host/80/extra', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });

    it('rejects path with many extra segments', () => {
      const err = expectThrows<FileSystemError>(() => provider.open('/host/80/extra/stuff/here', { read: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });
  });
});

describe('NetworkDeviceFsProvider (udp)', () => {
  let provider: NetworkDeviceFsProvider<true>;
  let mockSockets: ReturnType<typeof createMockSocketProvider>;

  beforeEach(() => {
    mockSockets = createMockSocketProvider();
    provider = new NetworkDeviceFsProvider({ sockets: mockSockets, protocol: 'udp' });
  });

  describe('stat', () => {
    it('returns directory type for root', () => {
      const stat = provider.stat('/');
      expect(stat.type).toBe('directory');
    });

    it('returns character-device type for /host/port', () => {
      const stat = provider.stat('/192.168.1.1/53');
      expect(stat.type).toBe('character-device');
    });
  });

  describe('open', () => {
    it('creates UDP socket and binds', () => {
      const handle = provider.open('/127.0.0.1/53', { read: true, write: true });
      expect(handle.fd >= 200).toBe(true);
      expect(mockSockets.lastUdp).toBeTruthy();
      expect(mockSockets.lastUdp!.calls).toContain('bind:0.0.0.0:0');
      provider.close(handle);
    });
  });

  describe('read', () => {
    it('reads data from UDP socket', () => {
      const handle = provider.open('/127.0.0.1/53', { read: true });
      const data = provider.read(handle, 0, 512);
      expect(data).toEqual(new Uint8Array([85, 68, 80]));
      expect(mockSockets.lastUdp!.calls).toContain('receive');
      provider.close(handle);
    });
  });

  describe('write', () => {
    it('sends data to UDP socket with remote address', () => {
      const handle = provider.open('/10.0.0.1/5353', { write: true });
      const payload = new TextEncoder().encode('query');
      const written = provider.write(handle, payload, 0);
      expect(written).toBe(5);
      expect(mockSockets.lastUdp!.calls).toContain('send');
      expect(mockSockets.lastUdp!.sendData[0].addr.host).toBe('10.0.0.1');
      expect(mockSockets.lastUdp!.sendData[0].addr.port).toBe(5353);
      provider.close(handle);
    });
  });

  describe('close', () => {
    it('closes UDP socket', () => {
      const handle = provider.open('/127.0.0.1/53', { read: true });
      provider.close(handle);
      expect(mockSockets.lastUdp!.calls).toContain('close');
    });
  });

  describe('dispose', () => {
    it('closes all open sockets', () => {
      provider.open('/127.0.0.1/53', { read: true });
      const udp1 = mockSockets.lastUdp!;
      provider.dispose();
      expect(udp1.calls).toContain('close');
    });
  });

  describe('UDP send with remote address', () => {
    it('sets correct remote host and port for each send', () => {
      const handle = provider.open('/192.168.1.100/9999', { write: true });
      const data = new TextEncoder().encode('ping');
      provider.write(handle, data, 0);
      expect(mockSockets.lastUdp!.sendData[0].addr.host).toBe('192.168.1.100');
      expect(mockSockets.lastUdp!.sendData[0].addr.port).toBe(9999);
      provider.close(handle);
    });

    it('uses raw hostname as remote address for send (UDP is connectionless)', () => {
      mockSockets.resolveResult = [{ family: 'ipv4', address: '8.8.8.8' }];
      const handle = provider.open('/dns.google/53', { write: true });
      const data = new TextEncoder().encode('query');
      provider.write(handle, data, 0);
      expect(mockSockets.lastUdp!.sendData[0].addr.host).toBe('dns.google');
      expect(mockSockets.lastUdp!.sendData[0].addr.port).toBe(53);
      provider.close(handle);
    });
  });

  describe('fd recycling (udp)', () => {
    it('reuses fd after close', () => {
      const h1 = provider.open('/127.0.0.1/53', { read: true });
      const fd1 = h1.fd;
      provider.close(h1);

      const h2 = provider.open('/127.0.0.1/5353', { read: true });
      expect(h2.fd).toBe(fd1);
      provider.close(h2);
    });
  });

  describe('path validation (udp)', () => {
    it('rejects path with extra segments', () => {
      const err = expectThrows<FileSystemError>(() => provider.open('/host/53/extra', { write: true }));
      expect(err).toBeInstanceOf(FileSystemError);
      expect(err.code).toBe('invalid');
    });
  });
});
