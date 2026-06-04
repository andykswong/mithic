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
import { WorkerProcessManager } from '@mithic/process/manager/worker';

const manager = new WorkerProcessManager({ createWorker, maxWorkers: 4, /* ... */ });

// Create a pipe and wire it to the child's stdout
const { input, output } = manager.createPipe();
const proc = manager.spawn('cat.wasm', ['cat', 'file.txt'], { stdout: output });

// Read child output from the pipe
const data = input.blockingRead(4096);
const exitCode = proc.wait();
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

## ProcessWorker Interface

The `ProcessWorker` interface abstracts how a process is executed. Implementations control Worker lifecycle:

```typescript
export interface ProcessWorker {
  run(options: RunOptions, transfer: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'error' | 'close', handler: () => void): void;
}
```

### Implementations

| Class | Entry Point | Description |
|-------|-------------|-------------|
| `ComponentProcessWorker` | `@mithic/process/manager/component-worker` | Spawns a Web Worker that runs a dynamically compiled WASM component |
| `InlineProcessWorker` | `@mithic/process/manager/inline-worker` | Runs a handler inline (same thread) — for sync builtins and tests |

The `WorkerProcessManager` accepts a `createWorker` factory function that returns a `ProcessWorker` for each spawn call, enabling the host to control which implementation is used per command.

## Dynamic WASM Component Execution

The `CommandRegistry` + `CompilerBridge` enable executing arbitrary WASM components at runtime via jco transpilation.

### Optional Dependency: `@bytecodealliance/jco`

Dynamic WASM execution requires `@bytecodealliance/jco` as an optional peer dependency. Without it, only pre-compiled components (shell, coreutils) can be executed.

```shell
npm install @bytecodealliance/jco@1
```

**Version coupling:** The `CommandRegistry` evaluates jco's transpiled JavaScript output at runtime using `new Function()`. This is coupled to jco's specific output format — currently a single `export function instantiate(...)` with no ES module imports, referencing only `import.meta.url` (which is mocked). If jco changes its output format in future versions, dynamic execution may break. Pin to a tested jco version.

### Usage

```typescript
import { CommandRegistry } from '@mithic/process/component/registry';
import { createComponentCompiler } from '@mithic/process/component/compiler';

const compiler = createComponentCompiler(compilerPort);
const registry = new CommandRegistry({ compiler });

// Resolve WASM bytes to a CompileResult
const result = registry.resolveBytes(wasmBytes, '/path/to/component');
if (result) {
  // Pass result to ComponentProcessWorker for execution in a process Worker
  const worker = new Worker(processWorkerUrl, { type: 'module' });
  const processWorker = new ComponentProcessWorker(worker, result);
}

// Cleanup
registry[Symbol.dispose]();
```

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/process` | Main index (WASIProcess, imports) |
| `@mithic/process/manager` | Global ProcessManager getter/setter, spawn, createPipe |
| `@mithic/process/types` | Process, SpawnOptions, ErrorCode, ProcessWorker, RunOptions types |
| `@mithic/process/imports` | WASI import map for process interface |
| `@mithic/process/instantiation` | WASIProcess integration |
| `@mithic/process/io` | Pipe primitives (QueuePipe, SharedPipe) |
| `@mithic/process/io/slots` | Exit slot utilities |
| `@mithic/process/io/signal-stream` | Signal-aware stream wrappers |
| `@mithic/process/manager/simple` | SimpleProcessManager (single-thread) |
| `@mithic/process/manager/worker` | WorkerProcessManager (Worker-per-process) |
| `@mithic/process/manager/component-worker` | ComponentProcessWorker implementation |
| `@mithic/process/manager/inline-worker` | InlineProcessWorker implementation |
| `@mithic/process/manager/proxy` | Proxy manager for cross-thread |
| `@mithic/process/component/registry` | CommandRegistry for dynamic WASM |
| `@mithic/process/component/compiler` | CompilerBridge client |
| `@mithic/process/worker/compiler` | Compiler Worker entry point |
| `@mithic/process/worker/process` | Process Worker entry point |
