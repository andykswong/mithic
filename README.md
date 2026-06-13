# mithic

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)

> Virtual shell runtime for the agent era.

Sandboxed WebAssembly bash/POSIX-compatible shell runtime with concurrent process management, capability-based virtual filesystem and resource access. Runs anywhere JavaScript runs.

## Core Pillars

1. **Agent Harness** — Designed for AI agent tool execution. Pluggable VFS means agents see only the resources they need.
2. **Security** — WASM capability-based sandboxing. Each process runs in isolation; only explicitly mounted resources are accessible.
3. **Virtualization** — Mount any storage provider or resource at any path. Cloud storage, APIs, caches, local files, browser OPFS, or custom backends all pluggable via the same interfaces.
4. **Isomorphic** — Same code runs in the browser (local-first, no server required), on Node.js servers, and native hosts.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Browser / Node.js Host                      │
├──────────────────────────┬──────────────────────────────────────┤
│       Main Thread        │          Web Workers (1 per process) │
│                          │                                      │
│  ┌────────────────────┐  │  ┌────────────────────────────────┐  │
│  │   Runtime / IoLoop │  │  │  WASM Component (Shell/Utils)  │  │
│  │  ┌──────────────┐  │  │  │                                │  │
│  │  │  VFS Router  │  │◄─┼──│  blocking_read / write         │  │
│  │  │  ├ MemoryFS  │  │  │  │  (Atomics.wait on SAB)         │  │
│  │  │  ├ DeviceFS  │  │  │  ├────────────────────────────────┤  │
│  │  │  ├ OPFS      │  │  │  │  DeviceFsProvider (per-process)│  │
│  │  │  └ NodeFS    │  │  │  │  /dev/stdin → process pipe     │  │
│  │  ├──────────────┤  │  │  │  /dev/null, /dev/zero, etc.    │  │
│  │  │  HTTP Client │  │  │  └────────────────────────────────┘  │
│  │  │  Sockets     │  │  │                                      │
│  │  ├──────────────┤  │  │  ┌────────────────────────────────┐  │
│  │  │WorkerProcess │──┼──┼──│  SharedPipe (ring buffer SAB)  │  │
│  │  │  Manager     │  │  │  │  backpressure + broken-pipe    │  │
│  │  └──────────────┘  │  │  └────────────────────────────────┘  │
│  └────────────────────┘  │                                      │
│                          │  Atomics.notify / Atomics.wait       │
└──────────────────────────┴──────────────────────────────────────┘
```

The diagram above shows **worker mode** (default). The main thread runs an `IoLoop` that services filesystem, network, and stdio requests from WASM workers via `SharedArrayBuffer` + `Atomics`. Each spawned process (shell command, coreutil, or dynamic WASM component) runs in its own Web Worker with blocking I/O semantics. Pipelines execute concurrently — `cat /dev/zero | head -c 4` terminates correctly via broken-pipe propagation.

An alternative **async mode** is also available, using JSPI or asyncify polyfill for suspendable async I/O without Workers or SharedArrayBuffer — suitable for environments without cross-origin isolation headers.

## Packages

> Each package works independently — pick the abstraction level you need.

| Package | Description |
|---------|-------------|
| [`@mithic/io`](./packages/io) | I/O layer: virtual file system, HTTP/socket providers, sync-bridge |
| [`@mithic/wasip2`](./packages/wasip2) | WASI Preview 2 shim for WASM components |
| [`@mithic/process`](./packages/process) | Process manager: spawn WASM processes with piped I/O |
| [`@mithic/shell`](./packages/shell) | Rust WASM shell: bash-compatible interpreter (30+ builtins) |
| [`@mithic/coreutils`](./packages/coreutils) | BusyBox-style Unix coreutils as a single WASM component |
| [`@mithic/wasm-transpile`](./packages/wasm-transpile) | WASM component transpiler with asyncify JSPI polyfill |
| [`@mithic/worker`](./packages/worker) | Web Worker polyfill for Node.js (isomorphic `new Worker()`) |

### Examples

| Example | Description |
|---------|-------------|
| [`@mithic/example-js-component`](./packages/examples/component-js) | JS WebAssembly component built with ComponentizeJS |
| [`@mithic/example-rust-component`](./packages/examples/component-rust) | Rust WebAssembly component |
| [`@mithic/example-shell`](./packages/examples/shell) | xterm.js browser terminal with full shell runtime |

## Getting Started

### Run the Shell (Node.js CLI)

```shell
npm install
npm start --workspace=@mithic/shell
```

This launches a bash-compatible shell with coreutils, `/dev` devices, and a virtual filesystem. You can run pipelines, scripts, and arbitrary WASM components.

### Run in Browser

```shell
npm run dev --workspace=@mithic/example-shell
```

Opens an xterm.js terminal connected to the shell runtime via Web Workers.

### Run a Script Non-Interactively

```shell
echo 'echo hello | tr a-z A-Z' | npm start --workspace=@mithic/shell
```

Or with arguments:

```shell
npm start --workspace=@mithic/shell -- -c 'for i in 1 2 3; do echo $i; done' 
```

## Development

### Prerequisites

- Node.js >= 26.0
- Rust toolchain with `wasm32-wasip2` target (for shell and coreutils packages)

```shell
rustup target add wasm32-wasip2
```

### Commands

```shell
npm install          # install deps + rust tools (wasm-tools, wkg)
npm run build        # build all packages
npm test             # test all packages
npm run lint         # lint all packages
npm run typecheck    # type-check all packages
```

Tests use `node --test` (Node.js built-in test runner) with built-in type stripping for direct TypeScript execution.

## API Documentation

TypeDoc-generated API reference is available at [`docs/api/`](./docs/api/).

## License

This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
