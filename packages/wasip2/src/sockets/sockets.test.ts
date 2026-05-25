import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert';

import { Network, type IpSocketAddress } from './network.ts';
import { TcpSocket, type ShutdownType } from './tcp.ts';
import { UdpSocket, IncomingDatagramStream, OutgoingDatagramStream } from './udp.ts';
import { createTcpSocket } from './tcp-create-socket.ts';
import { createUdpSocket } from './udp-create-socket.ts';
import { instanceNetwork } from './instance-network.ts';
import { resolveAddresses, ResolveAddressStream } from './ip-name-lookup.ts';

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
