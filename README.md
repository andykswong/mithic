# mithic

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/mithic?style=flat-square&logo=npm)](https://www.npmjs.com/package/mithic)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)
[![build](https://img.shields.io/github/actions/workflow/status/andykswong/mithic/build.yaml?style=flat-square)](https://github.com/andykswong/mithic/actions/workflows/build.yaml)
[![codecov](https://codecov.io/gh/andykswong/mithic/branch/main/graph/badge.svg?token=2OYVQSTDMC)](https://codecov.io/gh/andykswong/mithic)

> Capability-based sandboxed process runtime for the agent era.

**Mithic 2.0** is an isomorphic, capability-based sandboxed **JavaScript** process runtime that runs identically in the browser and on native Node platforms. A microkernel brokers syscalls, IPC pipes, and process lifecycle; a POSIX-style shell and a Unix command suite run as ordinary sandboxed processes on top of it. The same code runs in the browser (local-first, no server required) and on Node.js — every resource a process can touch is an explicitly granted capability over a virtual filesystem and network layer.

## Core Pillars

1. **Agent Harness** — Designed for AI agent tool execution. Pluggable VFS means agents see only the resources they are granted.
2. **Security** — Capability-based sandboxing. Each process runs in an isolation backend (iframe, Web Worker, QuickJS, or isolated-vm); only explicitly granted filesystem, network, and IPC capabilities are reachable, and every syscall is checked in-kernel.
3. **Virtualization** — Mount any storage provider at any path: in-memory, browser OPFS, Node FS, devices, network devices, or a caching layer — all behind the same provider interface.
4. **Isomorphic** — Same code runs in the browser (local-first, no server required), on Node.js servers, and native hosts.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser / Node.js Host                       │
│                                                                   │
│   ┌─────────────────────────── Kernel ───────────────────────┐   │
│   │  ProcessManager · IpcBroker · CapabilityManager           │   │
│   │  SyscallDispatcher · Remote-DOM host                      │   │
│   │      │              │                │                     │   │
│   │   capability-     pipe IPC      command namespace         │   │
│   │   gated VFS +     (credit-based  (resolveCommand →        │   │
│   │   net (@mithic/io)  flow control)  guest module URL)       │   │
│   └──────┼──────────────┼────────────────┼────────────────────┘   │
│          │              │                │                        │
│   ┌──────┴──────────────┴────────────────┴────────────────────┐   │
│   │   Runtime backend  (one isolation context per process)     │   │
│   │   iframe (GUI) · Worker · QuickJS-WASM · isolated-vm       │   │
│   │       └─ guest-runtime: mithic.* syscall API + stdio       │   │
│   │          streams + Remote-DOM client                       │   │
│   └────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

The **kernel** owns process lifecycle, the command namespace, and the syscall surface (`fs/*`, `net/fetch`, `ipc/*`, `process/*`, `dom/mutate`). Guests never hold a socket or a raw file handle — they issue syscalls that the kernel checks against the process's granted capabilities before touching the VFS or `HttpClient`. Each process runs in a **pluggable runtime backend**:

- **Worker** — true parallelism with direct `MessagePort` pipe transfer.
- **iframe** — the only GUI backend; renders a sanitized Remote-DOM tree in an opaque-origin sandboxed iframe.
- **QuickJS-WASM** — deterministic, with hard memory and CPU-budget limits; uses the kernel relay path for syscalls.
- **isolated-vm** — V8 isolate with a hard memory cap.

`selectBackend()` picks a backend from a policy (preferred / fallback order / capability requirements) against each backend's advertised `RuntimeCapabilities`.

## Packages

> Each package works independently — pick the abstraction level you need.

| Package | Description |
|---------|-------------|
| [`@mithic/protocol`](./packages/protocol) | Wire/IPC protocol: errno + signals, syscall request/response, process init, capability and pipe (credit-flow) types |
| [`@mithic/runtime`](./packages/runtime) | Pluggable isolation backends (iframe, Worker, QuickJS, isolated-vm), capability descriptors, and `selectBackend()` |
| [`@mithic/guest-runtime`](./packages/guest-runtime) | In-sandbox guest API: `createGuest()` → syscall client, stdio streams, signal/DOM hooks, Remote-DOM client |
| [`@mithic/kernel`](./packages/kernel) | The microkernel: process lifecycle, IPC broker, capability manager, syscall dispatch, pipelines, Remote-DOM host |
| [`@mithic/io`](./packages/io) | I/O engine: VFS router + providers (memory, OPFS, Node FS, device, caching), HTTP/socket abstractions |
| [`@mithic/shell`](./packages/shell) | POSIX-style shell interpreter (lexer/parser/expander/executor, 35 builtins) running as a regular Mithic process |
| [`@mithic/coreutils`](./packages/coreutils) | 54 pure-TypeScript Unix coreutils, one sandboxed guest module per command |
| [`@mithic/jq`](./packages/commands/jq) | Pure-TypeScript jq JSON processor as a sandboxed process |
| [`@mithic/curl`](./packages/commands/curl) | Pure-TypeScript curl-like HTTP client, routed through the capability-gated `net/fetch` syscall |
| [`@mithic/server`](./packages/server) | Host-side Hono REST server: sandboxed code execution over `POST /exec` |
| [`@mithic/worker`](./packages/worker) | Web Worker polyfill for Node.js (isomorphic `new Worker()`) |

The command suite is **56 commands** total: 54 coreutils plus `jq` and `curl`. The shell dispatches its 35 builtins in-process and spawns everything else as child processes via `process/spawn` and `process/pipeline`.

### Examples

| Example | Description |
|---------|-------------|
| [`@mithic/example-shell`](./packages/examples/shell) | xterm.js browser terminal running `@mithic/shell` over a Kernel wired to the full coreutils + jq + curl suite |
| [`@mithic/example-image-viewer`](./packages/examples/image-viewer) | A GUI Mithic process: drop-zone + `<img>` rendered in its own sandboxed iframe DOM |
| [`@mithic/example-notebook`](./packages/examples/notebook) | xterm.js shell-notebook frontend booting a Kernel with the full command suite plus an inline GUI image-viewer |

## Getting Started

```shell
npm install          # install deps
npm run build        # vite build across all workspaces
```

> **Build before test.** Many suites import from each package's `dist/`, so run `npm run build` before any test run.

### Run the example shell (browser)

```shell
npm run dev --workspace=@mithic/example-shell
```

Opens an xterm.js terminal connected to a Kernel running `@mithic/shell` with the full coreutils + jq + curl command suite. Run pipelines, scripts, and built-in commands against a capability-gated virtual filesystem.

### Run the example notebook (browser)

```shell
npm run dev --workspace=@mithic/example-notebook
```

A shell-notebook frontend that boots the same command suite and embeds an inline GUI image-viewer process.

## Development

### Prerequisites

- Node.js >= 26.0

### Commands

```shell
npm install          # install deps
npm run build        # vite build across all workspaces
npm run typecheck    # tsc --noEmit per package
npm test             # vitest run (node + browser projects)
npm run test:node    # node-environment tests only
npm run test:browser # browser-mode tests (Chromium via Playwright)
npm run lint         # eslint
```

Tests use **Vitest** with two projects: a `node` project for unit/integration tests, and a `browser` project running in real Chromium via Playwright for iframe sandboxing, DOM, and `MessagePort`/`ArrayBuffer`-transfer tests (`*.browser.test.ts`). The standard verification sequence from the repo root is:

```shell
npm run build && npm run typecheck && npm test
```

Toolchain: TypeScript 6+, ESM-only, Vite 8, Vitest 3.2.

## A note on the WASM approach

Mithic 2.0 (this `v2` branch) is **JavaScript-first**. The earlier WebAssembly / WASI-Preview-2 implementation — including the `wasip2`, `process`, and `wasm-transpile` packages and the WASM variants of the shell and command packages — is **paused**, not deleted. It is preserved on the [`wasm`](https://github.com/andykswong/mithic/tree/wasm) branch (and on `origin/main`), and is recoverable there.

## API Documentation

TypeDoc-generated API reference is available at [`docs/api/`](./docs/api/).

## License

This repository and the code inside it is licensed under the MIT License. Read [LICENSE](./LICENSE) for more information.
