# Mithic — Agent Guidelines

## Project Overview

Mithic is an isomorphic sandboxed WebAssembly shell runtime. It provides a shell execution layer, process management with piped I/O, and WASI Preview 2 runtime with virtual file system (VFS) and resource adapters — running identically in the browser and on native platforms.

## Monorepo Structure

```
packages/
├── io/             @mithic/io             — VFS router, providers, HTTP/sockets, sync-bridge
├── wasip2/         @mithic/wasip2         — WASI P2 shim (thin adapter over @mithic/io)
├── process/        @mithic/process        — mithic:process WIT, Process spawn, Worker-per-process execution, SharedPipe, CompilerBridge for dynamic WASM
├── shell/          @mithic/shell          — Rust WASM shell: POSIX-compatible WASI P2 component
├── coreutils/      @mithic/coreutils      — BusyBox-style Unix coreutils WASM component (30+ commands)
├── wasm-transpile/ @mithic/wasm-transpile — WASM component transpiler (JCO wrapper + asyncify JSPI polyfill)
├── worker/         @mithic/worker         — Web Worker polyfill for Node.js (isomorphic new Worker())
└── examples/
    ├── component-js/  — JS WASM component (ComponentizeJS)
    ├── component-rust/ — Rust WASM component
    └── shell/    — xterm.js + Runtime
```

## Build & Test

```shell
npm install                  # installs deps + wasm-tools/wkg via cargo
npm run build                # vite build across all workspaces
npm test                     # node --test across all workspaces
npm run lint                 # eslint
npm run typecheck            # tsc --noEmit
```

Individual package: run the same commands inside the package directory.

Tests use Node.js built-in test runner (`node --test`) with built-in type striping for direct `.ts` execution. No transpile step needed for testing.

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

## WASM Transpilation

All packages that produce WASM components use `@mithic/wasm-transpile` for JCO transpilation:
- **CLI**: `wasm-transpile component.wasm -o ./dist --variants sync,jspi,asyncify` (also supports `--async-imports` and `--async-exports` for custom async functions)
- **Programmatic**: `transpileComponent()` / `transpileToFiles()` from `@mithic/wasm-transpile`
- **Multi-variant builds**: shell, coreutils, and example packages produce deduplicated variants via `--variants`. Package exports: `./component` (sync), `./component/jspi`, `./component/asyncify`, `./component/core/*`, `./component/core-asyncify/*`
- Shell, coreutils, and example packages call `wasm-transpile` in their `"transpile"` npm script
- The `examples/component-js` package uses `jco componentize` CLI for JS→WASM then `wasm-transpile` for transpilation

### Bin Scripts

Packages with CLI binaries use a `bin/` wrapper pattern for portability:
```
bin/wasm-transpile.js   ← #!/usr/bin/env node + import '../dist/cli.js'
bin/mithic-shell.js     ← #!/usr/bin/env node + import '../dist/ts/cli/index.js'
```
The wrapper is executable and has the shebang; the built `dist/` code does not. This avoids permission issues when npm links the bin.

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

- For both `@mithic/wasip2` and `@mithic/process`, WIT definitions are the source of truth for interfaces. Each package provides `./instantiation` exporting a helper class (`WASIShim` / `WASIProcess`) that configures and returns the import object for WASM component instantiation.
- Prefer editing existing files over creating new ones.
