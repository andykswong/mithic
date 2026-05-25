# @mithic/io

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/io?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/io)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> I/O layer for mithic — virtual filesystem, network providers, and sync-bridge

## Overview

`@mithic/io` is the foundational I/O layer for the mithic runtime. It provides:

- **Virtual File System (VFS)** — A mount-based router with pluggable providers (memory, OPFS, Node.js native fs, synthetic devices)
- **Network Providers** — Virtual HTTP client/server and TCP/UDP socket interfaces
- **Sync Bridge** — `SharedArrayBuffer` + `Atomics` bridge enabling synchronous WASI calls from WASM workers over an async I/O loop
- **IoContext** — Factory for composing VFS mounts, network config, environment, and stdio into a unified context

## Install

```shell
npm install @mithic/io
```

## Key Concepts

### File System Router

The `FileSystemRouter` delegates file operations to `FileSystemProvider` implementations based on mount path prefix:

```typescript
import { FileSystemRouter, MemoryProvider } from '@mithic/io/vfs';

const router = new FileSystemRouter();
router.mount('/', new MemoryProvider());
```

### File System Providers

All filesystem providers implement the async `FileSystemProvider` interface with full Unix semantics (permissions, timestamps, symlinks):

```typescript
interface FileSystemProvider {
  open(path: string, flags: OpenFlags): Promise<FileHandle>;
  read(handle: FileHandle, offset: number, len: number): Promise<Uint8Array>;
  write(handle: FileHandle, data: Uint8Array, offset: number): Promise<number>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string): Promise<void>;
  // ... chmod, symlink, rename, etc.
}
```

#### Built-in Providers

| Provider | Backing | Use Case |
|----------|---------|----------|
| `MemoryProvider` | In-memory `FileData` tree | Testing, browser default |
| `OPFSProvider` | Origin Private File System | Browser persistent storage |
| `NodeFsProvider` | Node.js `fs` module | Native server/desktop |
| `DeviceProvider` | Synthetic handlers | `/dev/null`, `/dev/zero`, etc. |

### Network Providers

HTTP and socket providers follow the same pattern as VFS:

```typescript
interface HttpProvider {
  send(request: HttpRequest): Promise<HttpResponse>;
}

interface SocketProvider {
  createTcpSocket(): Promise<TcpSocket>;
  createUdpSocket(): Promise<UdpSocket>;
  resolveName(name: string): Promise<IpAddress[]>;
}
```

### Sync Bridge

Enables WASM workers to make blocking WASI calls while the I/O loop processes them asynchronously:

```typescript
import { createBlockingCall } from '@mithic/io/io';

const ioCall = createBlockingCall(ioLoopWorkerUrl);
const data = ioCall(FS_READ, fd, length); // blocks until I/O loop resolves
```

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/io` | Main index (IoContext, core types) |
| `@mithic/io/context` | IoContext factory |
| `@mithic/io/io` | Sync-bridge, call dispatch, I/O loop |
| `@mithic/io/vfs` | VFS router, provider interface, memory provider |
| `@mithic/io/vfs/providers/opfs` | OPFS provider (browser) |
| `@mithic/io/vfs/providers/node-fs` | Node.js native fs provider |
| `@mithic/io/net` | HTTP and socket provider interfaces |
| `@mithic/io/net/providers/node-http-server` | Node.js HTTP server |
| `@mithic/io/net/providers/node-socket-provider` | Node.js TCP/UDP sockets |
