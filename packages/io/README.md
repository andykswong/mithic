# @mithic/io

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/io?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/io)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> I/O layer for mithic — virtual filesystem, network providers, and sync-bridge

## Overview

`@mithic/io` is the foundational I/O layer for the mithic runtime. It provides:

- **Virtual File System (VFS)** — A mount-based router with pluggable providers (memory, OPFS, Node.js native fs, synthetic devices)
- **Network Providers** — Virtual HTTP client/server and TCP/UDP socket interfaces
- **Sync Bridge** — `SharedArrayBuffer` + `Atomics` bridge enabling synchronous calls from WASM workers, with a unified call handler and pre-built sync-bridge providers
- **Stream Handlers** — `InputStreamHandler` / `OutputStreamHandler` interfaces for composable I/O

## Install

```shell
npm install @mithic/io
```

## Key Concepts

### MaybeAsync / Sync Interface Pattern

All provider interfaces use `MaybePromise<T>` (= `T | Promise<T>`) as return types. Sync variants narrow returns to `T` only:

```typescript
interface FileSystemProvider {
  read(handle, offset, len): MaybePromise<Uint8Array>;  // base
}
interface SyncFileSystemProvider extends FileSystemProvider {
  read(handle, offset, len): Uint8Array;                 // sync narrowing
}
```

This enables:
- **Async consumers** (call handler, router) use `await` on any provider — works for both sync and async
- **Sync consumers** (WASI code) accept only `Sync*` variants — guaranteed no-Promise returns

### File System Providers

| Provider | Interface | Use Case |
|----------|-----------|----------|
| `MemoryFsProvider` | `SyncFileSystemProvider` | Testing, browser default |
| `OPFSProvider` | `FileSystemProvider` | Browser persistent storage |
| `NodeFsProvider` | `FileSystemProvider` | Native server/desktop |
| `SyncBridgeFsProvider` | `SyncFileSystemProvider` | Cross-thread via WorkerIo |

#### File System Router

`FileSystemRouter` implements `FileSystemProvider` (base) and delegates to mounted providers via longest-prefix path matching:

```typescript
import { FileSystemRouter, MemoryFsProvider } from '@mithic/io/vfs';

const router = new FileSystemRouter();
await router.mount('/', new MemoryFsProvider());
```

### Network Providers

| Interface | Sync Variant | SyncBridge impl |
|-----------|--------------|-----------------|
| `HttpClient` | `SyncHttpClient` | `SyncBridgeHttpClient` |
| `SocketProvider` | `SyncSocketProvider` | `SyncBridgeSocketProvider` |
| `TcpSocket` | `SyncTcpSocket` | `SyncBridgeTcpSocket` |

### Stream Handlers

| Interface | Sync Variant | SyncBridge impl |
|-----------|--------------|-----------------|
| `InputStreamHandler` | `SyncInputStreamHandler` | `SyncBridgeInputStreamHandler` |
| `OutputStreamHandler` | `SyncOutputStreamHandler` | `SyncBridgeOutputStreamHandler` |

### Sync Bridge

For WASM workers that need synchronous I/O backed by async providers on another thread:

```typescript
// Main thread: set up I/O loop with call handler
import { IoLoop, createCallHandler } from '@mithic/io/io';

const loop = new IoLoop({ onCall: createCallHandler({ fs: memoryProvider }) });
const workerPort = loop.addWorker();

// Worker thread: use sync-bridge providers
import { WorkerIo, SyncBridgeFsProvider, SyncBridgeHttpClient } from '@mithic/io/io';

const io = new WorkerIo(port);
const fs = new SyncBridgeFsProvider(io);       // implements SyncFileSystemProvider
const http = new SyncBridgeHttpClient(io);     // implements SyncHttpClient
```

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/io` | Main index (all types and providers) |
| `@mithic/io/io` | Sync-bridge, call handler, stream handlers, WorkerIo, IoLoop |
| `@mithic/io/vfs` | VFS router, provider interface, MemoryFsProvider |
| `@mithic/io/vfs/providers/opfs` | OPFS provider (browser) |
| `@mithic/io/vfs/providers/node-fs` | Node.js native fs provider |
| `@mithic/io/net` | HTTP and socket interfaces + providers |
| `@mithic/io/net/providers/node-http-server` | Node.js HTTP server |
| `@mithic/io/net/providers/node-socket-provider` | Node.js TCP/UDP sockets |
