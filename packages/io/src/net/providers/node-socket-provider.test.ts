import * as net from 'node:net';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { NodeSocketProvider } from './node-socket-provider.ts';
import type { TcpSocket, UdpSocket } from '../sockets.ts';

describe('NodeSocketProvider', () => {
  let provider: NodeSocketProvider;
  const cleanups: (() => Promise<void> | void)[] = [];

  function track<T extends { close(): void | Promise<void> }>(resource: T): T {
    cleanups.push(() => resource.close());
    return resource;
  }

  afterEach(async () => {
    const fns = cleanups.splice(0);
    for (const fn of fns.reverse()) {
      try { await fn(); } catch { /* already closed */ }
    }
  });

  beforeEach(() => {
    provider = new NodeSocketProvider();
  });

  describe('TCP connect and send/receive', () => {
    it('connects to a raw net.Server, sends data, and receives echo', async () => {
      const server = net.createServer((socket) => {
        socket.on('data', (chunk) => socket.write(chunk));
      });
      cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const addr = server.address() as net.AddressInfo;

      const tcp: TcpSocket = track(await provider.createTcpSocket());
      await tcp.connect({ host: '127.0.0.1', port: addr.port });

      const message = new TextEncoder().encode('hello');
      const sent = await tcp.send(message);
      expect(sent).toBe(5);

      const received = await tcp.receive(1024);
      expect(new TextDecoder().decode(received)).toBe('hello');

      expect(tcp.localAddress()).toBeTruthy();
      expect(tcp.remoteAddress()).toBeTruthy();
      expect(tcp.remoteAddress()!.port).toBe(addr.port);
    });
  });

  describe('TCP listen and accept', () => {
    it('binds, listens, accepts a client connection, and exchanges data', async () => {
      const serverSocket: TcpSocket = track(await provider.createTcpSocket());
      await serverSocket.bind({ host: '127.0.0.1', port: 0 });
      await serverSocket.listen();

      const serverAddr = serverSocket.localAddress()!;
      expect(serverAddr.port).toBeGreaterThan(0);

      const clientSocket: TcpSocket = track(await provider.createTcpSocket());
      const connectPromise = clientSocket.connect({ host: '127.0.0.1', port: serverAddr.port });

      const accepted: TcpSocket = track(await serverSocket.accept());
      await connectPromise;

      const payload = new TextEncoder().encode('world');
      await clientSocket.send(payload);
      const data = await accepted.receive(1024);
      expect(new TextDecoder().decode(data)).toBe('world');

      await accepted.send(new TextEncoder().encode('reply'));
      const reply = await clientSocket.receive(1024);
      expect(new TextDecoder().decode(reply)).toBe('reply');
    });
  });

  describe('UDP send and receive', () => {
    it('sends data from one socket to another and receives it', async () => {
      const receiver: UdpSocket = track(await provider.createUdpSocket());
      await receiver.bind({ host: '127.0.0.1', port: 0 });
      const receiverAddr = receiver.localAddress()!;
      expect(receiverAddr.port).toBeGreaterThan(0);

      const sender: UdpSocket = track(await provider.createUdpSocket());
      await sender.bind({ host: '127.0.0.1', port: 0 });

      const payload = new TextEncoder().encode('udp-test');
      const receivePromise = receiver.receive(1024);

      await sender.send(payload, receiverAddr);
      const result = await receivePromise;

      expect(new TextDecoder().decode(result.data)).toBe('udp-test');
      expect(result.remoteAddress.host).toBe('127.0.0.1');
      expect(result.remoteAddress.port).toBe(sender.localAddress()!.port);
    });
  });

  describe('resolveName', () => {
    it('resolves localhost to at least one IP address', async () => {
      const addresses = await provider.resolveName('localhost');
      expect(addresses.length).toBeGreaterThan(0);
      expect(addresses[0].family === 'ipv4' || addresses[0].family === 'ipv6').toBe(true);
      expect(addresses[0].address.length).toBeGreaterThan(0);
    });
  });

  describe('close cleans up', () => {
    it('TCP socket is destroyed after close', async () => {
      const tcp: TcpSocket = await provider.createTcpSocket();
      await tcp.close();
      await tcp.close(); // Calling close again should not throw
    });

    it('UDP socket is closed after close', async () => {
      const udp: UdpSocket = await provider.createUdpSocket();
      await udp.bind({ host: '127.0.0.1', port: 0 });
      await udp.close();
      await expect(udp.send(new Uint8Array(1), { host: '127.0.0.1', port: 9999 })).rejects.toBeDefined();
    });
  });
});
