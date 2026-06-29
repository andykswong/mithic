# @mithic/io

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/io?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/io)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> I/O engine for Mithic — virtual filesystem router, providers, and network abstractions

## Overview

`@mithic/io` is the foundational I/O layer for the Mithic runtime. It provides:

- **Virtual File System (VFS)** — A mount-based router with pluggable providers (memory, OPFS, Node.js native fs, synthetic devices, network devices, caching)
- **Network Providers** — Virtual HTTP client/server and TCP/UDP socket interfaces with pluggable implementations

The VFS is what the Mithic kernel mounts and exposes to sandboxed processes; the Mithic Vitest suite exercises it directly. All interfaces are **async** — methods return `T | Promise<T>` and consumers `await` them.

## Install

```shell
npm install @mithic/io
```

## Key Concepts

### Async provider interfaces

All provider interfaces are async: filesystem and network methods return `T | Promise<T>`, so a single async consumer (the router, the kernel) works against both in-memory and I/O-bound backends. The `MaybePromise<T>` helper type (`= T | Promise<T>`) and the `chainMaybePromise` / `mapMaybePromise` / `isThenable` utilities make it cheap to thread a value through whether or not it is wrapped in a `Promise`.

### Virtual File System

`FileSystemProvider` is the core interface. It exposes POSIX-style operations — `open`, `read`, `write`, `truncate`, `close`, `stat`, `readdir`, `mkdir`, `unlink`, `rmdir`, `rename`, `symlink`, `readlink`, `link`, `chmod`, `utimes`, the extended-attribute ops `getxattr` / `setxattr` / `listxattr` / `removexattr`, `mkfifo`, optional `realpath` / `watch` / `sync`, and optional `init` / `dispose` lifecycle hooks. Errors are thrown as `FileSystemError` carrying a `FileSystemErrorCode` (`'no-entry'`, `'access'`, `'exist'`, `'not-directory'`, `'is-directory'`, `'cross-device'`, …) aligned with the WASI `wasi:filesystem` error-code names.

Providers whose backing store cannot carry extended attributes natively — `OPFSProvider` (which also loses `mode`/`mtime`) and `NodeFsProvider` — persist xattrs plus `mode`/`mtime` in a per-mount sidecar `MetadataStore`, a single reserved `.mithic-meta.json` blob at the mount root keyed by canonical path. That sidecar is hidden from `readdir` and guarded from direct VFS access at the root.

#### Providers

| Provider | Entry point | Use case |
|----------|-------------|----------|
| `MemoryFsProvider` | `@mithic/io/vfs` | In-memory store — testing, browser default |
| `DeviceFsProvider` | `@mithic/io/vfs` | Synthetic devices: `null`, `zero`, `random`, `urandom`, `stdin`, `stdout`, `stderr` |
| `NetworkDeviceFsProvider` | `@mithic/io/vfs` | Network-backed synthetic devices |
| `CachingProvider` | `@mithic/io/vfs` (also `@mithic/io/vfs/providers/caching`) | Read-through cache wrapping another provider |
| `OPFSProvider` | `@mithic/io/vfs/providers/opfs` | Browser persistent storage (Origin Private File System) |
| `NodeFsProvider` | `@mithic/io/vfs/providers/node-fs` | Native server/desktop, backed by `node:fs` |

#### File System Router

`FileSystemRouter` itself implements `FileSystemProvider`, so routers compose. It delegates to mounted providers via longest-prefix path matching:

```typescript
import { FileSystemRouter, MemoryFsProvider, DeviceFsProvider } from '@mithic/io/vfs';

const router = new FileSystemRouter();
await router.mount('/', new MemoryFsProvider());
await router.mount('/dev', new DeviceFsProvider());

const fh = await router.open('/tmp/hello.txt', { create: true, write: true });
await router.write(fh, new TextEncoder().encode('hi'), 0);
await router.close(fh);
```

Paths are canonicalized with `normalizePath`. `mount` / `unmount` drive each provider's optional `init` / `dispose` hooks, and `resolve(path)` returns the `{ provider, relativePath, mountPoint }` (`ResolveResult`) selected for a path.

### Network Providers

The `net` layer defines the HTTP and socket abstractions plus default implementations:

| Interface | Implementations |
|-----------|-----------------|
| `HttpClient` | `FetchHttpClient`, `MockHttpClient`, `DisabledHttpClient` |
| `HttpServer` | `DisabledHttpServer`, Node.js HTTP server (`@mithic/io/net/providers/node-http-server`) |
| `SocketProvider` / `TcpSocket` / `UdpSocket` | `DisabledSocketProvider`, Node.js sockets (`@mithic/io/net/providers/node-socket-provider`) |

`HttpClient.send` mirrors the Fetch API and supports `redirect: 'manual'`, which the kernel uses to capability-check redirect targets before following them (SSRF guard).

## Exports

| Entry point | Contents |
|-------------|----------|
| `@mithic/io` | Main index — re-exports `vfs`, `net`, and shared utils/types |
| `@mithic/io/vfs` | `FileSystemProvider`, `FileSystemRouter`, `FileSystemError`, `FileStat`, `DirEntry`, `FileHandle`, `OpenFlags`, `DescriptorType`, `WatchEvent`, `ResolveResult`, `normalizePath`, `VFSDirectoryHandle`, `VFSFileHandle`, and the `MemoryFsProvider` / `DeviceFsProvider` / `NetworkDeviceFsProvider` / `CachingProvider` providers |
| `@mithic/io/vfs/providers/node-fs` | `NodeFsProvider` (Node.js native fs) |
| `@mithic/io/vfs/providers/opfs` | `OPFSProvider` (browser) |
| `@mithic/io/vfs/providers/caching` | `CachingProvider` |
| `@mithic/io/net` | `HttpClient`, `HttpServer`, `HttpRequest`/`HttpResponse`, `TcpSocket`/`UdpSocket`/`SocketProvider`, `DisabledSocketProvider`, and the `FetchHttpClient` / `MockHttpClient` / `DisabledHttpClient` / `DisabledHttpServer` providers |
| `@mithic/io/net/providers/node-http-server` | Node.js HTTP server |
| `@mithic/io/net/providers/node-socket-provider` | Node.js TCP/UDP sockets |

## License

MIT
