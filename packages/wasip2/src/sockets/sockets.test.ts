import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert';

import { Network, type IpSocketAddress } from './network.ts';
import { TcpSocket, type ShutdownType } from './tcp.ts';
import { UdpSocket, IncomingDatagramStream, OutgoingDatagramStream } from './udp.ts';
import { createTcpSocket } from './tcp-create-socket.ts';
import { createUdpSocket } from './udp-create-socket.ts';
import { instanceNetwork } from './instance-network.ts';
import { resolveAddresses, ResolveAddressStream } from './ip-name-lookup.ts';
import type { SocketProvider, TcpSocket as IoTcpSocket, UdpSocket as IoUdpSocket } from '@mithic/io/net';

describe('Network', () => {
  it('creates a Network instance', () => {
    const net = new Network();
    strictEqual(net instanceof Network, true);
  });

  it('instanceNetwork returns a Network', () => {
    const net = instanceNetwork();
    strictEqual(net instanceof Network, true);
  });
});

describe('IpSocketAddress types', () => {
  it('constructs IPv4 socket address', () => {
    const addr: IpSocketAddress = {
      tag: 'ipv4',
      val: { port: 8080, address: [127, 0, 0, 1] },
    };
    strictEqual(addr.tag, 'ipv4');
    strictEqual(addr.val.port, 8080);
    deepStrictEqual(addr.val.address, [127, 0, 0, 1]);
  });

  it('constructs IPv6 socket address', () => {
    const addr: IpSocketAddress = {
      tag: 'ipv6',
      val: { port: 443, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 1], scopeId: 0 },
    };
    strictEqual(addr.tag, 'ipv6');
    strictEqual(addr.val.port, 443);
    deepStrictEqual(addr.val.address, [0, 0, 0, 0, 0, 0, 0, 1]);
    strictEqual(addr.val.flowInfo, 0);
    strictEqual(addr.val.scopeId, 0);
  });
});

describe('TcpSocket state machine', () => {
  it('createTcpSocket returns a TcpSocket in initial state', () => {
    const sock = createTcpSocket('ipv4');
    strictEqual(sock instanceof TcpSocket, true);
    strictEqual(sock.addressFamily(), 'ipv4');
    strictEqual(sock.isListening(), false);
  });

  it('createTcpSocket with ipv6 returns correct family', () => {
    const sock = createTcpSocket('ipv6');
    strictEqual(sock.addressFamily(), 'ipv6');
  });

  it('startBind in initial state does not throw', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    // startBind may throw due to DisabledSocketProvider, but the state validation passes
    // The actual error comes from the provider during finishBind
    sock.startBind(net, addr);
  });

  it('startBind in wrong state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    // Now in bind-in-progress; calling startBind again throws
    throws(
      () => sock.startBind(net, addr),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('startBind with wrong address family throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = {
      tag: 'ipv6',
      val: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 },
    };
    throws(
      () => sock.startBind(net, addr),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('finishBind without startBind throws not-in-progress', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.finishBind(),
      (err: unknown) => err === 'not-in-progress',
    );
  });

  it('startConnect in initial state does not throw on state validation', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [127, 0, 0, 1] } };
    sock.startConnect(net, addr);
  });

  it('startConnect with port 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [127, 0, 0, 1] } };
    throws(
      () => sock.startConnect(net, addr),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('startConnect in connected state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [127, 0, 0, 1] } };
    sock.startConnect(net, addr);
    // finishConnect will fail due to DisabledSocketProvider, putting us in closed state
    try { sock.finishConnect(); } catch { /* expected */ }
    throws(
      () => sock.startConnect(net, addr),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('startListen in initial state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.startListen(),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('finishListen without startListen throws not-in-progress', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.finishListen(),
      (err: unknown) => err === 'not-in-progress',
    );
  });

  it('accept in non-listening state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.accept(),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('shutdown in non-connected state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.shutdown('both' as ShutdownType),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('localAddress in initial state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.localAddress(),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('remoteAddress in non-connected state throws invalid-state', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.remoteAddress(),
      (err: unknown) => err === 'invalid-state',
    );
  });
});

