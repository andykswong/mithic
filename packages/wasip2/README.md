# @mithic/wasip2

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/wasip2?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/wasip2)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> WASI Preview 2 shim for mithic

## Overview

`@mithic/wasip2` is an implementation of WASI Preview 2 interfaces. It allows WASM components transpiled by jco to run with a fully functional filesystem, HTTP, sockets, stdio, and clock implementation.

## Install

```shell
npm install @mithic/wasip2
```

## Usage

```typescript
import { WASIShim } from '@mithic/wasip2/instantiation';

const shim = new WASIShim({
  sandbox: {
    preopens: { '/': { dir: { 'home': { dir: {} } } } },
    env: { HOME: '/home', PATH: '/bin' },
    args: ['my-program', '--verbose'],
  },
});

// Instantiate a jco-transpiled component
const { instantiate } = await import('./my-component.js');
const instance = await instantiate(null, shim.getImportObject());
instance.run.run();
```

## Design

- **Per-instance isolation** — each `WASIShim` has its own preopens, env, args, stdio, and network policy
- **Thin adapter** — all I/O delegates to `@mithic/io` providers (VFS, HTTP, sockets)

### jco Transpile Integration

Configure jco to use `@mithic/wasip2` as the shim provider:

```shell
jco transpile my-component.wasm -o ./out --map 'wasi:*=@mithic/wasip2/*'
```

## WASI Interface Coverage

| WASI Package | Interfaces | Status |
|---|---|---|
| `wasi:io@0.2.x` | error, poll, streams | Implemented |
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
