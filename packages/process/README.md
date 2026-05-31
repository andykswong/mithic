# @mithic/process

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/process?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/process)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> Process manager for mithic — spawn WASM processes with piped I/O

## Overview

`@mithic/process` provides process lifecycle management for the mithic runtime. It implements the `mithic:process` WIT interface with **stream inversion** — callers pre-wire pipe handles at spawn time.

## Install

```shell
npm install @mithic/process
```

## Usage

### Fire-and-forget (inherit host stdio)

```typescript
// No streams provided — child writes directly to host terminal
const proc = manager.spawn('echo.wasm', ['hello']);
await proc.wait();
```

### Spawn with Pipes

```typescript
import { ProcessManager, createPipe } from '@mithic/process';

const manager = new ProcessManager(/* ... */);

// Create a pipe and wire it to the child's stdout
const { input, output } = manager.createPipe();
const proc = manager.spawn('cat.wasm', ['file.txt'], { stdout: output });

// Read child output from the pipe
const data = await input.blockingRead(4096);
const exitCode = await proc.wait();
```

### Convenience Helper

```typescript
import { spawnWithPipes } from '@mithic/process/utils';

const { process, stdin, stdout, stderr } = spawnWithPipes(manager, 'program.wasm', []);
```

## Key Concepts

### Stream Inversion

Traditional process APIs expose `process.stdout` after `spawn`. Mithic inverts this: the caller creates pipes first and passes them into `spawn`. This enables direct process-to-process piping.

### Pipe Primitive

`createPipe()` returns a linked `(InputStream, OutputStream)` pair with backpressure semantics:

- **Buffer full** → `write()` returns 0; `blockingWrite()` blocks until space available
- **Buffer empty** → `read()` returns empty; `blockingRead()` blocks until data arrives
- **Writer disposed** → reader gets EOF (`{tag: 'closed'}`)
- **Reader disposed** → writer gets `broken-pipe` error

Two backing implementations:
- `QueuePipe` — `Uint8Array[]` queue (same-thread, default)
- `SharedPipe` — `SharedArrayBuffer` ring buffer with `Atomics` (cross-thread)

### WIT Specification

The authoritative interface is defined in [`wit/process.wit`](./wit/process.wit):

```wit
package mithic:process@0.2.0;

interface manager {
  spawn: func(file: string, args: list<string>, options: option<spawn-options>) -> result<process, error-code>;
  create-pipe: func() -> tuple<input-stream, output-stream>;
}
```

## Dynamic WASM Component Execution

The `ComponentRegistry` + `CompilerBridge` enable executing arbitrary WASM components at runtime via jco transpilation.

### Optional Dependency: `@bytecodealliance/jco`

Dynamic WASM execution requires `@bytecodealliance/jco` as an optional peer dependency. Without it, only pre-compiled components (shell, coreutils) can be executed.

```shell
npm install @bytecodealliance/jco@1
```

**Version coupling:** The `ComponentRegistry` evaluates jco's transpiled JavaScript output at runtime using `new Function()`. This is coupled to jco's specific output format — currently a single `export function instantiate(...)` with no ES module imports, referencing only `import.meta.url` (which is mocked). If jco changes its output format in future versions, dynamic execution may break. Pin to a tested jco version.

### Usage

```typescript
import { createDefaultWorkerFactory } from '@mithic/process/impl/worker-factory';
import { createCompilerBridge } from '@mithic/process/impl/compiler-bridge';
import { ComponentRegistry } from '@mithic/process/impl/component-registry';

const factory = createDefaultWorkerFactory();
const compiler = createCompilerBridge(factory);
const registry = new ComponentRegistry({ precompiled: new Map(), compiler });

// Resolve WASM bytes to a runnable component
const resolved = registry.resolveBytes(wasmBytes, '/path/to/component');
if (resolved) {
  const { run } = resolved.instantiate(resolved.compileCore, wasiImports, syncInstantiateCore);
  run.run();
}

// Cleanup (terminates compiler Worker)
registry[Symbol.dispose]();
```

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/process` | Main index (ProcessManager, types, pipe) |
| `@mithic/process/manager` | ProcessManager implementation |
| `@mithic/process/types` | Process, SpawnOptions, ErrorCode types |
| `@mithic/process/imports` | WASI import map for process interface |
| `@mithic/process/instantiation` | WASIProcess integration |
| `@mithic/process/shell` | Shell interface contract |
| `@mithic/process/utils` | Utility functions |
| `@mithic/process/impl/simple` | Simple in-process implementation |
| `@mithic/process/impl/component-registry` | ComponentRegistry for dynamic WASM |
| `@mithic/process/impl/compiler-bridge` | Sync-bridge client for compiler Worker |
| `@mithic/process/impl/worker-factory` | Isomorphic Worker creation |
