# @mithic/coreutils

[![mithic](https://img.shields.io/badge/project-mithic-blueviolet.svg?style=flat-square&logo=github)](https://github.com/andykswong/mithic)
[![npm](https://img.shields.io/npm/v/@mithic/coreutils?style=flat-square&logo=npm)](https://www.npmjs.com/package/@mithic/coreutils)
[![license: MIT](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](./LICENSE)

BusyBox-style Unix coreutils as a single WASI Preview 2 component.

## Commands

cat, cp, mv, rm, mkdir, rmdir, ls, head, tail, wc, sort, uniq, cut, tr, tee, sleep, basename, dirname, touch, ln, seq, grep, sed, find, xargs, date, diff, chmod, readlink, yes, rev, paste

### Notable Features

- **grep** — Full regex engine (`.`, `*`, `+`, `?`, `[abc]`, `[^abc]`, `^`, `$`, `\d`, `\w`, `\s`, `|` alternation), `-ivncl` flags, multiple `-e` patterns
- **sed** — Regex substitution with `&` backreference, `-n`/`p` suppress/print, line/range/pattern addressing, `d` delete command
- **sort** — `-k START[,END]` key field, `-t` delimiter, `-n` numeric, `-r` reverse, `-u` unique
- **find** — `-name` glob, `-type f/d`, `-exec cmd {} \;`
- **diff** — LCS-based algorithm, normal and `-u` unified format
- **sleep** — Real blocking via `std::thread::sleep` (maps to WASI `subscribe-duration` + `Atomics.wait`)

## Architecture

Single `wasm32-wasip2` binary. Command is determined by `argv[0]` (BusyBox pattern). Uses `std::fs`/`std::io` throughout (maps to WASI automatically). A shared regex engine (`src/commands/regex.rs`) is used by both `grep` and `sed`.

## Build & Test

```bash
npm run build        # cargo build + wasm-tools strip + jco transpile + vite
npm run typecheck    # tsc --noEmit
npm test             # cargo test
```

## Usage from Shell

Commands are registered via `ProcessManager`. The resolver maps command names to synchronous handlers that instantiate the coreutils WASM component with the appropriate `argv[0]`.

`@mithic/shell` package contains extensive integration tests for all commands.

## Adding a New Command

1. Create `src/commands/yourcommand.rs` with `pub fn run(args: &[&str]) -> u8`
2. Add `mod yourcommand;` and a match arm in `src/commands/mod.rs`
3. Add the command name to `COREUTILS_COMMANDS` in `packages/shell/ts/commands.ts` (`@mithic/shell` package)
