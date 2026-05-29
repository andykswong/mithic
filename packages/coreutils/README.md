# @mithic/coreutils

BusyBox-style Unix coreutils as a single WASI Preview 2 component.

## Commands (32)

cat, cp, mv, rm, mkdir, rmdir, ls, head, tail, wc, sort, uniq, cut, tr, tee, sleep, basename, dirname, touch, ln, seq, grep, sed, find, xargs, date, diff, chmod, readlink, yes, rev, paste

## Architecture

Single `wasm32-wasip2` binary. Command is determined by `argv[0]` (BusyBox pattern). The host registers each command name to instantiate this component with the appropriate `argv[0]`.

## Build

```bash
npm run build          # cargo build + wasm-tools strip + jco transpile + vite
```

## Usage from Shell

Commands are registered via the host's `commandResolver` in the shell CLI. They appear as external commands (not shell builtins) and are resolved by name through the process manager's spawn interface.

## Adding a New Command

1. Create `src/commands/yourcommand.rs` with `pub fn run(args: &[&str]) -> u8`
2. Add `mod yourcommand;` and a match arm in `src/commands/mod.rs`
3. Add the command name to `COREUTILS_COMMANDS` in `packages/shell/ts/cli.ts`
