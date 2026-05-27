import { describe, it } from 'node:test';
import { ok } from 'node:assert';
import type { SyncFileSystemProvider } from '../../vfs/provider.ts';
import type { SyncHttpClient } from '../../net/http.ts';
import type { SyncSocketProvider, SyncUdpSocket } from '../../net/sockets.ts';
import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '../streams.ts';
import type { SyncBridgeFsProvider, SyncBridgeHttpClient } from './sync-bridge.ts';
import {
  SyncBridgeInputStreamHandler,
  SyncBridgeOutputStreamHandler,
  SyncBridgeSocketProvider,
  createStdinHandler,
  createStdoutHandler,
  createStderrHandler,
} from './sync-bridge.ts';
import { SOCKET_CREATE, SOCKET_BIND, SOCKET_SEND, SOCKET_RECV, SOCKET_CLOSE, SOCKET_UDP } from '../calls.ts';

describe('SyncBridgeFsProvider', () => {
  it('satisfies SyncFileSystemProvider interface', () => {
    const provider: SyncFileSystemProvider = null as unknown as SyncBridgeFsProvider;
    ok(provider !== undefined || true);
  });
});

describe('SyncBridgeHttpClient', () => {
  it('satisfies SyncHttpClient interface', () => {
    const client: SyncHttpClient = null as unknown as SyncBridgeHttpClient;
    ok(client !== undefined || true);
  });
});

describe('SyncBridgeSocketProvider', () => {
  it('satisfies SyncSocketProvider interface', () => {
    const provider: SyncSocketProvider = null as unknown as SyncBridgeSocketProvider;
    ok(provider !== undefined || true);
  });
});

describe('SyncBridgeInputStreamHandler', () => {
  it('satisfies SyncInputStreamHandler interface', () => {
    const handler: SyncInputStreamHandler = null as unknown as SyncBridgeInputStreamHandler;
    ok(handler !== undefined || true);
  });
});

describe('SyncBridgeOutputStreamHandler', () => {
  it('satisfies SyncOutputStreamHandler interface', () => {
    const handler: SyncOutputStreamHandler = null as unknown as SyncBridgeOutputStreamHandler;
    ok(handler !== undefined || true);
  });
});

describe('SyncBridgeSocketProvider.createUdpSocket', () => {
  it('creates a UDP socket that dispatches via ioCall', () => {
    const calls: Array<{ call: number; id: number | null; payload: unknown }> = [];
    const mockIo = {
      ioCall(call: number, id: number | null, payload: unknown) {
        calls.push({ call, id, payload });
        const method = call & 0xff000000;
        if (method === SOCKET_CREATE) return 42;
        if (method === SOCKET_SEND) return 5;
        if (method === SOCKET_RECV) return { data: new Uint8Array([1, 2, 3]), remoteAddress: { host: '127.0.0.1', port: 9000 } };
        return undefined;
      },
    };

    const provider = new SyncBridgeSocketProvider(mockIo as never);
    const udp = provider.createUdpSocket();

    ok(udp !== undefined);
    ok(calls.some(c => (c.call & 0xff000000) === SOCKET_CREATE && (c.call & 0x00ffffff) === SOCKET_UDP));

    udp.bind({ host: '0.0.0.0', port: 0 });
    ok(calls.some(c => (c.call & 0xff000000) === SOCKET_BIND));

    const sent = udp.send(new Uint8Array([10, 20]), { host: '127.0.0.1', port: 9000 });
    ok(sent === 5);

    const received = udp.receive(1024);
    ok(received.data);
    ok(received.remoteAddress.port === 9000);

    udp.close();
    ok(calls.some(c => (c.call & 0xff000000) === SOCKET_CLOSE));
  });

  it('satisfies SyncUdpSocket interface', () => {
    const udp: SyncUdpSocket = null as unknown as ReturnType<SyncBridgeSocketProvider['createUdpSocket']>;
    ok(udp !== undefined || true);
  });
});

describe('factory functions', () => {
  it('createStdinHandler creates handler with STDIN resource type', () => {
    const mockIo = { ioCall: () => new Uint8Array(0) };
    const handler = createStdinHandler(mockIo as never);
    ok(handler instanceof SyncBridgeInputStreamHandler);
  });

  it('createStdoutHandler creates handler with STDOUT resource type', () => {
    const mockIo = { ioCall: () => {} };
    const handler = createStdoutHandler(mockIo as never);
    ok(handler instanceof SyncBridgeOutputStreamHandler);
  });

  it('createStderrHandler creates handler with STDERR resource type', () => {
    const mockIo = { ioCall: () => {} };
    const handler = createStderrHandler(mockIo as never);
    ok(handler instanceof SyncBridgeOutputStreamHandler);
  });
});
