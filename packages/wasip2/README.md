# @mithic/wasip2

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/wasip2?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/wasip2)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> WASI Preview 2 shim for mithic

## Overview

`@mithic/wasip2` is an implementation of WASI Preview 2 interfaces. It allows WASM components transpiled by jco to run with a fully functional filesystem, HTTP, sockets, stdio, and clock implementation. All I/O delegates to sync provider interfaces from `@mithic/io`.

## Install

```shell
npm install @mithic/wasip2
```

## Usage

### In-memory (same thread)

```typescript
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { MemoryFsProvider } from '@mithic/io/vfs';

const shim = new WASIShim({
  sandbox: {
    preopens: {
      '/': new Descriptor(new SyncFsDescriptorHandler(
        new MemoryFsProvider({ files: { '/hello.txt': 'Hello World' } }), '/'
      )),
    },
    env: { HOME: '/', PATH: '/bin' },
    args: ['my-program'],
  },
});

const { instantiate } = await import('./my-component.js');
const instance = await instantiate(null, shim.getImportObject());
instance.run.run();
```

### Cross-thread (worker → main thread)

```typescript
import { WASIShim } from '@mithic/wasip2/instantiation';
import { Descriptor } from '@mithic/wasip2/filesystem/types';
import { SyncFsDescriptorHandler } from '@mithic/wasip2/filesystem/sync-fs-handler';
import { WorkerIo } from '@mithic/io/io';
import {
  SyncBridgeFsProvider, SyncBridgeHttpClient,
  createStdinHandler, createStdoutHandler,
} from '@mithic/io/io/providers/sync-bridge';

const io = new WorkerIo(port); // port from main thread's IoLoop.addWorker()

const shim = new WASIShim({
  sandbox: {
    preopens: {
      '/': new Descriptor(new SyncFsDescriptorHandler(new SyncBridgeFsProvider(io), '/')),
    },
    httpClient: new SyncBridgeHttpClient(io),
    stdin: createStdinHandler(io),
    stdout: createStdoutHandler(io),
  },
});
```

## Design

- **Per-instance isolation** — each `WASIShim` has its own preopens, env, args, stdio, and network policy
- **Pluggable providers** — filesystem, HTTP, sockets, and stdio are all injectable via `WASIShim` config. `Descriptor` delegates to a `DescriptorHandler` interface, which adapts any `SyncFileSystemProvider` implementation.
- **Synchronous by design** — WASI APIs are synchronous. All I/O interfaces accept only `Sync*` variants from `@mithic/io` (`SyncFileSystemProvider`, `SyncHttpClient`, `SyncSocketProvider`, `SyncInputStreamHandler`), ensuring no Promise leaks into WASI call paths.
- **Async mode** — Pass `async: true` to `WASIShim` config when using JSPI or asyncify. This enables async-compatible implementations (e.g., async filesystem descriptor handlers via `FsDescriptorHandler`) that return Promises from WASI calls, which are then suspended/resumed by the JSPI/asyncify runtime.
- **Sync-bridge for cross-thread** — For WASM running in a worker thread, `@mithic/io` provides `SyncBridge*` providers that dispatch through `SharedArrayBuffer` + `Atomics` to async providers on the I/O loop. Same interfaces, transparent to WASI code.

### jco Transpile Integration

```shell
jco transpile my-component.wasm -o ./out --map 'wasi:*=@mithic/wasip2/*'
```

## WASI Interface Coverage

| WASI Package | Interfaces | Status |
|---|---|---|
| `wasi:io@0.2.x` | error, poll, streams | Implemented (poll uses `Atomics.wait` sync bridge) |
| `wasi:cli@0.2.x` | environment, exit, stdin, stdout, stderr, terminal | Implemented |
| `wasi:clocks@0.2.x` | monotonic-clock, wall-clock | Implemented |
| `wasi:filesystem@0.2.x` | types (Descriptor), preopens | Implemented |
| `wasi:random@0.2.x` | random, insecure, insecure-seed | Implemented |
| `wasi:http@0.2.x` | types, outgoing-handler, incoming-handler | Implemented |
| `wasi:sockets@0.2.x` | tcp, udp, ip-name-lookup | Implemented |

## Exports

Each WASI interface is available as a separate entry point (for jco-transpiled component imports):

```
@mithic/wasip2/cli/environment
@mithic/wasip2/cli/stdin
@mithic/wasip2/cli/stdout
@mithic/wasip2/filesystem/types
@mithic/wasip2/filesystem/preopens
@mithic/wasip2/io/streams
@mithic/wasip2/io/poll
@mithic/wasip2/http/outgoing-handler
@mithic/wasip2/sockets/tcp
...
```

See [package.json](./package.json) for the full exports map.
