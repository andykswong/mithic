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
    ├── simple/   — ComponentizeJS WASM component
    ├── rust-cli/ — Rust WASM component
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

Tests use Node.js built-in test runner (`node --test`) with `--experimental-strip-types` for direct `.ts` execution. No transpile step needed for testing.

## Key Conventions

- **TypeScript 6+**, ESM-only (`"type": "module"`)
- **Vite** for library builds (produces `dist/`)
- **No comments unless the "why" is non-obvious**
- **Node.js >= 22.8.0** required (for `--experimental-strip-types`)

## Architecture Principles

- **Pluggable components** — VFS, HTTP, sockets, and process management are all defined as interfaces with injectable implementations, configured via WASI instantiation helpers. This follows SOLID principles for loose coupling and testability.
- **Isomorphic by design** — Exposes both standard Web APIs for JavaScript consumers (Web File System API) and WASI interfaces for WebAssembly components, backed by the same underlying providers.
- **Standards-based** — Implements WASI Preview 2 interfaces faithfully. Process management mirrors POSIX semantics (spawn, pipes, signals) with a Worker-per-process model: each spawned WASM component runs in its own Web Worker with SharedPipe ring buffers for cross-Worker I/O and `Atomics`-based blocking semantics. Shell mirrors Bash shell behavior with POSIX mode support. Follows the Unix "everything is a file" philosophy — cloud storage, devices, and IPC are all VFS mounts.

## WASM Transpilation

All packages that produce WASM components use `@mithic/wasm-transpile` for JCO transpilation:
- **CLI**: `wasm-transpile component.wasm -o ./dist` (supports `--async-mode jspi|asyncify`)
- **Programmatic**: `transpileComponent()` / `transpileToFiles()` from `@mithic/wasm-transpile`
- Shell, coreutils, and example packages call `wasm-transpile` in their `"transpile"` npm script
- The `examples/simple` package uses `jco componentize` CLI for JS→WASM then `wasm-transpile` for transpilation

### Bin Scripts

Packages with CLI binaries use a `bin/` wrapper pattern for portability:
```
bin/wasm-transpile.js   ← #!/usr/bin/env node + import '../dist/cli.js'
bin/mithic-shell.js     ← #!/usr/bin/env node + import '../dist/ts/cli.js'
```
The wrapper is executable and has the shebang; the built `dist/` code does not. This avoids permission issues when npm links the bin.

## When Editing

- Run `npm run build && npm run typecheck` in the affected package after changes to ensure no type or lint errors. Run `npm test` to verify tests pass.
- **IMPORTANT:** The shell and coreutils packages compile Rust to WASM. TS integration tests run against the compiled WASM binary in `dist/`. After any Rust source change, you MUST rebuild (`npm run build` or `npm run build:rust`) before running TS tests — otherwise tests run against stale WASM and results are meaningless. This also applies when using `git stash`/`git checkout` to compare test results between versions.
- For both `@mithic/wasip2` and `@mithic/process`, WIT definitions are the source of truth for interfaces. Package exports map to the WIT world (e.g., `@mithic/wasip2` exports match `wasi:*` interface names, `@mithic/process` exports match `mithic:process/*`). Each package provides `./instantiation` exporting a helper class (`WASIShim` / `WASIProcess`) that configures and returns the import object for WASM component instantiation.
- Prefer editing existing files over creating new ones.

## Test Coverage

- **Every code change MUST include comprehensive tests.** Do not consider a change complete until tests covering the new or modified behavior are written, passing, and verified.
- Test the happy path, edge cases, and error conditions. If a function can fail, test that it fails correctly.
- When fixing a bug, add a regression test that reproduces the bug before applying the fix, then verify the test passes after.
- When adding a new feature, write tests that exercise the full surface area — not just a single smoke test.
- Run `npm run build && npm run typecheck && npm test` in the affected packages and confirm all tests pass before marking work as done.
