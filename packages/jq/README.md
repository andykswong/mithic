# @mithic/jq

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/jq?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/jq)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

> jq-compatible JSON processor as a WASI Preview 2 component

## Overview

`@mithic/jq` is a from-scratch Rust implementation of the [jq](https://jqlang.github.io/jq/) JSON processor, compiled to a WASI P2 component. It runs identically in the browser and on native platforms via the mithic runtime.

## Features

- **Full jq language**: identity, field access, array/object iteration, pipes, comma, recursive descent
- **Operators**: arithmetic, comparison, boolean, string concatenation, alternative (`//`)
- **String interpolation**: `"hello \(.name)"`
- **Control flow**: if-then-else, try-catch, reduce, foreach, label-break
- **Definitions**: `def name(args): body;`
- **Variables**: `. as $x | ...`, destructuring patterns
- **Builtins**: 80+ built-in functions (select, map, sort_by, group_by, unique, flatten, keys, values, has, del, to_entries, with_entries, split, join, test, match, gsub, etc.)
- **Format strings**: `@base64`, `@base64d`, `@html`, `@uri`, `@csv`, `@tsv`, `@json`
- **Path operations**: `path(expr)`, `getpath`, `setpath`, `delpaths`
- **CLI flags**: `-r`, `-c`, `-n`, `-s`, `-S`, `-e`, `--tab`, `--indent`, `--arg`, `--argjson`, `--slurp`

## Architecture

Split into focused modules:

| Module | Responsibility |
|--------|---------------|
| `main.rs` | CLI arg parsing, I/O orchestration |
| `json.rs` | `JValue` type, JSON parser, pretty-printer |
| `filter.rs` | Filter AST, tokenizer, recursive-descent parser |
| `eval.rs` | Evaluator, environment/scoping, special forms |
| `builtins.rs` | All built-in function implementations |

Single `wasm32-wasip2` binary. Uses `VecDeque` for BFS in recursive descent (O(1) dequeue). Object equality uses sorted-key comparison.

## Build & Test

```bash
npm run build        # cargo build + wasm-tools strip + jco transpile + vite
npm run typecheck    # tsc --noEmit
npm test             # cargo test + node --test (66 integration tests via WASIShim)
```

## Usage

### Through mithic shell

```bash
echo '{"name":"mithic"}' | jq '.name'
# "mithic"

echo '[1,2,3,4,5]' | jq '[.[] | select(. > 3)]'
# [4,5]

echo '{"a":1,"b":2}' | jq 'to_entries | map(.key)'
# ["a","b"]
```

### Programmatic (WASM component)

```typescript
import { instantiate } from '@mithic/jq/component';

// Instantiate with WASI imports (stdin/stdout/stderr/filesystem/etc.)
const instance = await instantiate(wasiImports);
```

## Testing

Integration tests instantiate the WASM component directly via `@mithic/wasip2` WASIShim — no shell dependency. Tests cover JSON parsing, all filter operations, builtins, CLI flags, and edge cases.
