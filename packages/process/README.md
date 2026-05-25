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
