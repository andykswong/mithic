# @mithic/shell

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/shell?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/shell)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> mithic shell - Rust WASM WASIP2 shell component

## Overview

`@mithic/shell` is a Rust WASM shell component implementing a bash-like interpreter as a WASI Preview 2 component. Runs in the browser and on native systems via the mithic runtime.

### Features

- **Bash compatible** - Implements full bash syntax and semantics, including:
  - **Redirections** — `>`, `>>`, `<`, `<<`, `<<-`, `<<<`, `2>`, `2>&1`, `&>`, `N>`, `N>>`, `N>&M`, `N>&-`
  - **Control flow** — `if/elif/else/fi`, `while/until/do/done`, `for/in/do/done`, `case/esac`, `select`
  - **Functions** — `name() { body; }` with positional parameters, `return`
  - **Arrays** — `arr=(a b c)`, `${arr[0]}`, `${arr[@]}`, `${#arr[@]}`, negative indices, sparse arrays
  - **Arithmetic** — `$((expr))` and `(( expr ))` with full C-like operator set
  - **Parameter expansion** — `${VAR:-default}`, `${VAR:+alt}`, `${VAR#pat}`, `${VAR%pat}`, `${VAR//pat/rep}`, `${VAR:offset:length}`
  - **Brace expansion** — `{a,b,c}`, `{1..10..2}`, `{a..z}`, nesting
  - **Process substitution** — `<(cmd)`
  - **Glob expansion** — `*`, `?`, `[...]`, extglob (`?(pat)`, `*(pat)`, `+(pat)`, `@(pat)`, `!(pat)`), globstar (`**`)
  - **Builtins** — `cd`, `echo`, `export`, `unset`, `read`, `test`/`[`/`[[`, `declare`/`local`, `source`, `shopt`, `true`, `false`
  - **Error handling** — Arithmetic expansion errors abort the containing command; proper exit codes propagate through pipes, assignments, for/case/select
- **Command resolution** — `ProcessManager`-based dispatching to shell, shell builtins, coreutils WASM, host-side commands, PATH-based WASM components and scripts
- **POSIX mode** — Auto-activates when invoked as `sh`; disables non-standard extensions, including `[[`, `(( ))`, `<<<`, arrays, brace expansion
- **Pipelines** — `cmd1 | cmd2 | cmd3` and `cmd1 |& cmd2` (pipe stderr+stdout). In Worker mode, each pipeline stage runs in its own Worker for true parallel execution. In async mode, stages run cooperatively via JSPI/asyncify suspension. Infinite producers terminate correctly via broken-pipe propagation in both modes (`cat /dev/zero | head -c 4` works).
- **Background jobs** — `cmd &` runs concurrently in a separate Worker
- **Dynamic WASM execution** — Arbitrary `.wasm` components on the filesystem are transpiled and executed at runtime
- **Script execution** — Shebang (`#!/bin/sh`) support, PATH lookup with executable permission checks
- **Streaming I/O** — Uses WASI `blocking-read`/`blocking-write-and-flush`. In worker mode, backed by `SharedArrayBuffer` + `Atomics.wait` for true blocking semantics. In async mode, backed by JSPI/asyncify for suspendable async I/O without Workers.

## Usage

The `Runtime` accepts a `ProcessManager` via the `manager` field. Two modes are available:

### Worker Mode (Workers + SharedArrayBuffer)

```typescript
import { Runtime, createWorkerStrategy } from '@mithic/shell';
import { ComponentProcessWorker } from '@mithic/process/manager/component-worker';

// createWorkerStrategy() returns a ProcessManager & Disposable (IoLoop + WorkerProcessManager)
const manager = createWorkerStrategy({
  fs: vfsProvider,
  stdio: { stdin: stdinHandler, stdout: stdoutHandler, stderr: stderrHandler },
  isatty: { stdin: true, stdout: true, stderr: true },
  createWorker: (file, name) => {
    const worker = new Worker(processWorkerUrl, { type: 'module', name });
    return new ComponentProcessWorker(worker, compileResult);
  },
});

const runtime = new Runtime({
  manager,
  env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color' },
  cwd: '/',
});

const proc = runtime.exec('bash', { args: ['bash', '-c', 'echo hello'] });
const exitCode = await runtime.waitAsync(proc);
runtime[Symbol.dispose]();
```

### Async Mode (JSPI/asyncify, no Workers/SAB needed)

```typescript
import { Runtime } from '@mithic/shell';
import { SimpleProcessManager } from '@mithic/process/manager/simple';

// SimpleProcessManager runs commands in-process using JSPI or asyncify polyfill
const manager = new SimpleProcessManager({
  hostStreams: { stdin, stdout, stderr },
  env: { HOME: '/home', PATH: '/bin' },
});
manager.commandResolver = (file) => { /* resolve to CommandHandler */ };

const runtime = new Runtime({ manager, env, cwd: '/' });
const proc = runtime.exec('bash', { args: ['-c', 'echo hello'] });
const exitCode = await runtime.waitAsync(proc);
runtime[Symbol.dispose]();
```

