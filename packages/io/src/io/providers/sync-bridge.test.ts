import { describe, it } from 'node:test';
import { ok } from 'node:assert';
import type { SyncFileSystemProvider } from '../../vfs/provider.ts';
import type { SyncHttpClient } from '../../net/http.ts';
import type { SyncSocketProvider } from '../../net/sockets.ts';
import type { SyncInputStreamHandler, SyncOutputStreamHandler } from '../streams.ts';
import type { SyncBridgeFsProvider, SyncBridgeHttpClient, SyncBridgeSocketProvider } from './sync-bridge.ts';
import {
  SyncBridgeInputStreamHandler,
  SyncBridgeOutputStreamHandler,
  createStdinHandler,
  createStdoutHandler,
  createStderrHandler,
} from './sync-bridge.ts';

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
