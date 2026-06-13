# @mithic/wasm-transpile

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/wasm-transpile?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/wasm-transpile)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> WASM component transpiler with asyncify JSPI polyfill

## Overview

`@mithic/wasm-transpile` provides:

1. **JCO transpile wrapper** — generalized in-memory WASM component transpilation with JSPI async mode
2. **Asyncify JSPI polyfill** — enables async host calls (blocking I/O) without native JSPI or Workers, using binaryen's asyncify pass for stack unwind/rewind
3. **Asyncify transform** — in-memory WASM instrumentation via binaryen JS API (browser-compatible, no CLI needed)

## Install

```shell
npm install @mithic/wasm-transpile
```

## Usage

### CLI

The `wasm-transpile` command transpiles a WASM component into JS + core WASM modules:

```shell
# Basic transpile (sync mode, default)
wasm-transpile component.wasm -o ./dist

# All three variants (sync + jspi + asyncify) in one deduplicated output
wasm-transpile component.wasm -o ./dist --variants sync,jspi,asyncify --asyncify-pages 4

# JSPI only
wasm-transpile component.wasm -o ./dist --variants jspi

# Asyncify only with larger stack (4 pages = 256KB)
wasm-transpile component.wasm -o ./dist --variants asyncify --asyncify-pages 4
```

Options:

| Flag | Description |
|------|-------------|
| `-o, --out-dir <dir>` | Output directory (default: `./dist`) |
| `-n, --name <name>` | Module name (default: derived from filename) |
| `--variants <list>` | Comma-separated variants: `sync`, `jspi`, `asyncify` (default: `sync`) |
| `--asyncify-pages <n>` | Secondary memory pages for asyncify stack (default: 1 = 64KB) |
| `--async-imports <list>` | Additional async imports (comma-separated, appended to ASYNC_WASI_IMPORTS defaults) |
| `--async-exports <list>` | Additional async exports (comma-separated, appended to ASYNC_WASI_EXPORTS defaults) |
| `--no-minify` | Disable JS minification |
| `-q, --quiet` | Suppress progress output |

Async import/export format: `namespace:package/interface#function-name` (e.g. `myapp:storage/kv#get`)

### Programmatic: Transpile a WASM Component

```typescript
import { transpileComponent, ASYNC_WASI_IMPORTS, ASYNC_WASI_EXPORTS } from '@mithic/wasm-transpile';
import { readFile } from 'node:fs/promises';

const component = new Uint8Array(await readFile('my-component.wasm'));

// Transpile with asyncify (JSPI codegen + asyncify instrumentation in one step)
const result = await transpileComponent(component, {
  name: 'component',
  asyncMode: 'asyncify',
  asyncImports: ASYNC_WASI_IMPORTS,
  asyncExports: ASYNC_WASI_EXPORTS,
  asyncifyPages: 4,
});

// result.files: Map<string, Uint8Array> — JS glue + asyncified core WASM modules
```

### Programmatic: Transpile to Files

```typescript
import { transpileToFiles, ASYNC_WASI_IMPORTS, ASYNC_WASI_EXPORTS } from '@mithic/wasm-transpile';

await transpileToFiles(component, {
  name: 'component',
  outputDir: './dist',
  variants: ['sync', 'jspi', 'asyncify'],
  asyncImports: ASYNC_WASI_IMPORTS,
  asyncExports: ASYNC_WASI_EXPORTS,
  asyncifyPages: 4,
});
// Writes: component.js, component.async.js, core/*.wasm, core-asyncify/*.wasm, index.js, jspi.js, asyncify.js + .d.ts
```

### Run with Asyncify Polyfill

```typescript
import { installPolyfill, createInstantiateCore } from '@mithic/wasm-transpile';
import { WASIShim } from '@mithic/wasip2';

// Install polyfill (no-op if native JSPI is available, unless overrideNative: true)
installPolyfill({ overrideNative: true });

const shim = new WASIShim({ sandbox: { /* async-capable handlers */ } });

const { instantiate } = await import('./dist/component.js');
const { run } = await instantiate(
  async (path) => WebAssembly.compile(await readFile(path)),
  shim.getImportObject(),
  createInstantiateCore({ asyncify: true }),
);

await run.run();  // Async via asyncify — no Workers, no Atomics, no native JSPI
```

### Asyncify Transform (standalone)

```typescript
import { asyncifyTransform } from '@mithic/wasm-transpile';

// Instrument a single core WASM module with asyncify
const asyncified = asyncifyTransform(coreWasmBytes, {
  asyncImports: ['wasi:io/poll@0.2.0.[method]pollable.block'],  // versioned format
  secondaryMemoryPages: 4,
});
```

## How It Works

### The Problem

WASI components need blocking I/O (stdin read, file read, network). In browsers/Node.js, these require async operations. Three approaches exist:

| Approach | Requirement | Availability |
|----------|-------------|--------------|
| Workers + Atomics.wait | SharedArrayBuffer + COOP/COEP headers | Broad, but restrictive |
| Native JSPI | WebAssembly.Suspending/promising | Chrome 129+, Node 22+ |
| **Asyncify** | Multi-memory support | **Everywhere** |

### Asyncify Stack Unwind/Rewind

Binaryen's asyncify pass instruments WASM to save/restore its call stack:

1. WASM calls a blocking import → import returns a Promise
2. Asyncify detects the Promise → saves the entire call stack to secondary memory → unwinds
3. JS awaits the Promise → gets the result
4. Asyncify rewrites the stack from secondary memory → WASM resumes where it left off

### JCO Multi-Module Architecture

JCO generates multiple core WASM modules linked via a shared table. The asyncify polyfill handles this by:

- Capturing raw JS trampoline functions from the linker module's imports (before they enter the typed WASM table which erases Promise returns)
- Calling them directly from JS at runtime, bypassing WASM table indirection
- This makes Promises visible to the asyncify state machine

### Async Import Matching

`ASYNC_WASI_IMPORTS` is a comprehensive list covering `wasi:io` (poll, blocking streams), `wasi:filesystem` (all descriptor methods), `wasi:http` (outgoing handler), `wasi:sockets` (TCP/UDP/DNS), and `mithic:process` (process wait). It uses unversioned format (`wasi:io/poll#[method]pollable.block`). At runtime, `matchesAsyncImport()` strips version numbers from actual WASM imports (`wasi:io/poll@0.2.0`) to match against the spec list. `resolveVersionedImports()` produces the versioned `module.name` format that binaryen expects.

## Limitations

### No Reentrance

The asyncify state machine uses a single unwind/rewind slot per module. Nested async calls (an import that triggers another WASM export which triggers another async import) would corrupt the state. This is safe for WASI P2's sequential blocking I/O pattern but would break with concurrent subtasks.

### Single Async Operation In-Flight

Only one Promise can be in-flight at a time per module instance. The WASM stack fully unwinds before JS awaits, then fully rewinds before the next import can fire. This matches how WASI blocking calls work (they're sequential from WASM's perspective) but wouldn't support parallel async operations within a single WASM instance.

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/wasm-transpile` | All exports (transpile + asyncify) |
| `@mithic/wasm-transpile/asyncify` | Asyncify-only exports |
| `@mithic/wasm-transpile/transpile` | JCO transpile wrapper only |

## Scripts

```shell
npm run build       # Vite library build
npm run typecheck   # TypeScript type checking
npm test            # Run tests
```