## Build & Test

```shell
npm install
npm run build        # cargo build + jco transpile + vite build
npm run build:rust   # cargo + transpile only
npm run typecheck    # tsc --noEmit
npm test             # cargo test + node --test
```

Requires Rust toolchain with `wasm32-wasip2` target:
```shell
rustup target add wasm32-wasip2
```

## CLI

The `mithic-shell` binary defaults to worker mode (Workers + SharedArrayBuffer). Use `--async` for async mode (JSPI/asyncify, no Workers needed):

```shell
# Worker mode (default)
mithic-shell
mithic-shell -c 'echo hello | tr a-z A-Z'

# Async mode (JSPI/asyncify polyfill, no SharedArrayBuffer required)
mithic-shell --async
mithic-shell --async -c 'ls /tmp'
```

## Architecture

```
src/                   (~10k lines Rust)
├── main.rs            Entry point (argv parsing, POSIX auto-activation)
├── runtime.rs         Io, Filesystem, ProcessMgr traits + Runtime supertrait
├── runtime_wasi.rs    WasiRuntime: real WASM impl (only file importing bindings)
├── runtime_test.rs    TestRuntime: mocks for cargo test
├── shell.rs           Shell<R>, REPL loop, exec_list, dispatch
├── executor/
│   ├── expansion.rs   Free string utils: glob, tilde, normalize, etc.
│   ├── expand.rs      Shell methods: expand_word, expand_var, try_expand_words_to_args
│   ├── compound.rs    exec_compound, exec_if/while/for/case/select, subshell
│   ├── test_eval.rs   eval_test, eval_extended_test, test_file
│   ├── redirect.rs    apply_redirects
│   └── pipeline.rs    exec_pipeline, exec_pipeline_background
├── builtins/
│   ├── mod.rs         dispatch + write_out helper
│   ├── core.rs        echo, pwd, cd, exit, env, true, false, hash
│   ├── vars.rs        export, unset, declare, local, read, set, shopt
│   ├── flow.rs        break, continue, return, source
│   ├── test.rs        [, [[, test
│   └── jobs.rs        jobs, fg, bg, wait, disown, kill, trap
├── parser/
│   ├── lexer.rs       Tokenizer (heredocs, here-strings, (( )), [[ ]])
│   ├── parser.rs      Recursive descent (posix-mode aware)
│   └── ast.rs         AST node types
└── arith.rs, brace.rs, regex.rs, value.rs, options.rs, params.rs, jobs.rs

ts/
├── index.ts              Package exports (Runtime, createWorkerStrategy)
├── runtime.ts            Runtime class: accepts ProcessManager, orchestrates exec/wait
├── worker-strategy.ts    createWorkerStrategy(): IoLoop + WorkerProcessManager factory
├── cli/
│   ├── index.ts          CLI entry point (routes --async flag)
│   ├── worker.ts         Worker mode CLI (default): VFS + command resolution + process Workers
│   ├── async.ts          Async mode CLI (--async flag): JSPI/asyncify, no Workers/SAB
│   └── shared.ts         Shared CLI utilities (VFS setup, env)
└── commands/
    └── chmod.ts          Host-side chmod handler (numeric + symbolic modes)
```

The shell compiles to a WASI Preview 2 component (`wasm32-wasip2`), transpiled to JavaScript via `jco`. The TypeScript host-side `Runtime` accepts a `ProcessManager` and orchestrates command execution. Two execution modes are supported:

- **Worker mode** (`createWorkerStrategy()`): An `IoLoop` services filesystem/stdio requests from Workers via `SharedArrayBuffer` + `Atomics`. Each spawned command (shell, coreutil, or dynamic WASM component) gets its own Web Worker with a `ProxyProcessManager` that delegates spawn requests back to the main thread.
- **Async mode** (`SimpleProcessManager`): Commands run in-process using JSPI or asyncify polyfill for async I/O. No Workers or SharedArrayBuffer required — suitable for environments without cross-origin isolation headers.

### Runtime Abstraction

Shell logic is decoupled from WASM bindings via three ISP-compliant traits composed into a `Runtime` supertrait:

| Trait | Responsibility | WasiRuntime impl | TestRuntime impl |
|-------|---------------|------------------|------------------|
| `Io` | stdout/stderr/stdin | WASI streams (blocking_read/write_and_flush) | Output capture buffers |
| `Filesystem` | File queries + stream handles | std::fs for queries; raw WASI Descriptor for stream-producing opens | In-memory HashMap |
| `ProcessMgr` | Pipes, spawn, wait, signals | Raw `mithic:process` WIT bindings + resource table | Stubs (spawn always fails) |

