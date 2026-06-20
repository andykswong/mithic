# @mithic/coreutils

A pure-TypeScript reimplementation of the BusyBox-style Unix coreutils, where
each command is a regular sandboxed Mithic guest process. There is no native
binary and no WebAssembly: every command is a small TypeScript module that reads
its argv/env/cwd, streams over stdio, reaches kernel services through `fs/*`
syscalls, and returns an exit code — running identically in the browser and on
Node.

> These replace the earlier Rust→WASM coreutils. That WASM/WASI implementation
> is paused and preserved on the `wasm` branch (and `origin/main`); it is not part
> of this branch.

## Commands

54 commands, one module per command under `src/commands/`:

```
awk, base32, base64, basename, cat, chmod, cksum, comm, cp, cut, date,
diff, dirname, echo, egrep, env, expr, false, fgrep, find, fold, grep,
head, ln, ls, mkdir, mktemp, mv, nl, paste, printf, pwd, readlink,
realpath, rev, rm, rmdir, sed, seq, shuf, sleep, sort, stat, sum, tac,
tail, tee, touch, tr, true, uniq, wc, xargs, yes
```

The authoritative list is the `COMMAND_NAMES` array in `src/resolver.ts`; each
name has a matching `src/commands/<name>.ts`. (`grep` family: `grep`, `egrep`,
`fgrep`; `awk` carries its own sub-engine in `src/commands/awk/` — lexer →
parser → interp.) `jq` and `curl` live in their own packages (`@mithic/jq`,
`@mithic/curl`), not here.

## Command-module convention

A command is, at its core, a `CommandFn`: a function over a `CommandIO`
(parsed argv + `env` + `cwd` + stdin/stdout/stderr streams + a `syscall` hook)
that returns an exit code. `defineCommand(fn)` wraps that into the guest module
the kernel launches, so each file is just its own logic plus one default export:

```ts
import { defineCommand, parseArgs, readAll, writeBytes } from '../harness.ts';
import type { CommandFn } from '../harness.ts';

const myCommand: CommandFn = async (io) => {
  const { positionals, flags } = parseArgs(io.args.slice(1), { boolean: ['n'] });
  // io.args[0] is the command name; operands/flags follow.
  const out = io.stdout.getWriter();
  await writeBytes(out, await readAll(io.stdin));
  await out.close().catch(() => {});
  return 0;
};

export default defineCommand(myCommand);
export { myCommand }; // exported so the logic is unit-testable without a kernel
```

`defineCommand` builds a `Guest` from the boot payload via `createGuest`
(from `@mithic/guest-runtime`), binds the command's `CommandIO` to the guest's
wired stdio and syscall channel, runs the `CommandFn`, then closes stdout/stderr
and calls `guest.exit(code)`. A thrown error is reported on stderr and becomes
exit code `1`, mirroring a crashing coreutil.

The harness (`src/harness.ts`, re-exported from the package root and from
`@mithic/coreutils/harness`) provides the reusable helpers every command needs:

- `parseArgs(args, opts)` — a POSIX/getopt-style parser: short clustering
  (`-abc`), short value flags (`-o val` / `-oval`), long flags
  (`--flag` / `--flag=val` / `--flag val`), a `--` terminator, counted flags
  (`-vvv` → 3), aliases, and a lone `-` kept as a positional (stdin convention).
- stdin readers — `readAll`, `readAllText`, `readLines`.
- stdout/stderr writers — `writeBytes`, `writeString`, `writeLine`.
- `exitWith(errWriter, code, msg?)` — the error-and-exit-code idiom.

## Resolution and spawning

The kernel owns the command namespace. Commands are not bundled into one
module: the repo's Vite `preserveModules` build emits each `src/commands/<name>.ts`
1:1 to its own `dist/commands/<name>.js`. `createCoreutilsResolver()` returns a
`resolveCommand(name, cwd, env)` that maps a known name to the `file://` URL of
that built module, or `undefined` for an unknown name (so the kernel yields
ENOENT). Wire it into the kernel:

```ts
import { Kernel } from '@mithic/kernel';
import { createCoreutilsResolver } from '@mithic/coreutils';

const kernel = new Kernel({ runtime, vfs, resolveCommand: createCoreutilsResolver() });
```

When a guest (typically `@mithic/shell`) spawns a bare name via `process/spawn`
or `process/pipeline`, the kernel calls `resolveCommand`, then its launcher
imports the resolved module URL with normal ESM resolution and runs it as a
sandboxed guest — exactly how the shell's own `dist/process.js` is launched.
`createCoreutilsResolver` accepts `{ only }` to expose a subset of
`COMMAND_NAMES`, and `{ baseUrl }` for unusual hosting layouts.

## Build & test

```shell
npm run build       # vite build (preserveModules) → dist/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

Run from the monorepo root to capture cross-package effects; build before test,
since suites import from `dist/`.
