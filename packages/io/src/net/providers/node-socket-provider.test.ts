import assert from 'node:assert/strict';
import * as net from 'node:net';
import { describe, it, beforeEach, afterEach } from 'node:test';
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
      // Start a raw echo server
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
      assert.equal(sent, 5);

      const received = await tcp.receive(1024);
      assert.equal(new TextDecoder().decode(received), 'hello');

      assert.ok(tcp.localAddress());
      assert.ok(tcp.remoteAddress());
      assert.equal(tcp.remoteAddress()!.port, addr.port);
    });
  });

  describe('TCP listen and accept', () => {
    it('binds, listens, accepts a client connection, and exchanges data', async () => {
      const serverSocket: TcpSocket = track(await provider.createTcpSocket());
      await serverSocket.bind({ host: '127.0.0.1', port: 0 });
      await serverSocket.listen();

      const serverAddr = serverSocket.localAddress()!;
      assert.ok(serverAddr.port > 0);

      // Connect a client
      const clientSocket: TcpSocket = track(await provider.createTcpSocket());
      const connectPromise = clientSocket.connect({ host: '127.0.0.1', port: serverAddr.port });

      const accepted: TcpSocket = track(await serverSocket.accept());
      await connectPromise;

      // Client sends, server-side accepted socket receives
      const payload = new TextEncoder().encode('world');
      await clientSocket.send(payload);
      const data = await accepted.receive(1024);
      assert.equal(new TextDecoder().decode(data), 'world');

      // Server-side sends back, client receives
      await accepted.send(new TextEncoder().encode('reply'));
      const reply = await clientSocket.receive(1024);
      assert.equal(new TextDecoder().decode(reply), 'reply');
    });
  });

  describe('UDP send and receive', () => {
    it('sends data from one socket to another and receives it', async () => {
      const receiver: UdpSocket = track(await provider.createUdpSocket());
      await receiver.bind({ host: '127.0.0.1', port: 0 });
      const receiverAddr = receiver.localAddress()!;
      assert.ok(receiverAddr.port > 0);

      const sender: UdpSocket = track(await provider.createUdpSocket());
      await sender.bind({ host: '127.0.0.1', port: 0 });

      const payload = new TextEncoder().encode('udp-test');
      const receivePromise = receiver.receive(1024);

      await sender.send(payload, receiverAddr);
      const result = await receivePromise;

      assert.equal(new TextDecoder().decode(result.data), 'udp-test');
      assert.equal(result.remoteAddress.host, '127.0.0.1');
      assert.equal(result.remoteAddress.port, sender.localAddress()!.port);
    });
  });

  describe('resolveName', () => {
    it('resolves localhost to at least one IP address', async () => {
      const addresses = await provider.resolveName('localhost');
      assert.ok(addresses.length > 0);
      assert.equal(addresses[0].family, 'ipv4');
      assert.ok(addresses[0].address.length > 0);
    });
  });

  describe('close cleans up', () => {
    it('TCP socket is destroyed after close', async () => {
      const tcp: TcpSocket = await provider.createTcpSocket();
      await tcp.close();
      // Calling close again should not throw
      await tcp.close();
    });

    it('UDP socket is closed after close', async () => {
      const udp: UdpSocket = await provider.createUdpSocket();
      await udp.bind({ host: '127.0.0.1', port: 0 });
      await udp.close();
      // Sending after close should throw
      await assert.rejects(
        async () => { await udp.send(new Uint8Array(1), { host: '127.0.0.1', port: 9999 }); },
      );
    });
  });
});