`crate::bindings::*` is imported only in `runtime_wasi.rs` — all shell logic operates on opaque handles and trait methods.

### Shell Implementation

- **Parser** (`src/parser/`) — Lexer + recursive descent producing AST. POSIX-mode-aware: rejects `[[`, `(( ))`, `<<<` when `posix=true`
- **Shell** (`src/shell.rs`) — REPL loop, exec_list, builtin dispatch (`Shell<R: Runtime>`), history expansion (`!!`, `!N`, `!-N`, `!prefix`)
- **Executor** (`src/executor/`) — Pipelines, redirections, compound commands, expansion. Uses `try_expand_words_to_args` for fallible expansion (aborts command on arithmetic errors)
- **Builtins** (`src/builtins/`) — All shell builtins, organized by category
- **Arithmetic** (`src/arith.rs`) — Expression evaluator for `$((expr))`, returns `Result` (division-by-zero → Err)
- **Brace** (`src/brace.rs`) — Brace expansion `{a,b}`, `{1..10}`
- **Value** (`src/value.rs`) — `ShellValue` enum (Scalar | Array | AssocArray)

### Host-Side Command Resolution

In worker mode, the `createWorkerStrategy()` config accepts a `createWorker(file, name?) → ProcessWorker | undefined` factory function. In async mode, the `SimpleProcessManager` accepts a `commandResolver(file) → CommandHandler | undefined`. The CLI (`ts/cli/worker.ts` and `ts/cli/async.ts`) implements the resolution logic:

1. **`sh`/`bash`** → `ComponentProcessWorker` with shell WASM component (POSIX mode for `sh`)
2. **`chmod`** → `InlineProcessWorker` with host-side VFS access (numeric + symbolic modes)
3. **Coreutils** → `ComponentProcessWorker` with coreutils WASM component
4. **Absolute/relative paths** → Script execution (WASM detection, shebang + permission check)
5. **Bare commands** → PATH lookup at invocation time

Each resolved command returns a `ProcessWorker` — either a `ComponentProcessWorker` (spawns a Web Worker for WASM execution) or an `InlineProcessWorker` (runs synchronously for builtins). Dynamic WASM components are resolved via `CommandRegistry` and executed in process Workers.

## WIT World

`@mithic/shell` is a standard WASI CLI component:

```wit
package mithic:shell@0.1.0;

world shell {
  import wasi:io/streams@0.2.6;
  import wasi:cli/stdin@0.2.6;
  import wasi:cli/stdout@0.2.6;
  import wasi:cli/stderr@0.2.6;
  import wasi:filesystem/types@0.2.6;
  import wasi:filesystem/preopens@0.2.6;
  import mithic:process/types@0.1.0;
  import mithic:process/manager@0.1.0;
  // ... plus clocks, terminal, environment, random, poll, error

  export wasi:cli/run@0.2.6;
}
```

## Known Limitations

### Interactive/Terminal

The shell has no readline library or terminal raw-mode support. This means:
- No arrow key navigation, Ctrl+A/E cursor movement, or Ctrl+R history search
- No tab completion
- No `set -o vi` / `set -o emacs` editing modes
- Input is strictly line-buffered (no character-at-a-time processing)
- Ctrl+C / Ctrl+Z cannot be delivered from the terminal to running processes

### Process Model

- No true process groups or `setpgid` — `kill(-pgid, sig)` not supported
- `coproc` is parsed but returns an error (requires bidirectional pipe wiring)
- Signal handler registration (`trap`) is not delivered to WASM processes — signals terminate the Worker
- `$$` and `$BASHPID` expand to a fixed PID (`1`) since WASM has no real process IDs
- `exec cmd` spawns and waits rather than replacing the shell process

### Missing Builtins

`ulimit`, `umask`, `compgen`/`complete`, `enable`, `suspend`, `caller`

### Glob & Expansion

- No `GLOBIGNORE`

### I/O & Redirection

- Extra FDs (3+) are shell-local only (not passed to child WASM processes via WASI spawn)

### Other

- No `/etc/profile` or `~/.bash_profile` sourcing (no login shell support) — `~/.bashrc` and `$ENV`/`$BASH_ENV` are sourced
- No `GLOBIGNORE` or `BASH_VERSINFO`
- History expansion limited to `!!`, `!N`, `!-N`, `!prefix` (no modifiers like `:p`, `:h`)
- `read -t` (timeout) not supported — needs WASI poll-based timer
- `fc` only supports `-l` (listing) — no re-edit mode
