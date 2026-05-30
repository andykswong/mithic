# mithic

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)

> Virtual OS for the agent era.

Sandboxed WebAssembly shell runtime with pluggable, capability-based filesystem and resource access. Runs anywhere JavaScript runs.

## Why Mithic?

| | Mithic | WebContainers | Docker | WasmEdge |
|---|---|---|---|---|
| Runs in browser | Yes | Yes | No | No |
| Sandboxing | WASM capability model | Node.js sandbox | Linux namespaces | WASM |
| Pluggable filesystem | Any provider (memory, cloud, custom) | Fixed | Host bind mounts | WASI only |
| POSIX shell | Full bash-compatible | Node.js-based | Real bash | None |
| Component model | WASI Preview 2 | Proprietary | N/A | WASI P1 |
| Agent-safe | Capability-scoped, no escape | Partial | Full but heavy | Partial |
| Startup time | Instant (in-process) | ~1s | Seconds | Milliseconds |

## Core Pillars

> 2. **Agent Harness** — Designed for AI agent tool execution. Pluggable VFS means agents see only the resources they need.

1. **Security** — WASM capability-based sandboxing. Each process runs in isolation; only explicitly mounted resources are accessible.
2. **Virtualization** — Mount any storage provider or resource at any path. Cloud storage, APIs, caches, local files, browser OPFS, or custom backends all pluggable via the same interfaces.
3. **Isomorphic** — Same code runs in the browser (local-first, no server required), on Node.js servers, and native hosts.

## Composable Layers

> Each package works independently — pick the abstraction level you need.

## Packages

| Package | Description |
|---------|-------------|
| [`@mithic/io`](./packages/io) | I/O layer: virtual file system, HTTP/socket providers, sync-bridge |
| [`@mithic/wasip2`](./packages/wasip2) | WASI Preview 2 shim for WASM components |
| [`@mithic/process`](./packages/process) | Process manager: spawn WASM processes with piped I/O |
| [`@mithic/shell`](./packages/shell) | Rust WASM shell: bash-compatible interpreter (30+ builtins) |
| [`@mithic/coreutils`](./packages/coreutils) | BusyBox-style Unix coreutils (30+ commands) as a single WASM component |

### Examples

| Example | Description |
|---------|-------------|
| [`examples/simple`](./packages/examples/simple) | JS WebAssembly component built with ComponentizeJS |
| [`examples/rust-cli`](./packages/examples/rust-cli) | Rust WebAssembly component |
| [`examples/shell`](./packages/examples/shell) | xterm.js browser terminal with MithicShell |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Browser / Node.js                    │
├────────────────────────┬────────────────────────────────┤
│      Main Thread       │         Web Worker             │
│                        │                                │
│  ┌──────────────────┐  │  ┌──────────────────────────┐  │
│  │     IoLoop       │  │  │    WASM Component        │  │
│  │  ┌────────────┐  │  │  │    (Shell / Coreutils)   │  │
│  │  │ VFS Router │  │◄─┼──│    blocking_read/write   │  │
│  │  │  ├ MemFS   │  │  │  │    (Atomics.wait)        │  │
│  │  │  ├ OPFS    │  │  │  └──────────────────────────┘  │
│  │  │  └ NodeFS  │  │  │                                │
│  │  ├────────────┤  │  │                                │
│  │  │ HTTP/Sock  │  │  │                                │
│  │  └────────────┘  │  │                                │
│  └──────────────────┘  │                                │
│           ▲            │                                │
│           │ SharedArrayBuffer + Atomics.notify          │
└───────────┴────────────┴────────────────────────────────┘
```

## Getting Started

```shell
npm install mithic
# or individual packages:
npm install @mithic/io @mithic/wasip2 @mithic/process @mithic/shell
```

### Run a WASM Component (Node.js)

```js
import { WASIShim } from '@mithic/wasip2/instantiation';

const shim = new WASIShim({
  sandbox: {
    preopens: { '/': { dir: { 'home': { dir: {} } } } },
    env: { HOME: '/home', PATH: '/bin' },
    args: ['my-program', '--verbose'],
  },
});

const { instantiate } = await import('./transpiled-component.js');
const { run } = await instantiate(null, shim.getImportObject());
run.run();
```

### Shell Example

The [shell example](./packages/examples/shell/) demonstrates an xterm.js terminal connected to `MithicShell` (Rust WASM), running WASM programs in the browser.

```shell
cd packages/examples/shell
npm run dev
```

## Development

### Prerequisites

- Node.js >= 22.8.0
- Rust toolchain (for `wasm-tools` and `wkg`, installed via `prepare` script)

### Commands

```shell
npm install          # install deps + rust tools
npm run build        # build all packages
npm test             # test all packages
npm run lint         # lint all packages
npm run typecheck    # type-check all packages
```

Tests use `node --test` (Node.js built-in test runner) with `--experimental-strip-types` for direct TypeScript execution.

## License

This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
