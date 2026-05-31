# @mithic/shell

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/shell?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/shell)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> mithic shell - Rust WASM WASIP2 shell component

## Overview

`@mithic/shell` is a Rust WASM shell component implementing a bash-like interpreter as a WASI Preview 2 component. Runs in the browser and on native systems via the mithic runtime.

### Features

- **Bash compatible** - Implements full bash syntax and semantics, including:
  - **Redirections** — `>`, `>>`, `<`, `2>`, `2>&1`, `&>`, `<<<`
  - **Control flow** — `if/elif/else/fi`, `while/until/do/done`, `for/in/do/done`, `case/esac`, `select`
  - **Functions** — `name() { body; }` with positional parameters, `return`
  - **Arrays** — `arr=(a b c)`, `${arr[0]}`, `${arr[@]}`, `${#arr[@]}`, negative indices, sparse arrays
  - **Arithmetic** — `$((expr))` and `(( expr ))` with full C-like operator set
  - **Parameter expansion** — `${VAR:-default}`, `${VAR:+alt}`, `${VAR#pat}`, `${VAR%pat}`, `${VAR//pat/rep}`, `${VAR:offset:length}`
  - **Brace expansion** — `{a,b,c}`, `{1..10..2}`, `{a..z}`, nesting
  - **Process substitution** — `<(cmd)`
  - **Glob expansion** — `*`, `?`, `[...]`
  - **Builtins** — `cd`, `echo`, `export`, `unset`, `read`, `test`/`[`/`[[`, `declare`/`local`, `source`, `true`, `false`
  - **Error handling** — Arithmetic expansion errors abort the containing command; proper exit codes propagate through pipes, assignments, for/case/select
- **Command resolution** — `SimpleProcessManager` with `CommandResolver` dispatching to shell, coreutils WASM, host-side commands (chmod), and PATH-based scripts
- **POSIX mode** — Auto-activates when invoked as `sh`; disables non-standard extensions, including `[[`, `(( ))`, `<<<`, arrays, brace expansion
- **Pipelines** — `cmd1 | cmd2 | cmd3` and `cmd1 |& cmd2` (pipe stderr+stdout) via `mithic:process/manager` pipe creation
- **Script execution** — Shebang (`#!/bin/sh`) support, PATH lookup with executable permission checks
- **Streaming I/O** — Uses WASI `blocking-read`/`blocking-write-and-flush` backed by `SharedArrayBuffer` + `Atomics.wait` for true blocking semantics in a Web Worker

## Usage

```typescript
import { MithicShell } from '@mithic/shell';

const shell = new MithicShell({
  wasi: {
    sandbox: {
      stdin: { handler: stdinHandler, isatty: true },
      stdout: { handler: stdoutHandler, isatty: true },
      stderr: { handler: stderrHandler, isatty: true },
      env: { HOME: '/home', PATH: '/bin', USER: 'user', TERM: 'xterm-256color' },
      args: ['msh'],
      preopens: { '/': rootDescriptor },
    },
  },
  process: { manager },
  component: () => import('@mithic/shell/component'),
});

const exitCode = await shell.run();
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
│   ├── vars.rs        export, unset, declare, local, read, set
│   ├── flow.rs        break, continue, return, source
│   ├── test.rs        [, [[, test
│   └── jobs.rs        jobs, fg, bg, wait, disown, kill, trap
├── parser/
│   ├── lexer.rs       Tokenizer (heredocs, here-strings, (( )), [[ ]])
│   ├── parser.rs      Recursive descent (posix-mode aware)
│   └── ast.rs         AST node types
└── arith.rs, brace.rs, regex.rs, value.rs, options.rs, params.rs, jobs.rs

ts/
├── index.ts          Package exports (MithicShell)
├── shell.ts          MithicShell instantiation class
├── cli.ts            Node.js CLI runner (VFS + ProcessManager setup)
└── commands.ts       CommandResolver: sh/bash, coreutils, chmod, PATH, shebang
```

The shell compiles to a WASI Preview 2 component (`wasm32-wasip2`), transpiled to JavaScript via `jco`. The TypeScript host-side (`MithicShell`) configures WASI imports and process management, then instantiates and runs the component.

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

The TypeScript `commands.ts` implements a `CommandResolver` that resolves command names to synchronous handlers:

1. **`sh`/`bash`** → Instantiate child shell WASM component (POSIX mode for `sh`)
2. **`chmod`** → Host-side handler with VFS access (numeric + symbolic modes)
3. **Coreutils** → Instantiate coreutils WASM component with `argv[0]`
4. **Absolute/relative paths** → Script execution (shebang + permission check)
5. **Bare commands** → PATH lookup at invocation time

The resolver is passed to `SimpleProcessManager` which handles sync/async dispatch (sync handlers return `number` directly, enabling synchronous `tryWait()` in WASM context).

## WIT World

`@mithic/shell` is a standard WASI CLI component:

```wit
package mithic:shell@0.1.0;

world shell {
  import wasi:io/streams@0.2.0;
  import wasi:cli/stdin@0.2.0;
  import wasi:cli/stdout@0.2.0;
  import wasi:cli/stderr@0.2.0;
  import wasi:filesystem/types@0.2.0;
  import wasi:filesystem/preopens@0.2.0;
  import mithic:process/types@0.2.0;
  import mithic:process/manager@0.2.0;
  // ... plus clocks, terminal, environment, poll, error

  export wasi:cli/run@0.2.0;
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

All processes run as in-process JavaScript functions on the same thread:
- Background commands (`cmd &`) are dispatched but may execute synchronously depending on the handler
- No true process groups or `setpgid` — `kill(-pgid, sig)` not supported
- `coproc` is parsed but returns an error (requires concurrent bidirectional I/O)
- `$$` and `$BASHPID` expand to a fixed PID (`1`) since WASM has no real process IDs
- `exec cmd` spawns and waits rather than replacing the shell process

### Missing Builtins

`ulimit`, `umask`, `shopt`, `pushd`/`popd`/`dirs`, `compgen`/`complete`, `enable`, `suspend`, `caller`

### Glob & Expansion

- No extended glob (`extglob`): `?(pat)`, `*(pat)`, `+(pat)`, `@(pat)`, `!(pat)` not supported
- No recursive glob (`**`)
- No named POSIX character classes (`[[:digit:]]`)
- `${!var}` variable indirection not supported

### I/O & Redirection

- File descriptors > 2 not fully supported (no general `N>&M` for N > 2)
- No `/dev/tcp` or `/dev/udp` network redirects

### Other

- No startup file sourcing (`~/.bashrc`, `/etc/profile`) — source explicitly
- No `GLOBIGNORE`, `nocaseglob`, or `BASH_VERSINFO`
- History expansion limited to `!!`, `!N`, `!-N`, `!prefix` (no modifiers like `:p`, `:h`)
- `read` builtin supports `-p`, `-r`, `-a` only (no `-t`, `-d`, `-N`, `-u`)
- `fc` only supports `-l` (listing) — no re-edit mode
