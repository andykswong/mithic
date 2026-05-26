# @mithic/just-bash

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/just-bash?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/just-bash)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> just-bash shell integration for mithic

## Overview

`@mithic/just-bash` wires the [just-bash](https://github.com/vercel-labs/just-bash) shell interpreter into the mithic runtime. It provides:

- **VirtualFileSystem** — adapts mithic's `FileSystemRouter` to just-bash's `IFileSystem` interface
- **JustBashShell** — full shell implementation using ProcessManager for child process execution
- **Command Registry** — built-in commands (`cd`, `echo`, `cat`, etc.) backed by VFS operations

## Install

```shell
npm install @mithic/just-bash
```

## Usage

```typescript
import { JustBashShell } from '@mithic/just-bash/shell';
import { VirtualFileSystem } from '@mithic/just-bash/adapter';
import { FileSystemRouter, MemoryProvider } from '@mithic/io/vfs';
import { ProcessManager } from '@mithic/process';

const router = new FileSystemRouter();
router.mount('/', new MemoryProvider());

const shell = new JustBashShell({
  processManager: new ProcessManager(/* ... */),
  vfsRouter: router,
  cwd: '/home/user',
  env: { PATH: '/bin:/usr/bin', HOME: '/home/user' },
});

const result = await shell.exec('echo hello world');
// result.stdout contains "hello world\n"
```

### Command Resolution

When a command is typed:

1. Check registered built-in handlers
2. Search `PATH` directories in VFS for matching `.wasm` file
3. If found, spawn as a WASM child process via ProcessManager
4. If not found, return "command not found" error

### Pipeline Execution

Pipelines use `createPipe()` from ProcessManager to wire stdout of one process to stdin of the next:

```bash
echo hello | cat | wc -c
```

Each `|` creates a pipe pair — no data passes through JavaScript.

## Exports

| Entry Point | Contents |
|-------------|----------|
| `@mithic/just-bash` | Main index (re-exports all) |
| `@mithic/just-bash/adapter` | VirtualFileSystem (IFileSystem over FileSystemRouter) |
| `@mithic/just-bash/shell` | JustBashShell implementation |
| `@mithic/just-bash/commands` | Built-in command registry |

## VirtualFileSystem

Bridges the gap between mithic's `FileSystemProvider` (async, capability-based) and just-bash's `IFileSystem` (async, path-based with Unix semantics):

- Full permission support (`chmod`, `0o755` style)
- Symlink resolution
- Recursive operations (`mkdir -p`, `rm -rf`, `cp -r`)
- Timestamps (`mtime`, `atime`)
- Execute bit check for command resolution
