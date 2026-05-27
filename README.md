# mithic

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)

> Isomorphic virtual process runtime for JavaScript and WebAssembly

## Overview

Mithic provides a virtual process runtime that runs identically in the browser (via [jco](https://github.com/bytecodealliance/jco) / WebAssembly Component Model) and on native systems (Node.js, wasmtime). It bridges Unix-style terminal workflows with modern web applications through a pluggable virtual filesystem and WASI Preview 2 runtime.

### Core Pillars

- **Isomorphic** — Code runs in the browser via `jco` and on native systems using compatible WASM runtimes, backed by the same provider implementations.
- **Everything is a File** — A unified VFS interface backs local storage, cloud resources, synthetic devices, and collaborative sync layers. Process I/O uses POSIX-style pipes and signals.
- **Composable** — Only foundational I/O primitives (filesystem, HTTP, sockets). Higher-level services compose on top via standard protocols over virtualized connections.
- **Scalable** — Each WASM component runs in an isolated worker with scoped permissions. The sync bridge (`SharedArrayBuffer` + `Atomics`) allows many concurrent processes without blocking the I/O loop.

## Getting Started

```shell
npm install mithic
# or individual packages:
npm install @mithic/io @mithic/wasip2 @mithic/process @mithic/just-bash
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

### Browser Shell Example

The [shell example](./packages/examples/shell/) demonstrates an xterm.js terminal connected to `JustBashShell`, running WASM programs in the browser.

```shell
cd packages/examples/shell
npm run dev
```

## Packages

| Package | Description |
|---------|-------------|
| [`@mithic/io`](./packages/io) | I/O layer: virtual file system, HTTP/socket providers, sync-bridge |
| [`@mithic/wasip2`](./packages/wasip2) | WASI Preview 2 shim for WASM components |
| [`@mithic/process`](./packages/process) | Process manager: spawn WASM processes with piped I/O |
| [`@mithic/just-bash`](./packages/just-bash) | Shell integration: adapts [just-bash](https://github.com/nicholasgasior/just-bash) to mithic VFS and process manager |

### Examples

| Example | Description |
|---------|-------------|
| [`examples/simple`](./packages/examples/simple) | JS WebAssembly component built with ComponentizeJS |
| [`examples/rust-cli`](./packages/examples/rust-cli) | Rust WebAssembly component |
| [`examples/shell`](./packages/examples/shell) | xterm.js browser terminal with JustBashShell |

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