describe('TcpSocket options', () => {
  it('setListenBacklogSize with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setListenBacklogSize(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setListenBacklogSize with valid value does not throw', () => {
    const sock = createTcpSocket('ipv4');
    sock.setListenBacklogSize(256n);
  });

  it('keepAliveEnabled defaults to false', () => {
    const sock = createTcpSocket('ipv4');
    strictEqual(sock.keepAliveEnabled(), false);
  });

  it('setKeepAliveEnabled changes value', () => {
    const sock = createTcpSocket('ipv4');
    sock.setKeepAliveEnabled(true);
    strictEqual(sock.keepAliveEnabled(), true);
  });

  it('setKeepAliveIdleTime with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setKeepAliveIdleTime(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setKeepAliveInterval with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setKeepAliveInterval(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setKeepAliveCount with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setKeepAliveCount(0),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setHopLimit with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setHopLimit(0),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setReceiveBufferSize with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setReceiveBufferSize(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setSendBufferSize with 0 throws invalid-argument', () => {
    const sock = createTcpSocket('ipv4');
    throws(
      () => sock.setSendBufferSize(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('hopLimit defaults to 64', () => {
    const sock = createTcpSocket('ipv4');
    strictEqual(sock.hopLimit(), 64);
  });

  it('setHopLimit updates value', () => {
    const sock = createTcpSocket('ipv4');
    sock.setHopLimit(128);
    strictEqual(sock.hopLimit(), 128);
  });

  it('subscribe returns a Pollable', () => {
    const sock = createTcpSocket('ipv4');
    const p = sock.subscribe();
    strictEqual(p.ready(), true);
  });
});

describe('UdpSocket state machine', () => {
  it('createUdpSocket returns a UdpSocket', () => {
    const sock = createUdpSocket('ipv4');
    strictEqual(sock instanceof UdpSocket, true);
    strictEqual(sock.addressFamily(), 'ipv4');
  });

  it('createUdpSocket with ipv6', () => {
    const sock = createUdpSocket('ipv6');
    strictEqual(sock.addressFamily(), 'ipv6');
  });

  it('startBind in initial state does not throw on state validation', () => {
    const sock = createUdpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
  });

  it('startBind in wrong state throws invalid-state', () => {
    const sock = createUdpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    throws(
      () => sock.startBind(net, addr),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('startBind with wrong family throws invalid-argument', () => {
    const sock = createUdpSocket('ipv4');
    const net = instanceNetwork();
    const addr: IpSocketAddress = {
      tag: 'ipv6',
      val: { port: 0, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 0], scopeId: 0 },
    };
    throws(
      () => sock.startBind(net, addr),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('finishBind without startBind throws not-in-progress', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.finishBind(),
      (err: unknown) => err === 'not-in-progress',
    );
  });

  it('stream in initial state throws invalid-state', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.stream(),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('localAddress in initial state throws invalid-state', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.localAddress(),
      (err: unknown) => err === 'invalid-state',
    );
  });

  it('remoteAddress without stream throws invalid-state', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.remoteAddress(),
      (err: unknown) => err === 'invalid-state',
    );
  });
});

describe('UdpSocket options', () => {
  it('setUnicastHopLimit with 0 throws invalid-argument', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.setUnicastHopLimit(0),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('unicastHopLimit defaults to 64', () => {
    const sock = createUdpSocket('ipv4');
    strictEqual(sock.unicastHopLimit(), 64);
  });

  it('setReceiveBufferSize with 0 throws invalid-argument', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.setReceiveBufferSize(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('setSendBufferSize with 0 throws invalid-argument', () => {
    const sock = createUdpSocket('ipv4');
    throws(
      () => sock.setSendBufferSize(0n),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('subscribe returns a Pollable', () => {
    const sock = createUdpSocket('ipv4');
    const p = sock.subscribe();
    strictEqual(p.ready(), true);
  });
});

describe('IP Name Lookup', () => {
  it('resolveAddresses returns a ResolveAddressStream', () => {
    const net = instanceNetwork();
    const stream = resolveAddresses(net, 'localhost');
    strictEqual(stream instanceof ResolveAddressStream, true);
  });

  it('resolveAddresses with empty name throws invalid-argument', () => {
    const net = instanceNetwork();
    throws(
      () => resolveAddresses(net, ''),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('ResolveAddressStream subscribe returns a Pollable', () => {
    const net = instanceNetwork();
    const stream = resolveAddresses(net, 'example.com');
    const p = stream.subscribe();
    strictEqual(p.ready(), true);
  });

  it('resolveNextAddress with DisabledSocketProvider throws resolver error after settling', async () => {
    const net = instanceNetwork();
    const stream = resolveAddresses(net, 'example.com');
    // Allow the promise rejection chain from DisabledSocketProvider to fully propagate.
    // The chain is: rejected promise -> .then() passthrough -> .catch() handler.
    // Each step requires a microtask, so we flush multiple microtasks.
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    throws(
      () => stream.resolveNextAddress(),
      (err: unknown) => err === 'name-unresolvable',
    );
  });
});

describe('IncomingDatagramStream', () => {
  it('receive with 0 maxResults returns empty', () => {
    const stream = new IncomingDatagramStream(null, 'ipv4');
    const result = stream.receive(0n);
    deepStrictEqual(result, []);
  });

  it('receive without socket returns empty', () => {
    const stream = new IncomingDatagramStream(null, 'ipv4');
    const result = stream.receive(10n);
    deepStrictEqual(result, []);
  });

  it('subscribe returns a ready Pollable', () => {
    const stream = new IncomingDatagramStream(null, 'ipv4');
    const p = stream.subscribe();
    strictEqual(p.ready(), true);
  });
});

describe('OutgoingDatagramStream', () => {
  it('checkSend without socket returns 0', () => {
    const stream = new OutgoingDatagramStream(null, 'ipv4', null);
    strictEqual(stream.checkSend(), 0n);
  });

  it('send without socket returns 0', () => {
    const stream = new OutgoingDatagramStream(null, 'ipv4', null);
    strictEqual(stream.send([]), 0n);
  });

  it('subscribe returns a ready Pollable', () => {
    const stream = new OutgoingDatagramStream(null, 'ipv4', null);
    const p = stream.subscribe();
    strictEqual(p.ready(), true);
  });
});

// --- Async SocketProvider tests ---

function createMockTcpSocket(): IoTcpSocket & { lastShutdownType?: string; lastSocketOptions?: Record<string, unknown> } {
  let bound = false;
  let connected = false;
  const mock: IoTcpSocket & { lastShutdownType?: string; lastSocketOptions?: Record<string, unknown> } = {
    bind() { bound = true; },
    connect() { connected = true; },
    listen() {},
    accept() { return createMockTcpSocket(); },
    send(data: Uint8Array) { return data.byteLength; },
    receive() { return new Uint8Array(0); },
    shutdown(type?: 'receive' | 'send' | 'both') { mock.lastShutdownType = type ?? 'both'; },
    close() {},
    localAddress() { return bound ? { host: '127.0.0.1', port: 1234 } : undefined; },
    remoteAddress() { return connected ? { host: '10.0.0.1', port: 80 } : undefined; },
    setSocketOptions(options) { mock.lastSocketOptions = options as Record<string, unknown>; },
  };
  return mock;
}

function createMockUdpSocket(receiveData?: Uint8Array, receiveFrom?: { host: string; port: number }): IoUdpSocket {
  let received = false;
  return {
    bind() {},
    send(_data: Uint8Array, _addr) { return 1; },
    receive() {
      if (receiveData && !received) {
        received = true;
        return { data: receiveData, remoteAddress: receiveFrom ?? { host: '10.0.0.1', port: 9000 } };
      }
      return { data: new Uint8Array(0), remoteAddress: { host: '0.0.0.0', port: 0 } };
    },
    close() {},
    localAddress() { return { host: '0.0.0.0', port: 5000 }; },
  };
}

function createAsyncSocketProvider(): SocketProvider {
  return {
    createTcpSocket() { return Promise.resolve(createMockTcpSocket()); },
    createUdpSocket() { return Promise.resolve(createMockUdpSocket()); },
    resolveName(_name: string) { return Promise.resolve([{ family: 'ipv4' as const, address: '1.2.3.4' }]); },
  };
}

function createSyncSocketProvider(): SocketProvider {
  return {
    createTcpSocket() { return createMockTcpSocket(); },
    createUdpSocket() { return createMockUdpSocket(); },
    resolveName(_name: string) { return [{ family: 'ipv4' as const, address: '5.6.7.8' }]; },
  };
}

describe('TcpSocket with async SocketProvider', () => {
  it('startBind with async provider sets bindDone after promise resolves', async () => {
    const sock = new TcpSocket('ipv4', createAsyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    // bindDone is false initially because provider is async
    throws(() => sock.finishBind(), (err: unknown) => err === 'would-block');
    // Wait for async resolution
    await new Promise(resolve => setTimeout(resolve, 10));
    sock.finishBind();
    strictEqual(sock.localAddress()!.val.port, 0);
  });

  it('startConnect with async provider resolves after promise settles', async () => {
    const sock = new TcpSocket('ipv4', createAsyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    throws(() => sock.finishConnect(), (err: unknown) => err === 'would-block');
    await new Promise(resolve => setTimeout(resolve, 10));
    const [input, output] = sock.finishConnect();
    strictEqual(input instanceof Object, true);
    strictEqual(output instanceof Object, true);
  });

  it('startListen with async provider resolves after promise settles', async () => {
    const sock = new TcpSocket('ipv4', createSyncSocketProvider());
    const net = new Network();
    const bindAddr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, bindAddr);
    sock.finishBind();
    sock.startListen();
    sock.finishListen();
    strictEqual(sock.isListening(), true);
  });
});

describe('TcpSocket with sync SocketProvider', () => {
  it('startBind with sync provider completes immediately', () => {
    const sock = new TcpSocket('ipv4', createSyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    sock.finishBind();
    strictEqual(sock.localAddress()!.val.port, 0);
  });

  it('startConnect with sync provider completes immediately', () => {
    const sock = new TcpSocket('ipv4', createSyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    const [input, output] = sock.finishConnect();
    strictEqual(input instanceof Object, true);
    strictEqual(output instanceof Object, true);
  });
});

describe('UdpSocket with async SocketProvider', () => {
  it('startBind with async provider resolves after promise settles', async () => {
    const sock = new UdpSocket('ipv4', createAsyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 5000, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    throws(() => sock.finishBind(), (err: unknown) => err === 'would-block');
    await new Promise(resolve => setTimeout(resolve, 10));
    sock.finishBind();
  });
});

describe('UdpSocket with sync SocketProvider', () => {
  it('startBind with sync provider completes immediately', () => {
    const sock = new UdpSocket('ipv4', createSyncSocketProvider());
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 5000, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    sock.finishBind();
  });
});

describe('ResolveAddressStream with async SocketProvider', () => {
  it('resolves names via async provider', async () => {
    const stream = new ResolveAddressStream('example.com', createAsyncSocketProvider());
    // Initially not resolved — throws would-block
    throws(() => stream.resolveNextAddress(), (err: unknown) => err === 'would-block');
    await new Promise(resolve => setTimeout(resolve, 10));
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
  });
});

describe('ResolveAddressStream with sync SocketProvider', () => {
  it('resolves names via sync provider immediately', () => {
    const stream = new ResolveAddressStream('example.com', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
  });
});

// --- TCP Shutdown Type Tests ---

describe('TcpSocket shutdown type', () => {
  it('shutdown("receive") passes type to provider', () => {
    const mockSocket = createMockTcpSocket();
    const provider: SocketProvider = {
      createTcpSocket() { return mockSocket; },
      createUdpSocket() { return createMockUdpSocket(); },
      resolveName() { return []; },
    };
    const sock = new TcpSocket('ipv4', provider);
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    sock.finishConnect();
    sock.shutdown('receive');
    strictEqual(mockSocket.lastShutdownType, 'receive');
  });

  it('shutdown("send") passes type to provider', () => {
    const mockSocket = createMockTcpSocket();
    const provider: SocketProvider = {
      createTcpSocket() { return mockSocket; },
      createUdpSocket() { return createMockUdpSocket(); },
      resolveName() { return []; },
    };
    const sock = new TcpSocket('ipv4', provider);
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    sock.finishConnect();
    sock.shutdown('send');
    strictEqual(mockSocket.lastShutdownType, 'send');
  });

  it('shutdown("both") passes type to provider', () => {
    const mockSocket = createMockTcpSocket();
    const provider: SocketProvider = {
      createTcpSocket() { return mockSocket; },
      createUdpSocket() { return createMockUdpSocket(); },
      resolveName() { return []; },
    };
    const sock = new TcpSocket('ipv4', provider);
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    sock.finishConnect();
    sock.shutdown('both');
    strictEqual(mockSocket.lastShutdownType, 'both');
  });

  it('shutdown in non-connected state throws invalid-state', () => {
    const sock = new TcpSocket('ipv4', createSyncSocketProvider());
    throws(
      () => sock.shutdown('both'),
      (err: unknown) => err === 'invalid-state',
    );
  });
});

// --- TCP Socket Options Tests ---

describe('TcpSocket socket options applied on finishBind', () => {
  it('setSocketOptions called after finishBind with stored values', () => {
    const mockSocket = createMockTcpSocket();
    const provider: SocketProvider = {
      createTcpSocket() { return mockSocket; },
      createUdpSocket() { return createMockUdpSocket(); },
      resolveName() { return []; },
    };
    const sock = new TcpSocket('ipv4', provider);
    sock.setKeepAliveEnabled(true);
    sock.setHopLimit(128);
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 0, address: [0, 0, 0, 0] } };
    sock.startBind(net, addr);
    sock.finishBind();
    strictEqual(mockSocket.lastSocketOptions!['keepAliveEnabled'], true);
    strictEqual(mockSocket.lastSocketOptions!['hopLimit'], 128);
  });
});

describe('TcpSocket socket options applied on finishConnect', () => {
  it('setSocketOptions called after finishConnect with stored values', () => {
    const mockSocket = createMockTcpSocket();
    const provider: SocketProvider = {
      createTcpSocket() { return mockSocket; },
      createUdpSocket() { return createMockUdpSocket(); },
      resolveName() { return []; },
    };
    const sock = new TcpSocket('ipv4', provider);
    sock.setKeepAliveEnabled(true);
    sock.setHopLimit(255);
    sock.setReceiveBufferSize(131072n);
    sock.setSendBufferSize(131072n);
    const net = new Network();
    const addr: IpSocketAddress = { tag: 'ipv4', val: { port: 80, address: [10, 0, 0, 1] } };
    sock.startConnect(net, addr);
    sock.finishConnect();
    strictEqual(mockSocket.lastSocketOptions!['keepAliveEnabled'], true);
    strictEqual(mockSocket.lastSocketOptions!['hopLimit'], 255);
    strictEqual(mockSocket.lastSocketOptions!['receiveBufferSize'], 131072);
    strictEqual(mockSocket.lastSocketOptions!['sendBufferSize'], 131072);
  });
});

// --- UDP Receive Tests ---

describe('UDP IncomingDatagramStream receive with sync provider', () => {
  it('receive(0n) returns empty', () => {
    const udpSock = createMockUdpSocket(new Uint8Array([1, 2, 3]), { host: '10.0.0.1', port: 9000 });
    const stream = new IncomingDatagramStream(udpSock, 'ipv4');
    const result = stream.receive(0n);
    deepStrictEqual(result, []);
  });

  it('receive(1n) with data available returns datagram', () => {
    const udpSock = createMockUdpSocket(new Uint8Array([1, 2, 3]), { host: '10.0.0.1', port: 9000 });
    const stream = new IncomingDatagramStream(udpSock, 'ipv4');
    const result = stream.receive(1n);
    strictEqual(result.length, 1);
    deepStrictEqual(result[0]!.data, new Uint8Array([1, 2, 3]));
    strictEqual(result[0]!.remoteAddress.tag, 'ipv4');
    strictEqual(result[0]!.remoteAddress.val.port, 9000);
  });

  it('receive with no data returns empty', () => {
    const udpSock = createMockUdpSocket(); // no data
    const stream = new IncomingDatagramStream(udpSock, 'ipv4');
    const result = stream.receive(10n);
    deepStrictEqual(result, []);
  });
});

// --- UDP Send Tests ---

describe('UDP OutgoingDatagramStream send validation', () => {
  it('send with valid target succeeds', () => {
    const udpSock = createMockUdpSocket();
    const remote: IpSocketAddress = { tag: 'ipv4', val: { port: 9000, address: [10, 0, 0, 1] } };
    const stream = new OutgoingDatagramStream(udpSock, 'ipv4', remote);
    const sent = stream.send([{ data: new Uint8Array([1, 2, 3]) }]);
    strictEqual(sent, 1n);
  });

  it('send with no target and no default throws invalid-argument', () => {
    const udpSock = createMockUdpSocket();
    const stream = new OutgoingDatagramStream(udpSock, 'ipv4', null);
    throws(
      () => stream.send([{ data: new Uint8Array([1]) }]),
      (err: unknown) => err === 'invalid-argument',
    );
  });

  it('send with family mismatch throws invalid-argument', () => {
    const udpSock = createMockUdpSocket();
    const stream = new OutgoingDatagramStream(udpSock, 'ipv4', null);
    const wrongFamilyAddr: IpSocketAddress = {
      tag: 'ipv6',
      val: { port: 9000, flowInfo: 0, address: [0, 0, 0, 0, 0, 0, 0, 1], scopeId: 0 },
    };
    throws(
      () => stream.send([{ data: new Uint8Array([1]), remoteAddress: wrongFamilyAddr }]),
      (err: unknown) => err === 'invalid-argument',
    );
  });
});

// --- IP Literal Resolution Tests ---

describe('IP literal resolution', () => {
  it('"127.0.0.1" resolves immediately as IPv4', () => {
    const stream = new ResolveAddressStream('127.0.0.1', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
    deepStrictEqual(addr!.val, [127, 0, 0, 1]);
  });

  it('"::1" resolves immediately as IPv6', () => {
    const stream = new ResolveAddressStream('::1', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv6');
  });

  it('"192.168.1.1" resolves immediately', () => {
    const stream = new ResolveAddressStream('192.168.1.1', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
    deepStrictEqual(addr!.val, [192, 168, 1, 1]);
  });

  it('"2001:db8::1" resolves immediately as IPv6', () => {
    const stream = new ResolveAddressStream('2001:db8::1', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv6');
  });

  it('"example.com" goes to provider (not literal)', () => {
    const stream = new ResolveAddressStream('example.com', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
    // Provider returns 5.6.7.8
    deepStrictEqual(addr!.val, [5, 6, 7, 8]);
  });

  it('"999.1.1.1" is not a valid literal (goes to provider)', () => {
    const stream = new ResolveAddressStream('999.1.1.1', createSyncSocketProvider());
    const addr = stream.resolveNextAddress();
    strictEqual(addr!.tag, 'ipv4');
    // Provider returns 5.6.7.8
    deepStrictEqual(addr!.val, [5, 6, 7, 8]);
  });
});
