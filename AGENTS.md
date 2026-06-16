# Mithic — Agent Guidelines

## Project Overview

Mithic (Mithic 2.0) is a capability-based sandboxed process kernel with GUI-capable sandboxes, running identically in the browser and on native platforms.

## Monorepo Structure

```
packages/
├── protocol/       @mithic/protocol       — wire types: ProcessInit, Capability, SyscallRequest/Response, KernelEvent, pipe + errno protocol
├── guest-runtime/  @mithic/guest-runtime  — in-sandbox guest API: createGuest(boot) → {syscall, stdio streams, onSignal, onDomEvent, exit}; Remote DOM client
├── runtime/        @mithic/runtime        — pluggable execution backends: Worker, iframe (GUI/opaque-origin), QuickJS, isolated-vm
├── kernel/         @mithic/kernel         — the Kernel: process lifecycle, IPC broker, capability manager, syscall dispatch, pipelines, Remote DOM host
├── shell-js/       @mithic/shell-js       — POSIX-style shell interpreter (lexer/parser/expander/builtins/executor) running as a regular Mithic process
├── server/         @mithic/server         — host-side server integration
├── io/             @mithic/io             — VFS router, providers, HTTP/sockets (VFS used by Mithic Vitest suite)
├── worker/         @mithic/worker         — Web Worker polyfill for Node.js (isomorphic new Worker())
└── examples/
    ├── shell/        @mithic/example-shell        — xterm.js terminal (pending re-adaptation to Mithic JS shell)
    ├── image-viewer/ @mithic/example-image-viewer — GUI Mithic process: drop-zone + <img> rendered in its own sandboxed iframe DOM
    └── notebook/     @mithic/example-notebook     — xterm.js shell notebook: boots Kernel + IframeRuntime, drives @mithic/shell-js
```

> The original WASM/WASI P2 packages (shell, coreutils, jq, curl, wasip2, process, wasm-transpile) are removed from this branch. They are preserved on the `wasm` branch (and `origin/main`).

## Build & Test

```shell
npm install                  # installs deps + wasm-tools/wkg via cargo
npm run build                # vite build across all workspaces
npm test                     # vitest run across all projects (node + browser)
npm run test:node            # node-environment tests only
npm run test:browser         # browser-mode tests (Chromium via Playwright)
npm run lint                 # eslint
npm run typecheck            # tsc --noEmit
```

Individual package: run the same commands inside the package directory.

Mithic packages use **Vitest**. Node-environment unit/integration tests are `*.test.ts`; tests requiring a real browser (iframe sandboxing, DOM, MessagePort/ArrayBuffer transfer) are `*.browser.test.ts` and run in Chromium. Legacy Mithic packages may still use `node --test` until migrated.

## Key Conventions

- **TypeScript 6+**, ESM-only (`"type": "module"`)
- **Vite** for library builds (produces `dist/`)
- **No comments unless the "why" is non-obvious**
- **Node.js >= 26.0** required

## Architecture Principles

- **Pluggable components** — VFS, HTTP, sockets, and process management are all defined as interfaces with injectable implementations, configured via WASI instantiation helpers. This follows SOLID principles for loose coupling and testability.
- **Isomorphic by design** — Exposes both standard Web APIs for JavaScript consumers (Web File System API) and WASI interfaces for WebAssembly components, backed by the same underlying providers.
- **Standards-based** — Implements WASI Preview 2 interfaces faithfully. Process management mirrors POSIX semantics (spawn, pipes, signals) with two execution modes:
  - **Worker mode**: Each spawned WASM component runs in its own Web Worker with SharedPipe ring buffers for cross-Worker I/O and `Atomics`-based blocking semantics. True parallelism.
  - **Async mode**: All processes run on the same JS thread as suspended JSPI stacks (or asyncify-instrumented stacks). Cooperative concurrency via Promise yielding. No Workers, no SharedArrayBuffer needed — works in environments without COOP/COEP headers.
  
  Shell mirrors Bash shell behavior with POSIX mode support. Follows the Unix "everything is a file" philosophy — cloud storage, devices, and IPC are all VFS mounts.
- **Disposable ownership convention** — When a component receives a `Disposable` resource, ownership must be explicit:
  - **Owned**: The receiver calls `[Symbol.dispose]()` when done. The resource's lifetime is tied to the receiver.
  - **Borrowed**: The receiver uses the resource but does NOT dispose it. The caller retains ownership. For streams, use `borrow()` to make this explicit — the borrow is a non-ref-counted view whose dispose is a no-op.
  
  Example: `WASIShim` owns its stdio streams and exposes them as `borrow()` to WASM guests. The handler disposes the shim in its `finally` block, which drops the owned streams and propagates EOF/broken-pipe.

## When Editing

**The one rule: `npm run build` before ANY test run or verification. No exceptions.**

Many tests import from `dist/`. Running tests without building first risks testing stale compiled code — results may be meaningless regardless of pass/fail. This applies after every action that changes what's in the working tree:

- After editing source files
- After `git stash` or `git stash pop`
- After `git checkout` or `git switch`
- After pulling or rebasing

**Do NOT** `git stash` + `npm test` to check if tests "were already broken" — this tests whatever stale JS was last built, not the stashed-to state. If you need a baseline, do: `git stash && npm run build && npm test`.

The verification sequence is always run from the **monorepo root**: `npm run build && npm run typecheck && npm test`. This builds and tests all packages — don't limit to a single package, since changes often have cross-package effects.

### Tests

- Every code change must include tests covering the new or modified behavior — happy path, edge cases, and error conditions.
- When fixing a bug, add a regression test that reproduces it before applying the fix.
- Do not consider work done until `npm run build && npm run typecheck && npm test` passes from the monorepo root.

### Other guidelines

- Prefer editing existing files over creating new ones.
