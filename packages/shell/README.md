# @mithic/shell

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/shell?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/shell)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> mithic shell - Rust WASM WASIP2 shell component

## Overview

`@mithic/shell` is a Rust WASM shell component implementing a bash-like interpreter as a WASI Preview 2 component. Runs in the browser and on native systems via the mithic runtime.

### Features

- **Streaming I/O** — Uses WASI `blocking-read`/`blocking-write-and-flush` backed by `SharedArrayBuffer` + `Atomics.wait` for true blocking semantics in a Web Worker
- **Pipelines** — `cmd1 | cmd2 | cmd3` via `mithic:process/manager` pipe creation
- **Redirections** — `>`, `>>`, `<`, `2>`, `2>&1`, `&>`, `<<<`
- **Control flow** — `if/elif/else/fi`, `while/until/do/done`, `for/in/do/done`, `case/esac`
- **Functions** — `name() { body; }` with positional parameters, `return`
- **Arrays** — `arr=(a b c)`, `${arr[0]}`, `${arr[@]}`, `${#arr[@]}`, negative indices, sparse arrays
- **Arithmetic** — `$((expr))` and `(( expr ))` with full C-like operator set
- **Parameter expansion** — `${VAR:-default}`, `${VAR:+alt}`, `${VAR#pat}`, `${VAR%pat}`, `${VAR//pat/rep}`, `${VAR:offset:length}`
- **Brace expansion** — `{a,b,c}`, `{1..10..2}`, `{a..z}`, nesting
- **Process substitution** — `<(cmd)`
- **Glob expansion** — `*`, `?`, `[...]`
- **Builtins** — `cd`, `echo`, `export`, `unset`, `read`, `test`/`[`/`[[`, `declare`/`local`, `source`, `true`, `false`

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

## Build

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
src/
├── main.rs           Entry point (wit-bindgen, Shell::run)
├── shell.rs          REPL loop, command dispatch, expansion, builtins
├── parser/
│   ├── lexer.rs      Tokenizer (words, operators, quotes, substitutions)
│   ├── ast.rs        AST node types (Command, Word, Redirect, etc.)
│   └── parser.rs     Recursive descent parser
├── arith.rs          Arithmetic expression evaluator
├── brace.rs          Brace expansion ({a,b}, {1..10})
├── value.rs          ShellValue enum (Scalar | Array)
└── io.rs             Buffered line reader, write helpers

ts/
├── index.ts          Package exports
├── shell.ts          MithicShell instantiation class
└── cli.ts            Node.js CLI runner (for testing)
```

The shell compiles to a WASI Preview 2 component (`wasm32-wasip2`), transpiled to JavaScript via `jco`. The TypeScript host-side (`MithicShell`) configures WASI imports and process management, then instantiates and runs the component.

### Shell Implementation

- **Lexer** (`src/parser/lexer.rs`) — Tokenizes input into words, operators, quotes, substitutions
- **Parser** (`src/parser/parser.rs`) — Recursive descent producing AST (`src/parser/ast.rs`)
- **Shell** (`src/shell.rs`) — REPL loop, word expansion, command dispatch, builtins
- **Arithmetic** (`src/arith.rs`) — Expression evaluator for `$((expr))`
- **Brace** (`src/brace.rs`) — Brace expansion `{a,b}`, `{1..10}`
- **Value** (`src/value.rs`) — `ShellValue` enum (Scalar | Array)

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
